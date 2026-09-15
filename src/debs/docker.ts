// Build this repository's packages on the host: every debs/<package>/Dockerfile
// outputs a fixed .deb, and this only discovers them, hands each the build images,
// the repository, its declared epoch and its pinned inputs, and files the
// archives into the pools.
//
// A package is a directory under debs/ with a control template, which declares
// the package's own Version and Source-Date-Epoch (src/debs/pack.ts), and a
// Dockerfile whose first line declares what it is built for and from:
//
//   # mica-deb: arches=all|amd64,arm64 [inputs=<input>,...] [build=<package>,...] [sources=<name>,...]
//
// `inputs` names Debian archives pinned as input.<input> in locks/upstream.lock
// (`bun src/container.ts pin-inputs` writes them); each is passed as the build
// argument MICA_INPUT_<NAME> holding its sha256, readable in the `cache` context
// at debs/<sha256>.deb. `build` names the Debian packages the build stage installs;
// their closure is pinned per architecture as build.<package>.<name> and passed
// as MICA_BUILD_PINS, the space-separated sha256 of each. `sources` names upstream
// source archives pinned as source.<name>, passed as MICA_SOURCE_<NAME>_VERSION,
// _URL and _SHA256 for the build to fetch and check. MICA_BUILD_IMAGE is the native environment image and
// MICA_BUILD_C_IMAGE the C image of the package's architecture, both by digest;
// the builder emulates a foreign architecture. An `all` package is built once and
// filed into both pools.
import type { Arch, Row } from '../lock.ts'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fail } from '../errors.ts'
import { attached } from '../exec.ts'
import { ARCHES, selectBuild, selectInputs, selectSource, sourceRows } from '../lock.ts'
import { declaration } from './pack.ts'

export interface Declared {
  name: string
  arches: (Arch | 'all')[]
  inputs: string[]
  build: string[]
  sources: string[]
  version: string
  epoch: number
}

const HEADER = /^# mica-deb: (.*)$/

export function declared(repo: string): Declared[] {
  const root = join(repo, 'debs')
  return readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort().map((name) => {
    const dockerfile = join(root, name, 'Dockerfile')
    if (!existsSync(dockerfile) || !existsSync(join(root, name, 'control')))
      fail(`debs/${name} needs a Dockerfile and a control template`)
    const header = HEADER.exec(readFileSync(dockerfile, 'utf8').split('\n')[0] ?? '')
    if (!header)
      fail(`debs/${name}/Dockerfile does not start with '# mica-deb: arches=...'`)
    const fields = new Map(header[1]!.trim().split(/\s+/).map((pair) => {
      const [key = '', value = ''] = pair.split('=')
      if (!['arches', 'inputs', 'build', 'sources'].includes(key) || !value)
        fail(`debs/${name}/Dockerfile declares '${pair}'`)
      return [key, value.split(',')]
    }))
    const arches = fields.get('arches') ?? []
    if (!arches.length || !(arches.join() === 'all' || arches.every(arch => (ARCHES as string[]).includes(arch))))
      fail(`debs/${name}/Dockerfile declares arches=${arches.join(',')}; use all, or amd64 and/or arm64`)
    const control = join(root, name, 'control')
    const { version, epoch } = declaration(readFileSync(control, 'utf8'), `debs/${name}/control`)
    return { name, arches: arches as Declared['arches'], inputs: fields.get('inputs') ?? [], build: fields.get('build') ?? [], sources: fields.get('sources') ?? [], version, epoch }
  })
}

// The packer and what it imports, run from the `tooling` context.
const TOOLING = ['src/debs/pack.ts', 'src/debs/pack-cli.ts', 'src/errors.ts', 'src/exec.ts']

function files(repo: string, path: string): string[] {
  const stats = lstatSync(join(repo, path))
  return stats.isDirectory() ? readdirSync(join(repo, path)).flatMap(name => files(repo, `${path}/${name}`)) : [path]
}

// mica.inputs of one package for one architecture: the sha256 of a sorted
// manifest of everything in this repository that determines its bytes -- its
// debs/<package>/ (the control template with the declared version and epoch),
// debs/copyright and payload/ when its Dockerfile reads them, the packer, the
// rows of locks/upstream.lock it builds from, and the architecture. The
// build-env images are left out: a toolchain that changes the bytes fails the
// byte-identical comparison with the published package instead.
export function inputsHash(repo: string, entry: Declared, arch: Arch | 'all'): string {
  const dockerfile = readFileSync(join(repo, 'debs', entry.name, 'Dockerfile'), 'utf8')
  const paths = [
    `debs/${entry.name}`,
    ...(dockerfile.includes('debs/copyright') ? ['debs/copyright'] : []),
    ...(dockerfile.includes('from=payload') ? ['payload'] : []),
    ...(dockerfile.includes('from=tooling') ? TOOLING : []),
  ].flatMap(path => files(repo, path))
  const hash = (bytes: Uint8Array | string): string => new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
  const lines = paths.map((path) => {
    const stats = lstatSync(join(repo, path))
    const content = stats.isSymbolicLink() ? `link:${readlinkSync(join(repo, path))}` : new Uint8Array(readFileSync(join(repo, path)))
    return `${hash(content)} ${stats.isSymbolicLink() ? 'l' : stats.mode & 0o111 ? 'x' : '-'} ${path}`
  })
  const wanted = (name: string): boolean => entry.inputs.some(input => name === `input.${input}`) || name.startsWith(`build.${entry.name}.`) || entry.sources.some(source => name === `source.${source}`)
  const rows = sourceRows(repo).filter(([name = '', target]) => wanted(name) && (arch === 'all' || target === arch || target === 'all')).map(row => `row ${row.join(' ')}`)
  const bytes = (value: string): Buffer => Buffer.from(value)
  const manifest = [...lines.sort((a, b) => Buffer.compare(bytes(a.slice(67)), bytes(b.slice(67)))), ...rows.sort((a, b) => Buffer.compare(bytes(a), bytes(b))), `arch ${arch}`]
  return hash(`${manifest.join('\n')}\n`)
}

const argName = (prefix: string, name: string): string => `${prefix}_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`

function sha(rows: Row[], name: string, what: string): string {
  const row = rows.find(candidate => candidate.name === name)
  if (!row)
    fail(`no pinned ${what} ${name}`)
  return row.sha256
}

export interface BuildContext {
  repo: string
  cacheDir: string
  out: string
  builder: string
  image: string
  cImage: (arch: Arch) => string
  native: Arch
  repository: string
}

// What one build makes: each package for each of its architectures, an `all`
// package once, filed into every pool. Given an architecture, only that
// architecture's packages and the `all` packages, filed into its pool; each
// architecture's build then makes its own copy of an `all` package.
export function buildPlan(packages: Pick<Declared, 'name' | 'arches'>[], only?: Arch): { name: string, arch: Arch | 'all', pools: Arch[] }[] {
  return packages.flatMap(entry => entry.arches.filter(arch => !only || arch === 'all' || arch === only).map(arch => ({
    name: entry.name,
    arch,
    pools: arch === 'all' ? (only ? [only] : [...ARCHES]) : [arch],
  })))
}

export function buildDebs(context: BuildContext, only: string[] = [], target?: Arch): string[] {
  const packages = declared(context.repo).filter(entry => !only.length || only.includes(entry.name))
  if (only.length && packages.length !== only.length)
    fail(`no package named ${only.filter(name => !packages.some(entry => entry.name === name)).join(', ')} under debs/`)
  const built: string[] = []
  mkdirSync(context.out, { recursive: true })
  for (const { name, arch, pools } of buildPlan(packages, target)) {
    const entry = packages.find(candidate => candidate.name === name)!
    const rowsArch = arch === 'all' ? context.native : arch
    const args: string[] = []
    for (const input of entry.inputs)
      args.push('--build-arg', `${argName('MICA_INPUT', input)}=${sha(selectInputs(context.repo, rowsArch), input, `input of debs/${entry.name}`)}`)
    for (const source of entry.sources) {
      const { version, url, sha256 } = selectSource(context.repo, source)
      args.push('--build-arg', `${argName('MICA_SOURCE', source)}_VERSION=${version}`, '--build-arg', `${argName('MICA_SOURCE', source)}_URL=${url}`, '--build-arg', `${argName('MICA_SOURCE', source)}_SHA256=${sha256}`)
    }
    if (entry.build.length) {
      const pins = selectBuild(context.repo, rowsArch, entry.name)
      for (const tool of entry.build)
        sha(pins, tool, `build package of debs/${entry.name}`)
      args.push('--build-arg', `MICA_BUILD_PINS=${pins.map(row => row.sha256).join(' ')}`)
    }
    for (const [key, value] of Object.entries({ MICA_DEB_SOURCE_REPO: context.repository, SOURCE_DATE_EPOCH: String(entry.epoch), MICA_DEB_ARCH: arch, MICA_BUILD_IMAGE: context.image, MICA_BUILD_C_IMAGE: context.cImage(rowsArch) }))
      args.push('--build-arg', `${key}=${value}`)
    const dest = mkdtempSync(join(context.out, `.${entry.name}-${arch}.`))
    try {
      // No layer cache: an archive is always the output of this checkout.
      const code = attached([
        'docker',
        'buildx',
        'build',
        '--builder',
        context.builder,
        '--no-cache',
        '--progress=plain',
        '--build-context',
        `payload=${join(context.repo, 'payload')}`,
        '--build-context',
        `debs=${join(context.repo, 'debs')}`,
        '--build-context',
        `tooling=${join(context.repo, 'src')}`,
        '--build-context',
        `cache=${context.cacheDir}`,
        ...args,
        '--output',
        `type=local,dest=${dest}`,
        '--file',
        join(context.repo, 'debs', entry.name, 'Dockerfile'),
        join(context.repo, 'debs', entry.name),
      ])
      if (code !== 0)
        fail(`building debs/${entry.name} for ${arch} failed`)
      const archives = readdirSync(dest).filter(file => file.endsWith('.deb'))
      if (archives.length !== 1 || archives[0] !== `${entry.name}_${entry.version}_${arch}.deb`)
        fail(`debs/${entry.name} for ${arch} produced ${archives.join(', ') || 'nothing'}, not one ${entry.name}_${entry.version}_${arch}.deb`)
      for (const pool of pools) {
        mkdirSync(join(context.out, pool, 'pool'), { recursive: true })
        copyFileSync(join(dest, archives[0]!), join(context.out, pool, 'pool', archives[0]!))
        built.push(`${pool}/pool/${archives[0]}`)
      }
    }
    finally {
      rmSync(dest, { recursive: true, force: true })
    }
  }
  return built
}
