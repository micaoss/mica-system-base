// Host entry: runs src/cli.ts in the environment image, via BuildKit for a foreign architecture.
import type { Options } from './args.ts'
import type { Arch, ImageArch, Row } from './lock.ts'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { reposGet, reposLookup, verifyLocks } from '@mica/build-tools'
import { parse, resolvePath, USAGE } from './args.ts'
import { nonDirectories } from './bootstrap.ts'
import { buildDebs, declared } from './debs/docker.ts'
import { fail, report } from './errors.ts'
import { attached, capture } from './exec.ts'
import { ARCHES, hostArch, IMAGE_ARCHES, imageArch, keepUrls, lockRows, parseRows, SELECTIONS, selectRuntime, selectSource, sourceRows, UPSTREAM_LOCK, UPSTREAM_PKGS } from './lock.ts'
import { addedNames, inputRoots, runtimeRoots, tagUpstream } from './pin-inputs.ts'
import { assertEnvironmentImage, environment, REPO, sources } from './pins.ts'
import { buildTime, releaseOf } from './release.ts'
import type { Init } from './rootfs.ts'
import { basePackages, HOSTNAME, initRoots, INITS, installedPackages, ISSUE_ENV } from './rootfs.ts'

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

function imageFor(arch: ImageArch): string {
  const image = `${environment().image}:${arch}`
  if (capture(['docker', 'image', 'inspect', image]).code !== 0)
    fail(`${image} is missing; run: bun src/container.ts environment`)
  return image
}

interface Run {
  arch: ImageArch
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
  arch: ImageArch
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
    // armhf is bootstrapped in the amd64 image, its maintainer scripts run through
    // the host's binfmt emulation.
    const image = imageArch(arch)
    if (image === hostArch()) {
      const code = dockerRun({
        arch: image,
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
    if (arch !== image)
      fail(`the ${arch} root is bootstrapped on an ${image} host`)
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
        arch: image,
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
  if (!options.foreign && arch === 'armhf')
    fail(`the armhf ${what} are not resolved: armhf has no environment image`)
  const work = scratch(`pins-${arch}`)
  const command = cli('pin-inputs', '--arch', arch, ...args, '--output', '/out/pins.tsv')
  try {
    if (options.foreign || arch === hostArch()) {
      mkdirSync(join(work, 'out'))
      const code = dockerRun({
        arch: hostArch(),
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
        arch: arch as ImageArch,
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
// of the inputs debs/ declares, for the architectures that build the packages
// that take them; the build.<package>.<name> rows of each package's build closure,
// for the architectures it is built for; the runtime rows of each architecture's
// root at the snapshot of locks/sources.json,
// and the rows of the closure of locks/upstream.pkgs beyond the root, with their
// locks/packages.tsv lines, each tagged upstream-<root> for the roots that need it; the
// source rows stay. A row that resolves to the version and sha256 it had keeps its
// URL. --check only compares.
async function pinInputs(check: boolean): Promise<void> {
  const resolved: string[][] = []
  // An `all` package takes its inputs on each environment image's architecture, which
  // builds it; an architecture's own package takes its own. An input is one or the
  // other, so its rows are those architectures' alone.
  const packages = declared(REPO)
  const ofAll = new Set(packages.filter(entry => entry.arches.includes('all')).flatMap(entry => entry.inputs))
  const shared = [...ofAll].filter(name => packages.some(entry => !entry.arches.includes('all') && entry.inputs.includes(name)))
  if (shared.length)
    fail(`${shared.join(', ')} is an input of an \`all\` package and of an architecture's own`)
  const inputs = new Map<Arch, Row[]>()
  for (const arch of ARCHES.filter(each => inputRoots(packages, each).length)) {
    const rows = await runPinInputs(arch, 'inputs', [], { foreign: true })
    const missing = inputRoots(packages, arch).filter(name => !rows.some(row => row.name === name))
    if (missing.length)
      fail(`the snapshot resolved no ${missing.join(', ')} for ${arch}`)
    inputs.set(arch, rows)
  }
  const pick = (keep: (name: string) => boolean, arches: Arch[]): Map<Arch, Row[]> =>
    new Map([...inputs].filter(([arch]) => arches.includes(arch)).map(([arch, rows]) => [arch, rows.filter(row => keep(row.name))]))
  resolved.push(...lockRows('input.', pick(name => ofAll.has(name), IMAGE_ARCHES)))
  for (const arch of ARCHES)
    resolved.push(...lockRows('input.', pick(name => !ofAll.has(name), [arch])))
  for (const entry of declared(REPO).filter(candidate => candidate.build.length)) {
    const build = new Map<Arch, Row[]>()
    for (const arch of entry.arches.includes('all') ? IMAGE_ARCHES : entry.arches as Arch[])
      build.set(arch, await runPinInputs(arch, `build packages of debs/${entry.name}`, ['--package', entry.name], { image: environment().c[imageArch(arch)] }))
    resolved.push(...lockRows(`build.${entry.name}.`, build))
  }
  // The runtime rows, again at the snapshot: the same names, whose versions may move
  // but whose closure may not grow without locks/packages.tsv naming the new package.
  const runtime = new Map<Arch, Row[]>()
  for (const arch of ARCHES) {
    const rows = await runPinInputs(arch, 'runtime packages', ['--all'], { foreign: true })
    const added = addedNames(runtimeRoots(arch), rows.map(row => row.name))
    if (added.length)
      fail(`the snapshot's versions add ${added.join(', ')} to the ${arch} root; name their consumer in ${SELECTIONS} first`)
    runtime.set(arch, rows)
  }
  resolved.push(...lockRows('', runtime))
  const root = new Set(ARCHES.flatMap(arch => runtimeRoots(arch)))
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
  resolved.push(...lockRows('', new Map([...upstream].map(([arch, rows]) => [arch, rows.filter(row => !runtimeRoots(arch).includes(row.name))]))))
  const lockFile = join(REPO, UPSTREAM_LOCK)
  const selectionFile = join(REPO, SELECTIONS)
  const selected = tagUpstream(new Map(readFileSync(selectionFile, 'utf8').split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split('\t') as [string, string])), roots)
  const upstreamOnly = (name: string): boolean => selected.get(name)?.split(',').every(consumer => consumer.startsWith('upstream-')) ?? false
  const regenerated = (name: string): boolean => name.startsWith('input.') || name.startsWith('build.') || upstreamOnly(name) || root.has(name)
  const previous = readFileSync(lockFile, 'utf8').split('\n').filter(line => line.startsWith('source\t')).map(line => line.split('\t'))
  const rows = [...sourceRows(REPO).filter(([name = '']) => !regenerated(name)).map(row => ['source', ...row]), ...keepUrls(resolved, previous)]
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
      fail(`usage: bun src/container.ts rootfs --arch ${ARCHES.join('|')} [--init ${Object.keys(INITS).join('|')}] [--root DIR] [--pool DIR] [--cache-dir DIR]`)
    values.set(option, value)
  }
  const arch = values.get('--arch') as Arch
  if (!(ARCHES as string[]).includes(arch))
    fail(`rootfs requires --arch ${ARCHES.join(', ')}`)
  const init = values.get('--init') as Init | undefined
  if (init !== undefined && !Object.hasOwn(INITS, init))
    fail(`--init ${init} is not ${Object.keys(INITS).join(' or ')}`)
  const packages = [...basePackages(arch), ...(init ? INITS[init].packages : [])]
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
    writeFileSync(selection, `${[...packages, ...(init ? initRoots(init, arch).map(name => `upstream-${name}`) : [])].join('\n')}\n`)
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
  for (const arch of IMAGE_ARCHES) {
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
    fail(`cache is missing: ${cacheDir}; run: bun src/container.ts cache --arch <arch> --all for each architecture`)
  if (!only.length)
    rmSync(arch ? join(out, arch) : out, { recursive: true, force: true })
  const native = hostArch()
  if (arch === 'armhf' && native !== imageArch(arch))
    fail(`armhf is cross-compiled on an ${imageArch(arch)} host`)
  const built = buildDebs({
    repo: REPO,
    cacheDir,
    out,
    builder: builder(),
    image: environment().base[native],
    cImage: arch => environment().c[imageArch(arch)],
    native,
    repository: releaseOf(REPO).repository,
  }, only, arch)
  console.log(`debs: ${built.join(', ')}`)
  return 0
}

// The OpenRC root of x64 booted under QEMU with the Debian kernel the lock pins for
// this test (source.test-kernel): a read-only root disk made from
// _out/rootfs/amd64-openrc, a fresh DATA disk with project quotas and a service
// account on STATE, and an initramfs that loads the modules this kernel keeps out
// of its image -- virtio_blk, the quota format DATA's project quotas need, the ACPI
// power button and evdev -- and hands over to openrc-init. A stand-in mica-deploy
// reports a deployment, and the health gate's confirmation starts the checks
// below, so the run covers the boot, the gate and the shutdown. The root carries
// mica-openssh, as built, and its libraries: before the shutdown the stand-in saves
// SSH settings as micad would and has mica-sshd-boot start mica-sshd from them, as a
// boot does, and the host logs in through QEMU's forwarded port with
// a key, as root and as mica, and as a login account the stand-in adds as a
// provisioning agent would, whose key in /run/mica/authorized-keys opens neither root
// nor mica. The run ends with QEMU's power button, which mica-acpid turns into a
// clean poweroff. The serial log is kept in _out/boot-test.log, the host's side of
// the logins in _out/boot-test-ssh.log.
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
    '  if [ -e /var/lib/mica/boot-test-second ]; then exec /usr/local/bin/boot-test-logs; fi',
    '  for p in /proc/[0-9]*; do [ "$(cat $p/comm 2>/dev/null)" = dbus-daemon ] && sed -n "s/^CapBnd:/boot-test: dbus-daemon CapBnd:/p" $p/status >/dev/console; done',
    '  { ip -4 addr show dev eth0; cat /etc/resolv.conf /etc/hosts; } | sed "s/^/boot-test: /" >/dev/console',
    '# The service account DATA came with, bound at boot by mica-accounts build, and resolved by uid.',
    '  : >/run/boot-test-uid && chown 30001 /run/boot-test-uid && echo "boot-test: uid 30001 is $(stat -c %U /run/boot-test-uid)" >/dev/console',
    '# A service account, added live, and resolved by name.',
    '  /usr/lib/mica/mica-accounts add boottest 30000 && id boottest | sed "s/^/boot-test: /" >/dev/console',
    '# micad\'s device code, written as micad writes it: the prompt mica-getty started before',
    '# the gate (after *) shows nothing of it; the prompt it starts again shows it.',
    '  sleep 2',
    '  printf \'Device code: TEST-0000-ABC\\n\\n\' >/run/mica/device-code.issue.new && mv /run/mica/device-code.issue.new /run/mica/device-code.issue',
    '# SSH through mica-openssh: micad\'s saved settings and the authorized keys of root and',
    '# mica, as micad writes them, then mica-sshd-boot, which started nothing at boot, starts',
    '# mica-sshd from them; the host logs in as both and says when it is done.',
    '  mkdir -p /var/lib/mica/ssh && printf \'SSH_ENABLED=yes\\nSSH_LISTEN="22"\\nSSH_PASSWORD=no\\nSSH_ROOT_LOGIN=yes\\n\' >/var/lib/mica/ssh/sshd.env',
    '  for home in /root /home/mica; do mkdir -p -m 0700 $home/.ssh && cp /usr/local/share/boot-test/client.pub $home/.ssh/authorized_keys && chmod 0600 $home/.ssh/authorized_keys; done',
    '  chown -R mica:mica /home/mica/.ssh',
    '# A login account, added as a provisioning agent (mica-gce-agent) adds one, before sshd',
    '# starts; its key, and another for root and mica, where the agent writes them.',
    '  echo "boot-test: add-login gcpuser: $(/usr/lib/mica/mica-accounts add-login gcpuser --admin 2>&1)" >/dev/console',
    '  echo "boot-test: add-login gcpplain: $(/usr/lib/mica/mica-accounts add-login gcpplain 2>&1)" >/dev/console',
    '  rc-service mica-sshd-boot restart >/dev/null 2>&1 && rc-service mica-sshd status >/dev/null 2>&1 && echo \'boot-test: mica-sshd started\' >/dev/console',
    '  for user in gcpuser gcpplain; do install -m 0644 /usr/local/share/boot-test/client.pub /run/mica/authorized-keys/$user; done',
    '  for user in root mica; do install -m 0644 /usr/local/share/boot-test/agent.pub /run/mica/authorized-keys/$user; done',
    '# Then the host\'s power button ends the run: mica-acpid powers off.',
    '  (i=0; while [ ! -e /run/boot-test-ssh-done ] && [ $i -lt 180 ]; do sleep 1; i=$((i + 1)); done',
    '   logread | grep mica-sshd | sed \'s/^/boot-test: sshd log: /\' >/dev/console',
    '   /usr/local/bin/boot-test-logs first',
    '   rc-service mica-getty restart; sleep 5',
    '   rc-service mica-acpid status >/dev/null 2>&1 && echo \'boot-test: waiting for the power button\' >/dev/console) >/dev/null 2>&1 & ;;',
    '*) exit 1 ;;',
    'esac',
    '',
  ].join('\n'),
  // The log checks. The first boot logs a marker in the image's settings (the log on
  // DATA); the second finds it in the previous boot, then sets the smallest cap and a
  // collector on the host (10.0.2.2, QEMU's user network), floods the log past the cap
  // and powers off.
  'usr/local/bin/boot-test-logs': String.raw`#!/bin/sh
syslogd() {
  for p in /proc/[0-9]*; do
    line=$(cat "$p/cmdline" 2>/dev/null | tr '\0' ' ')
    case "$line" in *supervise-daemon*) ;; *'syslogd -n '*) echo "boot-test: syslogd: $line" ;; esac
  done
}
if [ "$#" = 1 ]; then
  syslogd >/dev/console
  busybox logger -t boot-test first-boot-marker
  touch /var/lib/mica/boot-test-second
  exit 0
fi
{
  echo "boot-test: previous boot markers: $(logread -b -1 | grep -c first-boot-marker)"
  echo "boot-test: this boot markers: $(logread -b 0 | grep -c first-boot-marker)"
  mkdir -p /var/lib/mica/log
  printf 'LOG_MAX_KIB=8192\nLOG_REMOTE=10.0.2.2:5514\n' >/var/lib/mica/log/log.env
  rc-service mica-syslogd restart >/dev/null 2>&1
  syslogd
  busybox logger -t boot-test forwarded-marker
  seq 1 120000 | sed 's/$/ flood padding padding padding padding padding padding padding padding/' | busybox logger -t flood
  sleep 2
  sync
  echo "boot-test: log files: $(cd /var/log && ls messages* | tr '\n' ' ')"
  echo "boot-test: log KiB: $(du -ck /var/log/messages* | tail -n 1 | cut -f 1)"
} >/dev/console 2>&1
openrc-shutdown --poweroff now
`,
  // The console option's login, for mica-getty to start agetty on ttyS0; nobody logs in.
  'usr/bin/login': '#!/bin/sh\nexit 1\n',
}

const BOOT_TEST_INIT = [
  '#!/bin/busybox sh',
  'B=/bin/busybox',
  '$B mkdir -p /proc /sys /dev /newroot',
  '$B mount -t proc proc /proc',
  '$B mount -t sysfs sysfs /sys',
  '$B mount -t devtmpfs devtmpfs /dev',
  'for module in virtio_blk quota_tree quota_v2 failover net_failover virtio_net button evdev; do $B insmod /$module.ko; done',
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
for module in fs/quota/quota_tree fs/quota/quota_v2 net/core/failover drivers/net/net_failover drivers/net/virtio_net drivers/acpi/button drivers/input/evdev; do
  xz -dc "kernel/usr/lib/modules/$version/kernel/$module.ko.xz" >"initrd/\${module##*/}.ko"
done
install -m 0755 init initrd/init
(cd initrd && find . | /rootfs/usr/bin/busybox cpio -o -H newc 2>/dev/null) | gzip -9 >initrd.img
cp -a /rootfs root
cp -a overlay/. root/
# The options the boot logs in through: mica-openssh, mica-sudo and what they add to
# the root, with a key the host logs in with.
dpkg --root=root --install ssh/*.deb >/dev/null
mkdir -p root/usr/local/share/boot-test
ssh-keygen -q -t ed25519 -N '' -f client
cp client.pub root/usr/local/share/boot-test/client.pub
# The key an agent puts for root and mica, which must open neither.
ssh-keygen -q -t ed25519 -N '' -f agent
cp agent.pub root/usr/local/share/boot-test/agent.pub
# What mica-build's pack stage does: the factory copy mica-shadow-reconcile builds from,
# and /etc/shadow its RAM file, which mica-accounts adds to.
mkdir -p root/usr/share/factory/etc
cp -a root/etc/shadow root/usr/share/factory/etc/shadow
ln -sfn /run/mica/shadow root/etc/shadow
chmod 0755 root/usr/local/bin/mica-deploy root/usr/local/bin/boot-test-logs root/usr/bin/login
mke2fs -q -t ext4 -L root -d root root.img 768M
# DATA as a device that already has a service account on STATE, for the boot to bind.
mkdir -p data/state/accounts
# A device from before the RSA host key: STATE holds only the ed25519 one, which
# mica-sshd keeps, adding the RSA key beside it.
mkdir -p -m 0700 data/state/ssh
ssh-keygen -q -t ed25519 -N '' -C '' -f seeded
cp seeded data/state/ssh/ssh_host_ed25519_key
printf 'bootseed:x:30001:30001:mica service bootseed:/nonexistent:/usr/sbin/nologin\\n' >data/state/accounts/passwd
printf 'bootseed:x:30001:\\n' >data/state/accounts/group
mke2fs -q -t ext4 -L data -O quota,project -E quotatype=prjquota -d data data.img 512M
accel=tcg; [ -c /dev/kvm ] && accel=kvm
# The monitor, for the power button: commands into monitor.in, its answers drained.
mkfifo monitor.in monitor.out
cat monitor.out >monitor.log &
timeout 600 qemu-system-x86_64 -machine q35,accel=$accel -cpu max -m 1024 -smp 2 \\
  -display none -no-reboot -serial file:serial.log -nic user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:2222-:22 \\
  -monitor pipe:monitor \\
  -kernel "kernel/boot/vmlinuz-$version" -initrd initrd.img -append 'console=ttyS0 panic=-1' \\
  -drive file=root.img,if=virtio,format=raw,readonly=on -drive file=data.img,if=virtio,format=raw &
qemu=$!
# Once the guest has started mica-sshd: a key login as root and as mica, then the word
# that lets it shut down.
for i in $(seq 400); do grep -q 'boot-test: mica-sshd started' serial.log 2>/dev/null && break; kill -0 $qemu 2>/dev/null || break; sleep 1; done
ssh="ssh -p 2222 -i client -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=20"
for user in root mica gcpuser gcpplain; do $ssh $user@127.0.0.1 'echo "ssh-login: $(id) home $HOME $(stat -c "%U %a" "$HOME")"' >>ssh.log 2>&1 || echo "ssh-login: $user failed" >>ssh.log; done
# sudo for the login admins: root only while micad's switch renders its rule in
# /run/mica/sudoers.d, and only for a member of mica-admins. Each step a new session.
sudo_as() { # <step> <user>
  $ssh $2@127.0.0.1 'echo "$(id -un) $(sudo -n id -u 2>&1 | tr "\\n" " ")"' 2>/dev/null | sed "s/^/ssh-sudo-$1: /" >>ssh.log || echo "ssh-sudo-$1: $2 failed" >>ssh.log
}
as_root() { $ssh root@127.0.0.1 "$1" >/dev/null 2>&1 || echo "ssh-sudo: '$1' failed" >>ssh.log; }
sudo_as norule gcpuser
sudo_as norule gcpplain
as_root 'mkdir -p -m 0755 /run/mica/sudoers.d && echo "%mica-admins ALL=(ALL:ALL) NOPASSWD: ALL" >/run/mica/sudoers.d/50-mica-admins && chmod 0440 /run/mica/sudoers.d/50-mica-admins'
sudo_as rule gcpuser
sudo_as rule gcpplain
as_root '/usr/lib/mica/mica-accounts add-login gcpuser'
sudo_as demoted gcpuser
as_root '/usr/lib/mica/mica-accounts add-login gcpuser --admin'
sudo_as promoted gcpuser
as_root 'rm /run/mica/sudoers.d/50-mica-admins'
sudo_as removed gcpuser
sudo_as removed gcpplain
# Host keys: a default client takes the device's kept ed25519 key; a client offering
# only rsa-sha2-256,ssh-rsa (GCE's SSH-in-browser) the RSA key, with an RSA key of its
# own; and one offering only diffie-hellman-group14-sha256 still agrees a key exchange.
ssh-keygen -q -t rsa -b 3072 -N '' -f clientrsa
as_root "echo '$(cat clientrsa.pub)' >>/run/mica/authorized-keys/gcpuser"
hostkey() { # <step> <ssh options...>
  step=$1; shift
  ssh -v -p 2222 -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=20 "$@" gcpuser@127.0.0.1 'echo "ssh-hostkey-'$step': $(id -un) in"' >hostkey.log 2>&1 || echo "ssh-hostkey-$step: failed" >>ssh.log
  grep -E '^ssh-hostkey-|kex: (algorithm|host key algorithm):' hostkey.log | tr -d '\\r' | sed "s/^debug1: /ssh-hostkey-$step: /" >>ssh.log
}
hostkey default -i client
hostkey browser -i clientrsa -o HostKeyAlgorithms=rsa-sha2-256,ssh-rsa -o PubkeyAcceptedAlgorithms=rsa-sha2-256,ssh-rsa
hostkey group14 -i client -o KexAlgorithms=diffie-hellman-group14-sha256
ssh-keyscan -t ed25519 -p 2222 127.0.0.1 2>&1 | tee -a ssh.log | awk '/ssh-ed25519/ {print $2, $3}' >served.pub
[ -s served.pub ] && [ "$(cat served.pub)" = "$(cut -d' ' -f1,2 seeded.pub)" ] && echo "ssh-hostkey-kept: yes" >>ssh.log || echo "ssh-hostkey-kept: no" >>ssh.log
# Each host key's public half beside it on STATE, root's and 0644, as served: the
# seeded ed25519 key came without one, the RSA key was made at this boot.
for type in ed25519 rsa; do
  pub=$($ssh root@127.0.0.1 "stat -c '%a %U' /mnt/data/state/ssh/ssh_host_\${type}_key.pub && cut -d' ' -f1,2 /mnt/data/state/ssh/ssh_host_\${type}_key.pub" 2>/dev/null | tr '\\n' ' ')
  served=$(ssh-keyscan -t $type -p 2222 127.0.0.1 2>/dev/null | awk '!/^#/ {print $2, $3}')
  [ -n "$served" ] && [ "$pub" = "644 root $served " ] && echo "ssh-hostkey-pub-$type: yes" >>ssh.log || echo "ssh-hostkey-pub-$type: no ($pub)" >>ssh.log
done
# The agent's key for root and mica opens neither.
for user in root mica; do
  ssh -p 2222 -i agent -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=20 $user@127.0.0.1 true >/dev/null 2>&1 &&
    echo "ssh-agent-key: $user opened" >>ssh.log || echo "ssh-agent-key: $user refused" >>ssh.log
done
# A login on a terminal is the one sshd records, in wtmpdb's /var/lib/wtmpdb/wtmp.db.
$ssh -tt root@127.0.0.1 true >/dev/null 2>&1 || echo "ssh-login: root on a terminal failed" >>ssh.log
$ssh root@127.0.0.1 'ls -lL /var/lib/wtmpdb/wtmp.db 2>&1 | sed "s/^/ssh-wtmpdb: /"; touch /run/boot-test-ssh-done' >>ssh.log 2>&1 || true
# The power button, once mica-acpid runs; the guest powers itself off.
for i in $(seq 120); do grep -q 'boot-test: waiting for the power button' serial.log 2>/dev/null && break; kill -0 $qemu 2>/dev/null || break; sleep 1; done
echo system_powerdown >monitor.in
wait $qemu
# The second boot on the same DATA, with a syslog collector on the host's port 5514.
socat -u UDP-RECV:5514,bind=127.0.0.1 OPEN:remote.log,creat,append &
collector=$!
timeout 600 qemu-system-x86_64 -machine q35,accel=$accel -cpu max -m 1024 -smp 2 \\
  -display none -no-reboot -serial file:serial2.log -nic user,model=virtio-net-pci \\
  -kernel "kernel/boot/vmlinuz-$version" -initrd initrd.img -append 'console=ttyS0 panic=-1' \\
  -drive file=root.img,if=virtio,format=raw,readonly=on -drive file=data.img,if=virtio,format=raw
kill $collector
`

// The expectations of the boot test's serial log.
const BOOT_TEST_EXPECT = [
  'mica-health: booted slot 0000000000000000000000000000000000000000000000000000000000000000 marked good',
  'mica-health: no failed units',
  'Unbinding DATA',
  // QEMU's user network: a DHCP lease on eth0 and its DNS server in /etc/resolv.conf.
  'inet 10.0.2.15/24',
  'boot-test: nameserver 10.0.2.3',
  // /etc/hosts, written to /run/mica/hosts at boot: localhost and the hostname.
  'boot-test: 127.0.0.1\tlocalhost',
  `boot-test: 127.0.1.1\t${HOSTNAME}`,
  // mica-accounts: the service account on STATE bound at boot, and one added live, over
  // /etc/passwd and /etc/group.
  'boot-test: uid 30001 is bootseed',
  'boot-test: uid=30000(boottest) gid=30000(boottest)',
  // mica-openssh: mica-sshd started from micad's settings.
  'boot-test: mica-sshd started',
  // A login account of mica-accounts add-login, the first uid of its range.
  'boot-test: add-login gcpuser: 20000',
  'boot-test: add-login gcpplain: 20001',
  // The power button: mica-acpid, then the shutdown it starts.
  'boot-test: waiting for the power button',
]

// The options the boot test installs, as built: SSH and the privilege of login admins.
const BOOT_TEST_OPTIONS = ['mica-openssh', 'mica-sudo']

// The pinned rows the options' Depends add to `root`: the closure of each root
// locks/upstream.pkgs pins for later stages, less what the root has installed.
function optionRows(root: string): Row[] {
  const depends = BOOT_TEST_OPTIONS.flatMap((name) => {
    const control = readFileSync(join(REPO, 'debs', name, 'control'), 'utf8')
    return (/^Depends: (.*)$/m.exec(control)?.[1] ?? '').split(', ').map(dependency => `upstream-${dependency}`)
  })
  const installed = new Set(installedPackages(root))
  return selectRuntime(REPO, 'amd64', { kind: 'all' }).filter(row => !installed.has(row.name) && row.consumers.some(consumer => depends.includes(consumer)))
}

// qemu, mke2fs and the ssh client, from the snapshot the lock is resolved from, on the
// environment image; built into `work` when the tag is missing.
function qemuImage(work: string): string {
  const { mirror, suite } = sources()
  const base = `${environment().image}:amd64`
  const tools = 'qemu-system-x86 e2fsprogs openssh-client socat'
  const tag = `ai-agent/mica-system-base-qemu:${new Bun.CryptoHasher('sha256').update(capture(['docker', 'image', 'inspect', '--format', '{{.Id}}', base]).stdout + mirror + tools).digest('hex').slice(0, 16)}`
  if (capture(['docker', 'image', 'inspect', tag]).code !== 0) {
    writeFileSync(join(work, 'Dockerfile'), [
      'ARG BASE',
      'FROM ${BASE}',
      'ARG MIRROR',
      'ARG SUITE',
      'RUN echo "deb [check-valid-until=no] ${MIRROR} ${SUITE} main" >/tmp/snapshot.list && \\',
      '    apt-get -o Dir::Etc::SourceList=/tmp/snapshot.list -o Dir::Etc::SourceParts=- update -qq && \\',
      '    DEBIAN_FRONTEND=noninteractive apt-get -o Dir::Etc::SourceList=/tmp/snapshot.list -o Dir::Etc::SourceParts=- \\',
      `        install -y -qq --no-install-recommends ${tools} >/dev/null && \\`,
      '    rm -rf /var/lib/apt/lists/* /tmp/snapshot.list',
      '',
    ].join('\n'))
    if (attached(['docker', 'build', '--label', 'ai-agent=true', '-t', tag, '--build-arg', `BASE=${base}`, '--build-arg', `MIRROR=${mirror}`, '--build-arg', `SUITE=${suite}`, work]) !== 0)
      fail('building the boot test image failed')
  }
  return tag
}

// The Debian kernel the lock pins for the boot tests, as work/kernel.deb: from the
// source cache when it holds it; otherwise fetched into this run's own directory,
// since the cache belongs to the containers that fill it.
async function testKernel(work: string): Promise<void> {
  const kernel = selectSource(REPO, 'test-kernel')
  try {
    copyFileSync(reposLookup(join(REPO, 'repos'), kernel.sha256), join(work, 'kernel.deb'))
  }
  catch {
    await reposGet(join(work, 'repos'), kernel.sha256, kernel.url, join(work, 'kernel.deb'))
  }
}

// The systemd root of x64 booted under QEMU, for the user's mounts: an initramfs
// mounts DATA at /mnt/data before PID 1, as the runkit does, and hands over to
// systemd. DATA's unit directory holds three user units: srv.mount, on a disk of the
// user's (labelled usersrv), and var-mnt-scratch.mount, both allowed, and
// mnt-usb.mount, refused. mica-user-mounts-generator must load srv.mount early in
// place of the root's bind, the other allowed one in its normal directory, and mask
// the refused one; a test unit prints the mounts and the units' states to the
// console and powers off. The serial log is kept in _out/boot-test-systemd.log.
const SYSTEMD_BOOT_TEST_OVERLAY: Record<string, string> = {
  'etc/systemd/system/boot-test.service': [
    '[Unit]',
    'Description=Report the mounts for the boot test, then power off',
    'After=multi-user.target',
    '',
    '[Service]',
    'Type=oneshot',
    'ExecStart=/usr/local/bin/boot-test-mounts',
    '',
  ].join('\n'),
  'usr/local/bin/boot-test-mounts': String.raw`#!/bin/sh
{
  for target in /srv /var/mnt/scratch /mica /home /root /var/lib/mica /var; do
    awk -v t="$target" '$5 == t { for (i = 7; $i != "-"; i++) ; line = "boot-test: mount " t " " $(i + 2) " " $6 } END { if (line) print line }' /proc/self/mountinfo
  done
  for unit in srv.mount var-mnt-scratch.mount mnt-usb.mount; do
    echo "boot-test: unit $unit $(systemctl show -P LoadState $unit) $(systemctl show -P ActiveState $unit) $(systemctl show -P FragmentPath $unit)"
  done
  echo "boot-test: marker $(cat /srv/marker 2>&1)"
  dmesg | grep -o 'mica-user-mounts-generator: .*' | sed 's/^/boot-test: kmsg /'
  echo 'boot-test: done'
} >/dev/console 2>&1
systemctl --no-block poweroff
`,
}

const SYSTEMD_BOOT_TEST_UNITS: Record<string, string> = {
  'srv.mount': '[Unit]\nDescription=/srv on the user\'s disk\n[Mount]\nWhat=/dev/disk/by-label/usersrv\nWhere=/srv\nType=ext4\nOptions=nosuid,nodev,noatime\n[Install]\nWantedBy=local-fs.target\n',
  'var-mnt-scratch.mount': '[Unit]\nDescription=A scratch tmpfs of the user\'s\n[Mount]\nWhat=tmpfs\nWhere=/var/mnt/scratch\nType=tmpfs\nOptions=nosuid,nodev,size=8M\n[Install]\nWantedBy=local-fs.target\n',
  'mnt-usb.mount': '[Unit]\nDescription=A mount outside the user\'s trees\n[Mount]\nWhat=tmpfs\nWhere=/mnt/usb\nType=tmpfs\n[Install]\nWantedBy=local-fs.target\n',
}

const SYSTEMD_BOOT_TEST_INIT = [
  '#!/bin/busybox sh',
  'B=/bin/busybox',
  '$B mkdir -p /proc /sys /dev /newroot',
  '$B mount -t proc proc /proc',
  '$B mount -t sysfs sysfs /sys',
  '$B mount -t devtmpfs devtmpfs /dev',
  '$B insmod /virtio_blk.ko',
  'for i in $($B seq 50); do [ -b /dev/vdc ] && break; $B sleep 0.1; done',
  '$B mount -o ro /dev/vda /newroot',
  // DATA, as the runkit mounts it before PID 1.
  '$B mount -o noatime /dev/vdb /newroot/mnt/data',
  '$B umount /proc /sys /dev',
  'exec $B switch_root /newroot /lib/systemd/systemd',
  '',
].join('\n')

const SYSTEMD_BOOT_TEST_SCRIPT = `set -eu
cd /work
dpkg-deb -x kernel.deb kernel
version=$(ls kernel/usr/lib/modules)
mkdir -p initrd/bin
cp /rootfs/usr/bin/busybox initrd/bin/busybox
xz -dc "kernel/usr/lib/modules/$version/kernel/drivers/block/virtio_blk.ko.xz" >initrd/virtio_blk.ko
install -m 0755 init initrd/init
(cd initrd && find . | /rootfs/usr/bin/busybox cpio -o -H newc 2>/dev/null) | gzip -9 >initrd.img
cp -a /rootfs root
cp -a overlay/. root/
chmod 0755 root/usr/local/bin/boot-test-mounts
ln -s /etc/systemd/system/boot-test.service root/etc/systemd/system/multi-user.target.wants/boot-test.service
# No deployment to confirm here.
ln -sfn /dev/null root/etc/systemd/system/mica-health.service
mke2fs -q -t ext4 -L root -d root root.img 768M
mkdir -p data/state/systemd-units/local-fs.target.wants
cp units/* data/state/systemd-units/
for unit in units/*; do ln -s "../\${unit##*/}" "data/state/systemd-units/local-fs.target.wants/\${unit##*/}"; done
mke2fs -q -t ext4 -L data -d data data.img 256M
mkdir user && echo user-disk >user/marker
mke2fs -q -t ext4 -L usersrv -d user user.img 32M
accel=tcg; [ -c /dev/kvm ] && accel=kvm
timeout 300 qemu-system-x86_64 -machine q35,accel=$accel -cpu max -m 1024 -smp 2 \\
  -display none -no-reboot -serial file:serial.log -nic none \\
  -kernel "kernel/boot/vmlinuz-$version" -initrd initrd.img -append 'console=ttyS0 panic=-1' \\
  -drive file=root.img,if=virtio,format=raw,readonly=on -drive file=data.img,if=virtio,format=raw \\
  -drive file=user.img,if=virtio,format=raw
`

// The serial log's lines: the user's srv.mount in place of the root's bind, from the
// generator's early directory and on the user's disk; the other allowed one from its
// normal directory; the refused one masked and logged; the binds of DATA nosuid,nodev.
const SYSTEMD_BOOT_TEST_EXPECT = [
  /^boot-test: mount \/srv \/dev\/vdc rw,nosuid,nodev,noatime$/m,
  /^boot-test: mount \/var\/mnt\/scratch tmpfs rw,nosuid,nodev,/m,
  /^boot-test: mount \/mica \/dev\/vdb rw,nosuid,nodev\b/m,
  /^boot-test: mount \/home \/dev\/vdb rw,nosuid,nodev\b/m,
  /^boot-test: mount \/root \/dev\/vdb rw,nosuid,nodev\b/m,
  /^boot-test: mount \/var\/lib\/mica \/dev\/vdb rw,nosuid,nodev\b/m,
  /^boot-test: mount \/var \/dev\/vdb rw,nosuid,nodev\b/m,
  /^boot-test: unit srv\.mount loaded active \/run\/systemd\/generator\.early\/srv\.mount$/m,
  /^boot-test: unit var-mnt-scratch\.mount loaded active \/run\/systemd\/generator\/var-mnt-scratch\.mount$/m,
  /^boot-test: unit mnt-usb\.mount masked inactive \/run\/systemd\/generator\/mnt-usb\.mount$/m,
  /^boot-test: marker user-disk$/m,
  /^boot-test: kmsg mica-user-mounts-generator: refused mountpoint \/mnt\/usb\r?$/m,
  /^boot-test: done$/m,
]

async function systemdBootTest(): Promise<number> {
  if (hostArch() !== 'amd64')
    fail('the boot test runs on an x64 host')
  const root = join(REPO, '_out/rootfs/amd64-systemd')
  if (!existsSync(join(root, 'usr/lib/systemd/system-generators/mica-user-mounts-generator')))
    fail(`${root} is not a systemd root with mica-systemd; compose it with: bun src/container.ts rootfs --arch amd64 --init systemd`)
  const work = scratch('boot-test-systemd')
  try {
    const tag = qemuImage(work)
    await testKernel(work)
    for (const [path, content] of Object.entries(SYSTEMD_BOOT_TEST_OVERLAY)) {
      mkdirSync(dirname(join(work, 'overlay', path)), { recursive: true })
      writeFileSync(join(work, 'overlay', path), content)
    }
    mkdirSync(join(work, 'units'))
    for (const [name, content] of Object.entries(SYSTEMD_BOOT_TEST_UNITS))
      writeFileSync(join(work, 'units', name), content)
    writeFileSync(join(work, 'init'), SYSTEMD_BOOT_TEST_INIT)
    const args = ['docker', 'run', '--rm', '--label', 'ai-agent=true', '--network', 'none',
      '-v', `${hostPath(work)}:/work`, '-v', `${hostPath(root)}:/rootfs:ro`]
    if (existsSync('/dev/kvm'))
      args.push('--device', '/dev/kvm')
    const code = attached([...args, tag, 'bash', '-c', SYSTEMD_BOOT_TEST_SCRIPT])
    const log = existsSync(join(work, 'serial.log')) ? readFileSync(join(work, 'serial.log'), 'utf8') : ''
    writeFileSync(join(REPO, '_out/boot-test-systemd.log'), log)
    if (code !== 0)
      fail(`the systemd boot test ended with ${code} (a timeout is 124); the serial log is in _out/boot-test-systemd.log`)
    const missing = SYSTEMD_BOOT_TEST_EXPECT.filter(line => !line.test(log))
    if (missing.length)
      fail(`the serial log lacks: ${missing.map(line => line.source).join('; ')} (_out/boot-test-systemd.log)`)
    console.log('RESULT: PASS (the x64 systemd root loads the user\'s mounts early: srv.mount in place of the bind, the refused one masked)')
    return 0
  }
  finally {
    removeTree(work)
  }
}

async function bootTest(argv: string[]): Promise<number> {
  if (argv.join(' ') === '--init systemd')
    return systemdBootTest()
  if (argv.join(' ') !== '--init openrc')
    fail('usage: bun src/container.ts boot-test --init openrc|systemd')
  if (hostArch() !== 'amd64')
    fail('the boot test runs on an x64 host')
  const root = join(REPO, '_out/rootfs/amd64-openrc')
  if (!existsSync(join(root, 'usr/sbin/openrc-init')))
    fail(`${root} is not an OpenRC root; compose it with: bun src/container.ts rootfs --arch amd64 --init openrc`)
  const work = scratch('boot-test')
  try {
    const tag = qemuImage(work)
    await testKernel(work)
    // The options as built, and the pinned rows they depend on that the root lacks.
    mkdirSync(join(work, 'ssh'))
    for (const name of BOOT_TEST_OPTIONS) {
      const entry = declared(REPO).find(candidate => candidate.name === name)!
      const archive = join(REPO, '_out/debs/amd64/pool', `${name}_${entry.version}_${entry.arches.includes('all') ? 'all' : 'amd64'}.deb`)
      if (!existsSync(archive))
        fail(`${archive} is missing; build it with: bun src/container.ts debs --arch amd64`)
      copyFileSync(archive, join(work, 'ssh', basename(archive)))
    }
    for (const row of optionRows(root)) {
      try {
        copyFileSync(reposLookup(join(REPO, 'repos'), row.sha256), join(work, 'ssh', `${row.name}.deb`))
      }
      catch {
        await reposGet(join(work, 'repos'), row.sha256, row.url, join(work, 'ssh', `${row.name}.deb`))
      }
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
    const ssh = existsSync(join(work, 'ssh.log')) ? readFileSync(join(work, 'ssh.log'), 'utf8') : ''
    const second = existsSync(join(work, 'serial2.log')) ? readFileSync(join(work, 'serial2.log'), 'utf8') : ''
    const remote = existsSync(join(work, 'remote.log')) ? readFileSync(join(work, 'remote.log'), 'utf8') : ''
    writeFileSync(join(REPO, '_out/boot-test.log'), log)
    writeFileSync(join(REPO, '_out/boot-test-ssh.log'), ssh)
    writeFileSync(join(REPO, '_out/boot-test-2.log'), second)
    if (code !== 0)
      fail(`the boot test ended with ${code} (a timeout is 124); the serial log is in _out/boot-test.log`)
    const missing = BOOT_TEST_EXPECT.filter(line => !log.includes(line))
    if (missing.length)
      fail(`the serial log lacks: ${missing.join('; ')} (_out/boot-test.log)`)
    // The login prompts agetty rendered, each from its /etc/issue banner: the first
    // has no device code, the last, after micad's file appeared, shows it.
    const prompts = log.split(`${HOSTNAME} login: `).slice(0, -1).map(text => text.slice(text.lastIndexOf('Mica OS Base ')))
    if (prompts.length < 2 || !prompts[0]!.startsWith('Mica OS Base ') || prompts[0]!.includes('Device code:') || !prompts.at(-1)!.includes('Device code: TEST-0000-ABC'))
      fail(`the login prompts do not show the device code only once it exists: ${JSON.stringify(prompts)} (_out/boot-test.log)`)
    // A key login to root and to mica through OpenSSH: their shadow fields are `*`.
    // And to the login account, by the key in /run/mica/authorized-keys, into its own
    // home; the agent's key for root and mica opens neither.
    for (const login of ['ssh-login: uid=0(root) gid=0(root)', 'ssh-login: uid=1000(mica) gid=1000(mica)', 'ssh-login: uid=20000(gcpuser) gid=20000(gcpuser) groups=982(mica-admins),20000(gcpuser) home /home/gcpuser gcpuser 700', 'ssh-agent-key: root refused', 'ssh-agent-key: mica refused']) {
      if (!ssh.includes(login))
        fail(`no ${login} through mica-sshd (_out/boot-test-ssh.log)`)
    }
    // A login account that is no admin logs in. sudo makes the admin root only with
    // micad's rule in place, and refuses the rest: no rule, no admin, no longer one.
    if (!/^ssh-login: uid=20001\(gcpplain\) gid=20001\(gcpplain\) groups=20001\(gcpplain\) /m.test(ssh))
      fail('the login account gcpplain did not log in (_out/boot-test-ssh.log)')
    const refused = 'sudo: a password is required '
    const steps: [string, string, string][] = [['norule', 'gcpuser', refused], ['rule', 'gcpuser', '0 '], ['rule', 'gcpplain', refused], ['demoted', 'gcpuser', refused], ['promoted', 'gcpuser', '0 '], ['removed', 'gcpuser', refused], ['norule', 'gcpplain', refused], ['removed', 'gcpplain', refused]]
    for (const [step, user, answer] of steps) {
      if (!ssh.split('\n').includes(`ssh-sudo-${step}: ${user} ${answer}`))
        fail(`sudo -n id -u of ${user} (${step}) did not answer ${answer.trim()} (_out/boot-test-ssh.log)`)
    }
    if (ssh.includes('ssh-sudo: '))
      fail('a step of the sudo checks failed (_out/boot-test-ssh.log)')
    // Host keys: ed25519 by default, and the one kept on STATE; RSA (SHA-2) for a client
    // offering nothing else; group14-sha256 for a client with no newer key exchange.
    for (const line of ['ssh-hostkey-default: kex: host key algorithm: ssh-ed25519', 'ssh-hostkey-default: gcpuser in', 'ssh-hostkey-browser: kex: host key algorithm: rsa-sha2-256', 'ssh-hostkey-browser: gcpuser in', 'ssh-hostkey-group14: kex: algorithm: diffie-hellman-group14-sha256', 'ssh-hostkey-group14: gcpuser in', 'ssh-hostkey-kept: yes', 'ssh-hostkey-pub-ed25519: yes', 'ssh-hostkey-pub-rsa: yes']) {
      if (!ssh.split('\n').includes(line))
        fail(`no ${line} through mica-sshd (_out/boot-test-ssh.log)`)
    }
    if (!/^ssh-wtmpdb: -rw\S* .* \/var\/lib\/wtmpdb\/wtmp\.db$/m.test(ssh) || /sshd log: .*wtmp/i.test(log))
      fail('sshd did not record the terminal login in /var/lib/wtmpdb/wtmp.db, or logged a wtmpdb error (_out/boot-test-ssh.log, _out/boot-test.log)')
    // No daemon keeps CAP_SYS_RESOURCE (capability 24), the DATA quota limit.
    const bounding = /boot-test: dbus-daemon CapBnd:\s*([0-9a-f]+)/.exec(log)?.[1]
    if (!bounding || (BigInt(`0x${bounding}`) >> 24n) & 1n)
      fail(`dbus-daemon's bounding set is ${bounding ?? 'unreported'}; a daemon keeps CAP_SYS_RESOURCE (_out/boot-test.log)`)
    // The log: on DATA by default, a quarter of an eighth of DATA as its cap (512 MiB of
    // DATA: about 16 MiB, so the files about 4 MiB each); the previous boot's marker found
    // by logread -b -1 alone; with the smallest cap, 8 MiB, a flood past it keeps the files
    // within it, and a collector over UDP gets the lines.
    const first = /^boot-test: syslogd: \S*busybox syslogd -n -O \/var\/log\/messages -s (\d+) -b 3 -l 7 $/m.exec(log)?.[1]
    if (!first || Number(first) < 3500 || Number(first) > 4096)
      fail(`the first boot's syslogd does not keep the log on DATA with a cap near 16 MiB: ${first ?? 'no syslogd line'} (_out/boot-test.log)`)
    for (const line of ['boot-test: previous boot markers: 1', 'boot-test: this boot markers: 0', 'syslogd -n -O /var/log/messages -s 2048 -b 3 -l 7 -R 10.0.2.2:5514 -L ', 'boot-test: log files: messages messages.0 messages.1 messages.2 ', 'mica-health: no failed units', 'Unbinding DATA']) {
      if (!second.includes(line))
        fail(`the second boot's serial log lacks: ${line} (_out/boot-test-2.log)`)
    }
    const kib = Number(/^boot-test: log KiB: (\d+)/m.exec(second)?.[1] ?? Number.NaN)
    if (!(kib > 6144 && kib <= 8192 + 64))
      fail(`the log files take ${kib} KiB with an 8192 KiB cap (_out/boot-test-2.log)`)
    if (!remote.includes('boot-test: forwarded-marker'))
      fail('the collector on the host received no forwarded line')
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
