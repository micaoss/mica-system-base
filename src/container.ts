// Host entry: runs src/cli.ts in the environment image, via BuildKit for a foreign architecture.
import type { Options } from './args.ts'
import type { Arch, Row } from './lock.ts'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { parse, resolvePath, USAGE } from './args.ts'
import { nonDirectories } from './bootstrap.ts'
import { buildDebs, declared } from './debs/docker.ts'
import { fail, report } from './errors.ts'
import { attached, capture } from './exec.ts'
import { ARCHES, lockRows, parseRows, SELECTIONS, sourceRows, UPSTREAM_LOCK } from './lock.ts'
import { assertBuildEnvRelease, assertEnvironmentImage, BUILD_ENV, buildEnvAsset, environment, REPO } from './pins.ts'
import { buildTime, releaseOf } from './release.ts'
import { BASE_PACKAGES, ISSUE_ENV } from './rootfs.ts'

const COMMANDS = ['cache', 'verify', 'select', 'bootstrap', 'pin-inputs', 'test', 'test-bootstrap']
const IN_CONTAINER = '/mica-system-base'
// What a BuildKit stage needs of this repository.
const REPO_FILES = ['src', 'locks', 'debs', 'environment.json', 'packages.tsv', 'sources.json', 'ids.json']

function hostArch(): Arch {
  if (process.arch === 'x64')
    return 'amd64'
  if (process.arch === 'arm64')
    return 'arm64'
  fail(`unsupported host architecture: ${process.arch}`)
}

// Container-local /work and /root, as the Docker daemon sees them.
function hostPath(path: string): string {
  for (const [inside, outside] of [['/work/', '/srv/station/work/'], ['/root/', '/srv/station/root/']] as const) {
    if (path.startsWith(inside))
      return outside + path.slice(inside.length)
  }
  return path
}

function imageFor(arch: Arch): string {
  const image = `${environment().image}:${arch}`
  if (capture(['docker', 'image', 'inspect', image]).code !== 0)
    fail(`${image} is missing; run: bun src/container.ts environment`)
  return image
}

interface Run {
  arch: Arch
  // An image by digest instead of the environment's local tag.
  image?: string
  network: 'none' | 'default'
  privileged?: boolean
  mounts: [string, string, 'ro' | 'rw'][]
  env?: string[]
  workdir?: string
  command: string[]
}

function dockerRun(run: Run): number {
  const args = ['docker', 'run', '--rm', '--label', 'ai-agent=true', '--network', run.network === 'none' ? 'none' : 'bridge']
  if (run.privileged)
    args.push('--privileged')
  for (const [source, target, mode] of run.mounts)
    args.push('-v', `${hostPath(source)}:${target}:${mode}`)
  for (const name of run.env ?? []) {
    if (process.env[name] !== undefined)
      args.push('-e', `${name}=${process.env[name]}`)
  }
  if (run.workdir)
    args.push('-w', run.workdir)
  if (run.image)
    args.push('--platform', `linux/${run.arch}`)
  return attached([...args, run.image ?? imageFor(run.arch), ...run.command])
}

function stagedRepo(work: string): string {
  const copy = join(work, 'repo')
  for (const entry of REPO_FILES) {
    if (existsSync(join(REPO, entry)))
      cpSync(join(REPO, entry), join(copy, entry), { recursive: true })
  }
  return copy
}

// The builder runs the BuildKit of the build-env lock; its name carries that
// image's digest, so another BuildKit is another builder.
function builder(): string {
  const { buildkit } = environment()
  const name = process.env.MICA_BASE_BUILDER ?? `mica-system-base-${buildkit.slice(buildkit.indexOf('@sha256:') + 8, buildkit.indexOf('@sha256:') + 20)}`
  if (capture(['docker', 'buildx', 'inspect', name]).code !== 0) {
    const created = capture(['docker', 'buildx', 'create', '--name', name, '--driver', 'docker-container', '--driver-opt', `image=${buildkit}`, '--buildkitd-flags', '--allow-insecure-entitlement security.insecure'])
    if (created.code !== 0)
      fail(`creating the buildx builder ${name} failed: ${created.stderr.trim()}`)
  }
  return name
}

// docker-container builders cannot read the local image store, so the image goes in as an OCI layout.
interface Stage {
  arch: Arch
  // An image by digest instead of the environment's.
  image?: string
  work: string
  contexts: Record<string, string>
  dockerfile: string
  output: string[]
  insecure?: boolean
  noCache?: boolean
  buildArgs?: string[]
}

async function buildStage(stage: Stage, into?: string): Promise<void> {
  // The builder pulls the pinned public image by digest itself.
  const image = stage.image ?? environmentReference(stage.arch)
  writeFileSync(join(stage.work, 'Dockerfile'), stage.dockerfile.replace('@IMAGE@', image))
  mkdirSync(join(stage.work, 'context'), { recursive: true })
  const args = ['docker', 'buildx', 'build', '--builder', builder(), '--platform', `linux/${stage.arch}`, '-f', join(stage.work, 'Dockerfile')]
  if (stage.insecure)
    args.push('--allow', 'security.insecure')
  if (stage.noCache)
    args.push('--no-cache')
  for (const name of stage.buildArgs ?? []) {
    if (process.env[name] !== undefined)
      args.push('--build-arg', `${name}=${process.env[name]}`)
  }
  for (const [name, path] of Object.entries(stage.contexts))
    args.push('--build-context', `${name}=${path}`)
  args.push('--output', ...stage.output, join(stage.work, 'context'))
  if (!into) {
    if (attached(args) !== 0)
      fail(`the ${stage.arch} BuildKit stage failed`)
    return
  }
  const build = Bun.spawn(args, { stdout: 'pipe', stderr: 'inherit' })
  const untar = Bun.spawn(['tar', '-x', '-p', '--numeric-owner', '-C', into], { stdin: build.stdout, stderr: 'inherit' })
  if (await build.exited !== 0 || await untar.exited !== 0)
    fail(`the ${stage.arch} BuildKit stage failed`)
}

function stageRun(flags: string[], command: string[]): string {
  return `RUN ${flags.join(' ')} ${JSON.stringify(command)}`
}

function selectionMount(options: Options): { mounts: Run['mounts'], args: string[] } {
  const { selection } = options
  if (selection.kind === 'all')
    return { mounts: [], args: ['--all'] }
  if (selection.kind === 'package')
    return { mounts: [], args: ['--package', selection.name] }
  if (selection.kind === 'base')
    return { mounts: [], args: [] }
  const file = resolvePath(selection.file)
  if (!existsSync(file) || !statSync(file).isFile())
    fail('package selection must be a file')
  return { mounts: [[file, '/selection.pkgs', 'ro']], args: ['--packages', '/selection.pkgs'] }
}

function checkCacheScope(cacheDir: string): void {
  if (['/srv', '/srv/station', '/srv/station/work', '/work', '/root'].includes(hostPath(cacheDir)))
    fail('cache must use a project-scoped directory')
}

function cli(...args: string[]): string[] {
  return ['bun', `${IN_CONTAINER}/src/cli.ts`, ...args]
}

async function bootstrap(options: Options): Promise<void> {
  const arch = options.arch!
  const root = options.root!
  const selection = selectionMount(options)
  if (!existsSync(options.cacheDir))
    fail(`cache is missing: ${options.cacheDir}`)
  const local: string[] = options.local ? ['--local', '/local'] : []
  const created = !existsSync(root)
  mkdirSync(root, { recursive: true })
  try {
    if (arch === hostArch()) {
      const code = dockerRun({
        arch,
        network: 'none',
        privileged: true,
        mounts: [[REPO, IN_CONTAINER, 'ro'], [options.cacheDir, '/cache', 'ro'], [root, '/target', 'rw'], ...selection.mounts, ...(options.local ? [[options.local, '/local', 'ro'] as [string, string, 'ro']] : [])],
        env: ['SOURCE_DATE_EPOCH', ...ISSUE_ENV],
        command: cli('bootstrap', '--arch', arch, '--cache-dir', '/cache', '--root', '/target', ...selection.args, ...local),
      })
      if (code !== 0)
        fail(`bootstrap failed for ${arch}`)
      return
    }
    mkdirSync(join(REPO, '_out'), { recursive: true })
    const work = mkdtempSync(join(REPO, '_out', `.stage-${arch}.`))
    try {
      const contexts: Record<string, string> = { repo: stagedRepo(work), cache: options.cacheDir }
      const mounts = ['--mount=type=bind,from=repo,target=/mica-system-base', '--mount=type=bind,from=cache,target=/cache']
      if (selection.mounts.length) {
        contexts.selection = dirname(selection.mounts[0]![0])
        mounts.push('--mount=type=bind,from=selection,target=/selection')
        selection.args[1] = `/selection/${basename(selection.mounts[0]![0])}`
      }
      if (options.local) {
        contexts.local = options.local
        mounts.push('--mount=type=bind,from=local,target=/local')
      }
      await buildStage({
        arch,
        work,
        contexts,
        insecure: true,
        buildArgs: ['SOURCE_DATE_EPOCH', ...ISSUE_ENV],
        output: ['type=tar,dest=-'],
        dockerfile: [
          `# syntax=${environment().frontend}`,
          'FROM @IMAGE@ AS run',
          'ARG SOURCE_DATE_EPOCH',
          ...ISSUE_ENV.map(name => `ARG ${name}`),
          stageRun(['--security=insecure', '--network=none', ...mounts], cli('bootstrap', '--arch', arch, '--cache-dir', '/cache', '--root', '/out/root', ...selection.args, ...local)),
          'FROM scratch',
          'COPY --from=run /out/root/ /',
          '',
        ].join('\n'),
      }, root)
    }
    finally {
      rmSync(work, { recursive: true, force: true })
    }
  }
  catch (error) {
    if (created && existsSync(root) && readdirSync(root).length === 0)
      rmSync(root, { recursive: true })
    throw error
  }
}

// Runs `pin-inputs` for one architecture: the inputs in the environment image, or,
// given a package, its build packages in the C image it builds in.
async function resolveInputs(arch: Arch, name?: string): Promise<Row[]> {
  mkdirSync(join(REPO, '_out'), { recursive: true })
  const work = mkdtempSync(join(REPO, '_out', `.inputs-${arch}.`))
  const image = name ? environment().c[arch] : undefined
  const command = cli('pin-inputs', '--arch', arch, ...(name ? ['--package', name] : []), '--output', '/out/pins.tsv')
  try {
    if (arch === hostArch()) {
      mkdirSync(join(work, 'out'))
      const code = dockerRun({
        arch,
        ...(image ? { image } : {}),
        network: 'default',
        mounts: [[REPO, IN_CONTAINER, 'ro'], [join(work, 'out'), '/out', 'rw']],
        command,
      })
      if (code !== 0)
        fail(`resolving the ${arch} ${name ? `build packages of debs/${name}` : 'inputs'} failed`)
    }
    else {
      await buildStage({
        arch,
        ...(image ? { image } : {}),
        work,
        noCache: true,
        contexts: { repo: stagedRepo(work) },
        output: [`type=local,dest=${join(work, 'out')}`],
        dockerfile: [
          `# syntax=${environment().frontend}`,
          'FROM @IMAGE@ AS run',
          stageRun(['--mount=type=bind,from=repo,target=/mica-system-base'], command),
          'FROM scratch',
          'COPY --from=run /out/ /',
          '',
        ].join('\n'),
      })
    }
    return parseRows(readFileSync(join(work, 'out/pins.tsv'), 'utf8'))
  }
  finally {
    rmSync(work, { recursive: true, force: true })
  }
}

// A file's leading comment lines, kept when pin-inputs rewrites it.
function header(file: string): string[] {
  const lines = readFileSync(file, 'utf8').split('\n')
  return lines.slice(0, lines.findIndex(line => !line.startsWith('#')))
}

const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b))

// Rewrites what pin-inputs resolves: in locks/upstream.lock the input.<name> rows
// of the inputs debs/ declares, the build.<package>.<name> rows of each package's
// build closure, and the runtime rows of the closure of upstream.pkgs beyond the
// base, with their packages.tsv lines, each tagged upstream-<root> for the roots
// that need it; every other row and line stays. --check only compares.
async function pinInputs(check: boolean): Promise<void> {
  const resolved: string[][] = []
  const inputs = new Map<Arch, Row[]>()
  for (const arch of ARCHES)
    inputs.set(arch, await resolveInputs(arch))
  for (const name of declared(REPO).flatMap(entry => entry.inputs)) {
    if (ARCHES.some(arch => !inputs.get(arch)!.some(row => row.name === name)))
      fail(`the snapshot resolved no ${name}`)
  }
  resolved.push(...lockRows('input.', inputs))
  for (const entry of declared(REPO).filter(candidate => candidate.build.length)) {
    const build = new Map<Arch, Row[]>()
    for (const arch of ARCHES)
      build.set(arch, await resolveInputs(arch, entry.name))
    resolved.push(...lockRows(`build.${entry.name}.`, build))
  }
  const upstream = new Map<Arch, Row[]>()
  const roots = new Map<string, string>()
  for (const arch of ARCHES) {
    upstream.set(arch, await resolveUpstream(arch))
    for (const { name, consumers } of upstream.get(arch)!) {
      if (!consumers.length)
        fail(`the ${arch} upstream package ${name} was resolved for no root of upstream.pkgs`)
      if (roots.has(name) && roots.get(name) !== consumers.join(','))
        fail(`${name} is pinned for other roots of upstream.pkgs on ${arch}`)
      roots.set(name, consumers.join(','))
    }
  }
  resolved.push(...lockRows('', upstream))
  const lockFile = join(REPO, UPSTREAM_LOCK)
  const selectionFile = join(REPO, SELECTIONS)
  const selected = new Map(readFileSync(selectionFile, 'utf8').split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split('\t') as [string, string]))
  const upstreamOnly = (name: string): boolean => selected.get(name)?.split(',').every(consumer => consumer.startsWith('upstream-')) ?? false
  const regenerated = (name: string): boolean => name.startsWith('input.') || name.startsWith('build.') || upstreamOnly(name)
  const rows = [...sourceRows(REPO).filter(([name = '']) => !regenerated(name)).map(row => ['source', ...row]), ...resolved]
    .sort((a, b) => byBytes(a[1]!, b[1]!) || byBytes(a[2]!, b[2]!))
  const lock = `${[...header(lockFile), ...rows.map(row => row.join('\t'))].join('\n')}\n`
  const lines = [...[...selected].filter(([name]) => !upstreamOnly(name)), ...roots].sort(([a], [b]) => byBytes(a, b))
  const selection = `${[...header(selectionFile), ...lines.map(line => line.join('\t'))].join('\n')}\n`
  const before = new Set(readFileSync(lockFile, 'utf8').split('\n'))
  const after = new Set(lock.split('\n'))
  const changed = [...new Set([...before].filter(line => !after.has(line)).concat([...after].filter(line => !before.has(line))).filter(line => line.startsWith('source\t')).map(line => line.split('\t')[1]))]
  if (check) {
    if (readFileSync(lockFile, 'utf8') !== lock || readFileSync(selectionFile, 'utf8') !== selection)
      fail(`${UPSTREAM_LOCK} or ${SELECTIONS} differs from the snapshot: ${changed.join(', ') || 'the selections'}`)
    console.log(`debian-base: ${UPSTREAM_LOCK} and ${SELECTIONS} match the snapshot (${resolved.length} resolved rows)`)
    return
  }
  writeFileSync(lockFile, lock)
  writeFileSync(selectionFile, selection)
  console.log(`debian-base: ${UPSTREAM_LOCK} rewritten: ${resolved.length} resolved rows, changed ${changed.join(', ') || 'none'}`)
}

// Resolves the closure of upstream.pkgs for one architecture in the native
// environment image.
async function resolveUpstream(arch: Arch): Promise<Row[]> {
  mkdirSync(join(REPO, '_out'), { recursive: true })
  const work = mkdtempSync(join(REPO, '_out', `.upstream-${arch}.`))
  try {
    mkdirSync(join(work, 'out'))
    const code = dockerRun({
      arch: hostArch(),
      network: 'default',
      mounts: [[REPO, IN_CONTAINER, 'ro'], [join(work, 'out'), '/out', 'rw']],
      command: cli('pin-inputs', '--arch', arch, '--packages', `${IN_CONTAINER}/upstream.pkgs`, '--output', '/out/pins.tsv'),
    })
    if (code !== 0)
      fail(`resolving the ${arch} upstream packages failed`)
    return parseRows(readFileSync(join(work, 'out/pins.tsv'), 'utf8'))
  }
  finally {
    rmSync(work, { recursive: true, force: true })
  }
}

async function testBootstrap(options: Options): Promise<void> {
  const arch = options.arch!
  mkdirSync(join(REPO, '_out'), { recursive: true })
  const parent = mkdtempSync(join(REPO, '_out', `.test-bootstrap-${arch}.`))
  const root = join(parent, 'root')
  try {
    await bootstrap({ ...options, root, selection: { kind: 'all' } })
    for (const residue of ['etc/dpkg/dpkg.cfg.d/99mmdebstrap', 'etc/apt/apt.conf.d/99mmdebstrap', 'usr/bin/apt']) {
      if (existsSync(join(root, residue)))
        fail(`the ${arch} root carries ${residue}`)
    }
    if (!existsSync(join(root, 'etc/dpkg/dpkg.cfg.d/mica-slim')))
      fail(`the ${arch} root has no etc/dpkg/dpkg.cfg.d/mica-slim`)
    // The exclusions leave directories, top-level doc links and copyright files.
    const files = (directory: string): string[] => nonDirectories(join(root, directory)).map(entry => entry.path.slice(root.length + 1))
    const shipped = ['usr/share/man', 'usr/share/info', 'usr/share/locale'].flatMap(files)
    if (shipped.length)
      fail(`the ${arch} root carries excluded files: ${shipped.join(', ')}`)
    const nested = files('usr/share/doc').filter(file => file.split('/').length > 4)
    const extra = nested.filter(file => !file.endsWith('/copyright'))
    if (extra.length || nested.length < 100)
      fail(`the ${arch} root has ${nested.length} documentation files, not copyright: ${extra.join(', ') || '(none)'}`)
    console.log(`RESULT: PASS (${arch} bootstrap of every locked package)`)
  }
  finally {
    removeTree(parent)
  }
}

// A directory the privileged bootstrap filled with root-owned files: a host that
// is not root (a CI runner) empties it from inside the environment image first.
function removeTree(directory: string): void {
  try {
    rmSync(directory, { recursive: true, force: true })
    return
  }
  catch (error) {
    if ((error as { code?: string }).code !== 'EACCES')
      throw error
  }
  if (dockerRun({ arch: hostArch(), network: 'none', mounts: [[directory, '/tree', 'rw']], command: ['find', '/tree', '-mindepth', '1', '-delete'] }) !== 0)
    fail(`emptying ${directory} failed`)
  rmSync(directory, { recursive: true, force: true })
}

async function main(options: Options): Promise<number> {
  checkCacheScope(options.cacheDir)
  const native = hostArch()
  switch (options.command) {
    case 'test':
      return dockerRun({ arch: native, network: 'none', mounts: [[REPO, IN_CONTAINER, 'ro']], workdir: IN_CONTAINER, command: ['bun', 'test'] })
    case 'test-bootstrap':
      await testBootstrap(options)
      return 0
    case 'pin-inputs':
      await pinInputs(options.check)
      return 0
    case 'bootstrap':
      await bootstrap(options)
      return 0
  }
  const selection = selectionMount(options)
  const mounts: Run['mounts'] = [[REPO, IN_CONTAINER, 'ro'], ...selection.mounts]
  if (options.command === 'cache')
    mkdirSync(options.cacheDir, { recursive: true })
  if (existsSync(options.cacheDir))
    mounts.push([options.cacheDir, '/cache', options.command === 'cache' ? 'rw' : 'ro'])
  else if (options.command !== 'select')
    fail(`cache is missing: ${options.cacheDir}`)
  return dockerRun({
    arch: native,
    // Only cache has a network, so only cache gets the mirror.
    network: options.command === 'cache' ? 'default' : 'none',
    mounts,
    env: options.command === 'cache' ? ['MICA_BASE_MIRROR', 'MICA_BASE_FETCH_DEADLINE'] : [],
    command: cli(options.command, '--arch', options.arch!, '--cache-dir', '/cache', ...selection.args),
  })
}

// The package version (<YYYYMMDD-HHMM>-1 for a release, <commit minute>~git<commit12>[.dirty]-1
// otherwise), the provenance commit, and every package mtime at its committer date.
export function provenance(): { version: string, repository: string, commit: string, epoch: string } {
  const release = releaseOf(REPO)
  return { version: release.packageVersion, repository: release.repository, commit: release.commit, epoch: release.epoch }
}

// The base root of one architecture: the lock's base and system families and
// this repository's base packages from its pool, in one mmdebstrap run, held to
// the base invariants (src/rootfs.ts).
async function rootfs(argv: string[]): Promise<number> {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const [option, value] = [argv[index]!, argv[index + 1]]
    if (!['--arch', '--root', '--cache-dir', '--pool'].includes(option) || !value)
      fail(`usage: bun src/container.ts rootfs --arch amd64|arm64 [--root DIR] [--pool DIR] [--cache-dir DIR]`)
    values.set(option, value)
  }
  const arch = values.get('--arch') as Arch
  if (!(ARCHES as string[]).includes(arch))
    fail('rootfs requires --arch amd64 or arm64')
  const out = join(REPO, '_out')
  const root = resolvePath(values.get('--root') ?? join(out, 'rootfs', arch))
  const pool = resolvePath(values.get('--pool') ?? join(out, 'debs', arch, 'pool'))
  const cacheDir = resolvePath(values.get('--cache-dir') ?? join(out, 'debian-base'))
  if (!existsSync(pool))
    fail(`${pool} does not exist; run: bun src/container.ts debs`)
  if (root.startsWith(`${join(out, 'rootfs')}/`))
    rmSync(root, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  const work = mkdtempSync(join(out, `.rootfs-${arch}.`))
  try {
    const selection = join(work, 'families.pkgs')
    writeFileSync(selection, `${BASE_PACKAGES.join('\n')}\n`)
    const local = join(work, 'local')
    mkdirSync(local)
    for (const file of readdirSync(pool).filter(name => BASE_PACKAGES.some(pkg => name.startsWith(`${pkg}_`))))
      cpSync(join(pool, file), join(local, file))
    checkCacheScope(cacheDir)
    // /etc/issue names the release, the build time and the commit.
    const release = releaseOf(REPO)
    Object.assign(process.env, { MICA_BASE_LABEL: release.label, MICA_BASE_COMMIT: release.commit, MICA_BUILD_TIME: buildTime() })
    await bootstrap({ command: 'bootstrap', arch, cacheDir, root, local, check: false, selection: { kind: 'consumers', file: selection } })
    console.log(`RESULT: PASS (${arch} base root at ${root})`)
    return 0
  }
  finally {
    rmSync(work, { recursive: true, force: true })
  }
}

// The platform manifest of one architecture's environment image, by digest.
function environmentReference(arch: Arch): string {
  return environment().base[arch]
}

// A file of an image, copied out of a created, never started container.
function imageFile(image: string, path: string): string {
  mkdirSync(join(REPO, '_out'), { recursive: true })
  const work = mkdtempSync(join(REPO, '_out', '.image-file.'))
  const created = capture(['docker', 'create', '--label', 'ai-agent=true', image])
  try {
    if (created.code !== 0)
      fail(`creating a container of ${image} failed: ${created.stderr.trim()}`)
    const copied = capture(['docker', 'cp', `${created.stdout.trim()}:${path}`, join(work, 'file')])
    if (copied.code !== 0)
      fail(`${image} has no readable ${path}: ${copied.stderr.trim()}`)
    return readFileSync(join(work, 'file'), 'utf8')
  }
  finally {
    if (created.code === 0)
      capture(['docker', 'rm', created.stdout.trim()])
    rmSync(work, { recursive: true, force: true })
  }
}

// Check the pinned mica-build-env release lists the committed lock, then pull each
// architecture's base image and tag it locally: the tag names one platform, so
// docker run uses it without a platform flag. BuildKit stages take the images by
// digest.
async function pullEnvironment(): Promise<number> {
  const env = environment()
  const url = buildEnvAsset(env.buildEnv, 'SHA256SUMS')
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) }).catch(() => undefined)
  if (!response?.ok)
    fail(`downloading ${url} failed${response ? ` (HTTP ${response.status})` : ''}`)
  assertBuildEnvRelease(env.buildEnv, new Uint8Array(await response.arrayBuffer()), new Uint8Array(readFileSync(join(REPO, 'locks', `${BUILD_ENV}.lock`))))
  console.log(`environment: ${env.buildEnv.repository} ${env.buildEnv.release} pins base ${env.base.amd64}, ${env.base.arm64} and c ${env.c.amd64}, ${env.c.arm64}`)
  const { image } = env
  for (const arch of ARCHES) {
    const reference = environmentReference(arch)
    if (attached(['docker', 'pull', '--quiet', '--platform', `linux/${arch}`, reference]) !== 0 || attached(['docker', 'tag', reference, `${image}:${arch}`]) !== 0)
      fail(`pulling ${reference} as ${image}:${arch} failed`)
    assertEnvironmentImage(env, arch, imageFile(`${image}:${arch}`, '/etc/mica-build/base.env'))
    console.log(`environment: ${image}:${arch} is ${reference}`)
  }
  return 0
}

async function debs(argv: string[]): Promise<number> {
  let cacheDir = join(REPO, '_out/debian-base')
  let out = join(REPO, '_out/debs')
  const only: string[] = []
  let arch: Arch | undefined
  for (let index = 0; index < argv.length; index += 2) {
    const [option, value] = [argv[index], argv[index + 1]]
    if (!value)
      fail(`${option} requires a value`)
    if (option === '--arch')
      arch = (ARCHES as string[]).includes(value) ? value as Arch : fail(`unsupported architecture: ${value}`)
    else if (option === '--cache-dir')
      cacheDir = resolvePath(value)
    else if (option === '--output')
      out = resolvePath(value)
    else if (option === '--package')
      only.push(value)
    else
      fail(`unknown option: ${option}`)
  }
  checkCacheScope(cacheDir)
  if (!existsSync(cacheDir))
    fail(`cache is missing: ${cacheDir}; run: bun src/container.ts cache --arch amd64 --all && bun src/container.ts cache --arch arm64 --all`)
  const { version, repository, commit, epoch } = provenance()
  if (!only.length)
    rmSync(arch ? join(out, arch) : out, { recursive: true, force: true })
  const native = hostArch()
  const built = buildDebs({
    repo: REPO,
    cacheDir,
    out,
    builder: builder(),
    image: environmentReference(native),
    cImage: arch => environment().c[arch],
    native,
    provenance: { MICA_DEB_VERSION: version, MICA_DEB_SOURCE_REPO: repository, MICA_DEB_SOURCE_COMMIT: commit, SOURCE_DATE_EPOCH: epoch },
  }, only, arch)
  console.log(`debs: ${built.join(', ')}`)
  return 0
}

if (import.meta.main) {
  try {
    if (process.argv[2] === 'debs') {
      process.exitCode = await debs(process.argv.slice(3))
    }
    else if (process.argv[2] === 'environment') {
      process.exitCode = await pullEnvironment()
    }
    else if (process.argv[2] === 'rootfs') {
      process.exitCode = await rootfs(process.argv.slice(3))
    }
    else {
      const options = parse(process.argv.slice(2), COMMANDS)
      if (!options)
        console.log(USAGE)
      else
        process.exitCode = await main(options)
    }
  }
  catch (error) {
    process.exitCode = report(error)
  }
}
