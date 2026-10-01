// Host entry: runs src/cli.ts in the environment image, via BuildKit for a foreign architecture.
import type { Options } from './args.ts'
import type { Arch, Row } from './lock.ts'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { reposGet, reposLookup, verifyLocks } from '@mica/build-tools'
import { parse, resolvePath, USAGE } from './args.ts'
import { nonDirectories } from './bootstrap.ts'
import { buildDebs, declared } from './debs/docker.ts'
import { fail, report } from './errors.ts'
import { attached, capture } from './exec.ts'
import { ARCHES, hostArch, lockRows, parseRows, SELECTIONS, selectRuntime, selectSource, sourceRows, UPSTREAM_LOCK, UPSTREAM_PKGS } from './lock.ts'
import { addedNames, runtimeNames, tagUpstream } from './pin-inputs.ts'
import { assertEnvironmentImage, environment, REPO, sources } from './pins.ts'
import { buildTime, releaseOf } from './release.ts'
import type { Init } from './rootfs.ts'
import { BASE_PACKAGES, INITS, ISSUE_ENV } from './rootfs.ts'

const COMMANDS = ['cache', 'verify', 'select', 'bootstrap', 'pin-inputs', 'test', 'test-bootstrap']
const IN_CONTAINER = '/mica-system-base'
// What a BuildKit stage needs of this repository; @mica/build-tools resolves
// through tsconfig.json onto the pinned checkout.
const REPO_FILES = ['src', 'locks', 'config', 'debs', 'package.json', 'tsconfig.json', 'repos/mica-build-tools/src']

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

// A fresh directory under _out/, for one run's scratch files.
function scratch(prefix: string): string {
  mkdirSync(join(REPO, '_out'), { recursive: true })
  return mkdtempSync(join(REPO, '_out', `.${prefix}.`))
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

// A BuildKit build for a foreign architecture; the builder pulls its
// image by digest, the environment's base image unless another is named.
interface Stage {
  arch: Arch
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
  const image = stage.image ?? environment().base[stage.arch]
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
    const work = scratch(`stage-${arch}`)
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

// Runs `pin-inputs` for `arch` with `args` and returns the rows it resolved. The
// inputs and a package's build closure resolve on `arch` itself, in the
// environment image or, given `image`, the package's C image, through BuildKit for
// a foreign architecture; the runtime and upstream closures resolve for any
// architecture from the native environment image (`foreign`).
async function runPinInputs(arch: Arch, what: string, args: string[], options: { image?: string, foreign?: boolean } = {}): Promise<Row[]> {
  const work = scratch(`pins-${arch}`)
  const command = cli('pin-inputs', '--arch', arch, ...args, '--output', '/out/pins.tsv')
  try {
    if (options.foreign || arch === hostArch()) {
      mkdirSync(join(work, 'out'))
      const code = dockerRun({
        arch: options.foreign ? hostArch() : arch,
        ...(options.image ? { image: options.image } : {}),
        network: 'default',
        mounts: [[REPO, IN_CONTAINER, 'ro'], [join(work, 'out'), '/out', 'rw']],
        command,
      })
      if (code !== 0)
        fail(`resolving the ${arch} ${what} failed`)
    }
    else {
      await buildStage({
        arch,
        ...(options.image ? { image: options.image } : {}),
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
// build closure, the runtime rows of the root at the snapshot of locks/sources.json,
// and the rows of the closure of locks/upstream.pkgs beyond the root, with their
// locks/packages.tsv lines, each tagged upstream-<root> for the roots that need it; the
// source rows stay. --check only compares.
async function pinInputs(check: boolean): Promise<void> {
  const resolved: string[][] = []
  const inputs = new Map<Arch, Row[]>()
  for (const arch of ARCHES)
    inputs.set(arch, await runPinInputs(arch, 'inputs', []))
  for (const name of declared(REPO).flatMap(entry => entry.inputs)) {
    if (ARCHES.some(arch => !inputs.get(arch)!.some(row => row.name === name)))
      fail(`the snapshot resolved no ${name}`)
  }
  resolved.push(...lockRows('input.', inputs))
  for (const entry of declared(REPO).filter(candidate => candidate.build.length)) {
    const build = new Map<Arch, Row[]>()
    for (const arch of ARCHES)
      build.set(arch, await runPinInputs(arch, `build packages of debs/${entry.name}`, ['--package', entry.name], { image: environment().c[arch] }))
    resolved.push(...lockRows(`build.${entry.name}.`, build))
  }
  // The runtime rows, again at the snapshot: the same names, whose versions may move
  // but whose closure may not grow without locks/packages.tsv naming the new package.
  const runtime = new Map<Arch, Row[]>()
  for (const arch of ARCHES) {
    const rows = await runPinInputs(arch, 'runtime packages', ['--all'], { foreign: true })
    const added = addedNames(runtimeNames(selectRuntime(REPO, arch, { kind: 'all' })), rows.map(row => row.name))
    if (added.length)
      fail(`the snapshot's versions add ${added.join(', ')} to the ${arch} root; name their consumer in ${SELECTIONS} first`)
    runtime.set(arch, rows)
  }
  resolved.push(...lockRows('', runtime))
  const root = new Set(ARCHES.flatMap(arch => runtimeNames(selectRuntime(REPO, arch, { kind: 'all' }))))
  const upstream = new Map<Arch, Row[]>()
  const roots = new Map<string, string>()
  for (const arch of ARCHES) {
    upstream.set(arch, await runPinInputs(arch, 'upstream packages', ['--packages', `${IN_CONTAINER}/${UPSTREAM_PKGS}`], { foreign: true }))
    for (const { name, consumers } of upstream.get(arch)!) {
      if (!consumers.length)
        fail(`the ${arch} upstream package ${name} was resolved for no root of ${UPSTREAM_PKGS}`)
      if (roots.has(name) && roots.get(name) !== consumers.join(','))
        fail(`${name} is pinned for other roots of ${UPSTREAM_PKGS} on ${arch}`)
      roots.set(name, consumers.join(','))
    }
  }
  // A package the floor purges is a runtime row already: one row, both attributions.
  resolved.push(...lockRows('', new Map([...upstream].map(([arch, rows]) => [arch, rows.filter(row => !root.has(row.name))]))))
  const lockFile = join(REPO, UPSTREAM_LOCK)
  const selectionFile = join(REPO, SELECTIONS)
  const selected = tagUpstream(new Map(readFileSync(selectionFile, 'utf8').split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split('\t') as [string, string])), roots)
  const upstreamOnly = (name: string): boolean => selected.get(name)?.split(',').every(consumer => consumer.startsWith('upstream-')) ?? false
  const regenerated = (name: string): boolean => name.startsWith('input.') || name.startsWith('build.') || upstreamOnly(name) || root.has(name)
  const rows = [...sourceRows(REPO).filter(([name = '']) => !regenerated(name)).map(row => ['source', ...row]), ...resolved]
    .sort((a, b) => byBytes(a[1]!, b[1]!) || byBytes(a[2]!, b[2]!))
  const lock = `${[...header(lockFile), ...rows.map(row => row.join('\t'))].join('\n')}\n`
  const lines = [...[...selected].filter(([name]) => !upstreamOnly(name)), ...[...roots].filter(([name]) => !root.has(name))].sort(([a], [b]) => byBytes(a, b))
  const selection = `${[...header(selectionFile), ...lines.map(line => line.join('\t'))].join('\n')}\n`
  const before = new Set(readFileSync(lockFile, 'utf8').split('\n'))
  const after = new Set(lock.split('\n'))
  const changed = [...new Set([...before].filter(line => !after.has(line)).concat([...after].filter(line => !before.has(line))).filter(line => line.startsWith('source\t')).map(line => line.split('\t')[1]))]
  if (check) {
    if (readFileSync(lockFile, 'utf8') !== lock || readFileSync(selectionFile, 'utf8') !== selection)
      fail(`${UPSTREAM_LOCK} or ${SELECTIONS} differs from the snapshot: ${changed.join(', ') || 'the selections'}`)
    console.log(`mica-system-base: ${UPSTREAM_LOCK} and ${SELECTIONS} match the snapshot (${resolved.length} resolved rows)`)
    return
  }
  writeFileSync(lockFile, lock)
  writeFileSync(selectionFile, selection)
  console.log(`mica-system-base: ${UPSTREAM_LOCK} rewritten: ${resolved.length} resolved rows, changed ${changed.join(', ') || 'none'}`)
}

async function testBootstrap(options: Options): Promise<void> {
  const arch = options.arch!
  const parent = scratch(`test-bootstrap-${arch}`)
  const root = join(parent, 'root')
  try {
    // Every locked package but the OpenRC init's own, which cannot share a root with
    // systemd's (systemd-sysv conflicts with openrc's insserv); `rootfs --init openrc`
    // bootstraps those.
    const consumers = [...new Set(selectRuntime(REPO, arch, { kind: 'all' }).flatMap(row => row.consumers))]
      .filter(consumer => consumer !== 'base' && consumer !== 'upstream-openrc')
    const selection = join(parent, 'every-package.pkgs')
    writeFileSync(selection, `${consumers.sort().join('\n')}\n`)
    await bootstrap({ ...options, root, selection: { kind: 'consumers', file: selection } })
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
      // The checkout belongs to the host user and the tests run as root, so git --
      // mica-build-tools' own calls included -- is told the mount is safe.
      return dockerRun({ arch: native, network: 'none', mounts: [[REPO, IN_CONTAINER, 'ro']], workdir: IN_CONTAINER, command: ['env', 'GIT_CONFIG_COUNT=1', 'GIT_CONFIG_KEY_0=safe.directory', `GIT_CONFIG_VALUE_0=${IN_CONTAINER}`, 'bun', 'test'] })
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
    env: options.command === 'cache' ? ['MICA_MIRROR', 'MICA_FETCH_DEADLINE', 'MICA_OFFLINE'] : [],
    command: cli(options.command, '--arch', options.arch!, '--cache-dir', '/cache', ...selection.args),
  })
}

// The base root of one architecture -- the floor, the lock's base and system
// families and this repository's base packages from its pool, in one mmdebstrap
// run -- held to the floor's invariants (src/rootfs.ts). With --init, the floor
// composed with that init's packages and the closure of its upstream roots, as a
// product composes it, held to that init's invariants; only the floor is published.
async function rootfs(argv: string[]): Promise<number> {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const [option, value] = [argv[index]!, argv[index + 1]]
    if (!['--arch', '--init', '--root', '--cache-dir', '--pool'].includes(option) || !value)
      fail(`usage: bun src/container.ts rootfs --arch amd64|arm64 [--init ${Object.keys(INITS).join('|')}] [--root DIR] [--pool DIR] [--cache-dir DIR]`)
    values.set(option, value)
  }
  const arch = values.get('--arch') as Arch
  if (!(ARCHES as string[]).includes(arch))
    fail('rootfs requires --arch amd64 or arm64')
  const init = values.get('--init') as Init | undefined
  if (init !== undefined && !Object.hasOwn(INITS, init))
    fail(`--init ${init} is not ${Object.keys(INITS).join(' or ')}`)
  const packages = [...BASE_PACKAGES, ...(init ? INITS[init].packages : [])]
  const out = join(REPO, '_out')
  const root = resolvePath(values.get('--root') ?? join(out, 'rootfs', init ? `${arch}-${init}` : arch))
  const pool = resolvePath(values.get('--pool') ?? join(out, 'debs', arch, 'pool'))
  const cacheDir = resolvePath(values.get('--cache-dir') ?? join(REPO, 'repos'))
  if (!existsSync(pool))
    fail(`${pool} does not exist; run: bun src/container.ts debs`)
  if (root.startsWith(`${join(out, 'rootfs')}/`))
    rmSync(root, { recursive: true, force: true })
  const work = scratch(`rootfs-${arch}`)
  try {
    const selection = join(work, 'families.pkgs')
    writeFileSync(selection, `${[...packages, ...(init ? INITS[init].roots.map(name => `upstream-${name}`) : [])].join('\n')}\n`)
    const local = join(work, 'local')
    mkdirSync(local)
    for (const file of readdirSync(pool).filter(name => packages.some(pkg => name.startsWith(`${pkg}_`))))
      cpSync(join(pool, file), join(local, file))
    checkCacheScope(cacheDir)
    // /etc/issue names the release, the build time and the commit.
    const release = releaseOf(REPO)
    Object.assign(process.env, { MICA_BASE_LABEL: release.label, MICA_BASE_COMMIT: release.commit, MICA_BUILD_TIME: buildTime() })
    await bootstrap({ command: 'bootstrap', arch, cacheDir, root, local, check: false, selection: { kind: 'consumers', file: selection } })
    if (init) {
      console.log(`RESULT: PASS (${arch} ${init} root at ${root})`)
      return 0
    }
    // Beside the root: every path no package claims, with what wrote it
    // (src/unowned.ts), which a composer cannot derive from package ownership.
    const unowned = `${root}.unowned.tsv`
    const listed = dockerRun({
      arch: hostArch(),
      network: 'none',
      mounts: [[REPO, IN_CONTAINER, 'ro'], [root, '/root-tree', 'ro'], [dirname(unowned), '/out', 'rw']],
      command: cli('unowned', '--root', '/root-tree', '--output', `/out/${basename(unowned)}`),
    })
    if (listed !== 0)
      fail(`listing the unowned paths of the ${arch} root failed`)
    // The one place the attribution rules meet a built root: echo the file's
    // header, which carries its counts.
    const [header] = readFileSync(unowned, 'utf8').split('\n')
    console.log(`rootfs: ${header!.slice(header!.indexOf(':') + 2)}, in ${unowned}`)
    console.log(`RESULT: PASS (${arch} base root at ${root})`)
    return 0
  }
  finally {
    rmSync(work, { recursive: true, force: true })
  }
}

// A file of an image, copied out of a created, never started container.
function imageFile(image: string, path: string): string {
  const work = scratch('image-file')
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

// Check each pinned release lists its committed lock, then pull each
// architecture's base image and tag it locally: the tag names one platform, so
// docker run uses it without a platform flag. BuildKit stages take the images by
// digest.
async function pullEnvironment(): Promise<number> {
  const env = environment()
  for (const line of await verifyLocks(join(REPO, 'locks')))
    console.log(`environment: ${line}`)
  console.log(`environment: base ${env.base.amd64}, ${env.base.arm64} and c ${env.c.amd64}, ${env.c.arm64}`)
  const { image } = env
  for (const arch of ARCHES) {
    const reference = env.base[arch]
    if (attached(['docker', 'pull', '--quiet', '--platform', `linux/${arch}`, reference]) !== 0 || attached(['docker', 'tag', reference, `${image}:${arch}`]) !== 0)
      fail(`pulling ${reference} as ${image}:${arch} failed`)
    assertEnvironmentImage(env, arch, imageFile(`${image}:${arch}`, '/etc/mica-build/base.env'))
    console.log(`environment: ${image}:${arch} is ${reference}`)
  }
  return 0
}

async function debs(argv: string[]): Promise<number> {
  let cacheDir = join(REPO, 'repos')
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
  if (!only.length)
    rmSync(arch ? join(out, arch) : out, { recursive: true, force: true })
  const native = hostArch()
  const built = buildDebs({
    repo: REPO,
    cacheDir,
    out,
    builder: builder(),
    image: environment().base[native],
    cImage: arch => environment().c[arch],
    native,
    repository: releaseOf(REPO).repository,
  }, only, arch)
  console.log(`debs: ${built.join(', ')}`)
  return 0
}

// The OpenRC root of x64 booted under QEMU with the Debian kernel the lock pins for
// this test (source.test-kernel): a read-only root disk made from
// _out/rootfs/amd64-openrc, a fresh DATA disk with project quotas, and an initramfs
// that loads the modules this kernel keeps out of its image -- virtio_blk, and the
// quota format DATA's project quotas need -- and hands over to openrc-init. A stand-in mica-deploy
// reports a deployment and, when the health gate confirms it, powers the machine
// off, so the run covers the boot, the gate and the shutdown. The serial log is kept
// in _out/boot-test.log.
const BOOT_TEST_OVERLAY: Record<string, string> = {
  'etc/fstab': '/dev/vdb /mnt/data ext4 noatime,prjquota 0 2\n',
  'etc/mica/health.conf': 'require=boot-settled\nsettle-sec=120\nprobe-timeout-sec=10\nvar-threshold-pct=85\n',
  'usr/local/bin/mica-deploy': [
    '#!/bin/sh',
    '# The boot test\'s stand-in: one deployment, and a confirmation that ends the run.',
    'case "$1" in',
    'booted) printf \'%064d\\n\' 0 ;;',
    '# The bounding set of a supervised daemon, for the test to read off the console.',
    'confirm)',
    '  for p in /proc/[0-9]*; do [ "$(cat $p/comm 2>/dev/null)" = dbus-daemon ] && sed -n "s/^CapBnd:/boot-test: dbus-daemon CapBnd:/p" $p/status >/dev/console; done',
    '  { ip -4 addr show dev eth0; cat /etc/resolv.conf; } | sed "s/^/boot-test: /" >/dev/console',
    '  (sleep 3; openrc-shutdown --poweroff now) >/dev/null 2>&1 & ;;',
    '*) exit 1 ;;',
    'esac',
    '',
  ].join('\n'),
}

const BOOT_TEST_INIT = [
  '#!/bin/busybox sh',
  'B=/bin/busybox',
  '$B mkdir -p /proc /sys /dev /newroot',
  '$B mount -t proc proc /proc',
  '$B mount -t sysfs sysfs /sys',
  '$B mount -t devtmpfs devtmpfs /dev',
  'for module in virtio_blk quota_tree quota_v2 failover net_failover virtio_net; do $B insmod /$module.ko; done',
  'for i in $($B seq 50); do [ -b /dev/vda ] && break; $B sleep 0.1; done',
  '$B mount -o ro /dev/vda /newroot',
  '$B umount /proc /sys /dev',
  'exec $B switch_root /newroot /usr/sbin/init',
  '',
].join('\n')

const BOOT_TEST_SCRIPT = `set -eu
cd /work
dpkg-deb -x kernel.deb kernel
version=$(ls kernel/usr/lib/modules)
mkdir -p initrd/bin
cp /rootfs/usr/bin/busybox initrd/bin/busybox
xz -dc "kernel/usr/lib/modules/$version/kernel/drivers/block/virtio_blk.ko.xz" >initrd/virtio_blk.ko
for module in fs/quota/quota_tree fs/quota/quota_v2 net/core/failover drivers/net/net_failover drivers/net/virtio_net; do
  xz -dc "kernel/usr/lib/modules/$version/kernel/$module.ko.xz" >"initrd/\${module##*/}.ko"
done
install -m 0755 init initrd/init
(cd initrd && find . | /rootfs/usr/bin/busybox cpio -o -H newc 2>/dev/null) | gzip -9 >initrd.img
cp -a /rootfs root
cp -a overlay/. root/
# What mica-build's pack stage does: the factory copy mica-shadow-reconcile builds from.
mkdir -p root/usr/share/factory/etc
cp -a root/etc/shadow root/usr/share/factory/etc/shadow
chmod 0755 root/usr/local/bin/mica-deploy
mke2fs -q -t ext4 -L root -d root root.img 768M
mke2fs -q -t ext4 -L data -O quota,project -E quotatype=prjquota data.img 512M
accel=tcg; [ -c /dev/kvm ] && accel=kvm
timeout 600 qemu-system-x86_64 -machine q35,accel=$accel -cpu max -m 1024 -smp 2 \\
  -display none -no-reboot -serial file:serial.log -nic user,model=virtio-net-pci \\
  -kernel "kernel/boot/vmlinuz-$version" -initrd initrd.img -append 'console=ttyS0 panic=-1' \\
  -drive file=root.img,if=virtio,format=raw,readonly=on -drive file=data.img,if=virtio,format=raw
`

// The expectations of the boot test's serial log.
const BOOT_TEST_EXPECT = [
  'mica-health: booted slot 0000000000000000000000000000000000000000000000000000000000000000 marked good',
  'mica-health: no failed units',
  'Unbinding DATA',
  // QEMU's user network: a DHCP lease on eth0 and its DNS server in /etc/resolv.conf.
  'inet 10.0.2.15/24',
  'boot-test: nameserver 10.0.2.3',
]

async function bootTest(argv: string[]): Promise<number> {
  if (argv.join(' ') !== '--init openrc')
    fail('usage: bun src/container.ts boot-test --init openrc')
  if (hostArch() !== 'amd64')
    fail('the boot test runs on an x64 host')
  const root = join(REPO, '_out/rootfs/amd64-openrc')
  if (!existsSync(join(root, 'usr/sbin/openrc-init')))
    fail(`${root} is not an OpenRC root; compose it with: bun src/container.ts rootfs --arch amd64 --init openrc`)
  // qemu and mke2fs, from the snapshot the lock is resolved from, on the environment image.
  const { mirror, suite } = sources()
  const base = `${environment().image}:amd64`
  const tag = `ai-agent/mica-system-base-qemu:${new Bun.CryptoHasher('sha256').update(capture(['docker', 'image', 'inspect', '--format', '{{.Id}}', base]).stdout + mirror).digest('hex').slice(0, 16)}`
  const work = scratch('boot-test')
  try {
    if (capture(['docker', 'image', 'inspect', tag]).code !== 0) {
      writeFileSync(join(work, 'Dockerfile'), [
        'ARG BASE',
        'FROM ${BASE}',
        'ARG MIRROR',
        'ARG SUITE',
        'RUN echo "deb [check-valid-until=no] ${MIRROR} ${SUITE} main" >/tmp/snapshot.list && \\',
        '    apt-get -o Dir::Etc::SourceList=/tmp/snapshot.list -o Dir::Etc::SourceParts=- update -qq && \\',
        '    DEBIAN_FRONTEND=noninteractive apt-get -o Dir::Etc::SourceList=/tmp/snapshot.list -o Dir::Etc::SourceParts=- \\',
        '        install -y -qq --no-install-recommends qemu-system-x86 e2fsprogs >/dev/null && \\',
        '    rm -rf /var/lib/apt/lists/* /tmp/snapshot.list',
        '',
      ].join('\n'))
      if (attached(['docker', 'build', '--label', 'ai-agent=true', '-t', tag, '--build-arg', `BASE=${base}`, '--build-arg', `MIRROR=${mirror}`, '--build-arg', `SUITE=${suite}`, work]) !== 0)
        fail('building the boot test image failed')
    }
    // From the source cache when it holds the kernel; otherwise fetched into this run's
    // own directory, since the cache belongs to the containers that fill it.
    const kernel = selectSource(REPO, 'test-kernel')
    try {
      copyFileSync(reposLookup(join(REPO, 'repos'), kernel.sha256), join(work, 'kernel.deb'))
    }
    catch {
      await reposGet(join(work, 'repos'), kernel.sha256, kernel.url, join(work, 'kernel.deb'))
    }
    for (const [path, content] of Object.entries(BOOT_TEST_OVERLAY)) {
      mkdirSync(dirname(join(work, 'overlay', path)), { recursive: true })
      writeFileSync(join(work, 'overlay', path), content)
    }
    writeFileSync(join(work, 'init'), BOOT_TEST_INIT)
    const args = ['docker', 'run', '--rm', '--label', 'ai-agent=true', '--network', 'none',
      '-v', `${hostPath(work)}:/work`, '-v', `${hostPath(root)}:/rootfs:ro`]
    if (existsSync('/dev/kvm'))
      args.push('--device', '/dev/kvm')
    const code = attached([...args, tag, 'bash', '-c', BOOT_TEST_SCRIPT])
    const log = existsSync(join(work, 'serial.log')) ? readFileSync(join(work, 'serial.log'), 'utf8') : ''
    writeFileSync(join(REPO, '_out/boot-test.log'), log)
    if (code !== 0)
      fail(`the boot test ended with ${code} (a timeout is 124); the serial log is in _out/boot-test.log`)
    const missing = BOOT_TEST_EXPECT.filter(line => !log.includes(line))
    if (missing.length)
      fail(`the serial log lacks: ${missing.join('; ')} (_out/boot-test.log)`)
    // No daemon keeps CAP_SYS_RESOURCE (capability 24), the DATA quota limit.
    const bounding = /boot-test: dbus-daemon CapBnd:\s*([0-9a-f]+)/.exec(log)?.[1]
    if (!bounding || (BigInt(`0x${bounding}`) >> 24n) & 1n)
      fail(`dbus-daemon's bounding set is ${bounding ?? 'unreported'}; a daemon keeps CAP_SYS_RESOURCE (_out/boot-test.log)`)
    console.log('RESULT: PASS (the x64 OpenRC root boots, confirms its deployment and shuts down)')
    return 0
  }
  finally {
    removeTree(work)
  }
}

if (import.meta.main) {
  try {
    if (process.argv[2] === 'debs') {
      process.exitCode = await debs(process.argv.slice(3))
    }
    else if (process.argv[2] === 'environment') {
      process.exitCode = await pullEnvironment()
    }
    else if (process.argv[2] === 'boot-test') {
      process.exitCode = await bootTest(process.argv.slice(3))
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
