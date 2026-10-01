// Resolve the archives pinned outside the runtime lock: inside the environment
// image, the inputs this repository's packages take files out of; inside a
// package's build image, the closure of the build tools it installs.
import type { Arch, Row } from './lock.ts'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { streamToFile } from '@mica/build-tools'
import { declared } from './debs/docker.ts'
import { fail } from './errors.ts'
import { output } from './exec.ts'
import { buildSnapshot, formatRows, lines, selectRuntime } from './lock.ts'
import { REPO, sources } from './pins.ts'
import { ORPHANED, STRIPPED } from './rootfs.ts'

// The inputs every package under debs/ declares; the archives themselves, never
// their closure: nothing here is installed.
function inputRoots(repo: string): string[] {
  return [...new Set(declared(repo).flatMap(entry => entry.inputs))].sort()
}

export async function resolveInputs(arch: Arch, destination: string | undefined): Promise<void> {
  const { mirror, suite } = sources()
  await resolve({ what: 'inputs', lists: [`deb [check-valid-until=no] ${mirror} ${suite} main`], roots: inputRoots(REPO), install: false }, arch, destination)
}

// The build tools of debs/<name> and whatever the running image lacks of their
// closure, from Debian, its updates and its security archive at the package's
// build snapshot.
export async function resolveBuild(name: string, arch: Arch, destination: string | undefined): Promise<void> {
  const { suite } = sources()
  const snapshot = buildSnapshot(REPO, name)
  const roots = declared(REPO).find(entry => entry.name === name)?.build ?? []
  if (!roots.length)
    fail(`debs/${name} declares no build packages`)
  const base = 'deb [check-valid-until=no] https://snapshot.debian.org/archive'
  await resolve({
    what: `build packages of debs/${name}`,
    lists: [`${base}/debian/${snapshot} ${suite} main`, `${base}/debian/${snapshot} ${suite}-updates main`, `${base}/debian-security/${snapshot} ${suite}-security main`],
    roots,
    install: true,
  }, arch, destination)
}

// The Debian packages of locks/upstream.pkgs and their closure, resolved for `arch` from
// nothing installed at all (any architecture can be resolved from any image),
// less the packages the published floor keeps, which the runtime rows carry: they
// are resolved again in the same run, from the same snapshot. What the floor purges
// is in the closure of the roots that need it; pin-inputs keeps it one row.
export async function resolveUpstream(file: string, arch: Arch, destination: string | undefined): Promise<void> {
  const { mirror, suite } = sources()
  // The published floor: the runtime rows but those the floor purges.
  const purged = [...STRIPPED, ...ORPHANED]
  const root = new Set(runtimeNames(selectRuntime(REPO, arch, { kind: 'all' })).filter(name => !purged.includes(name)))
  await resolve({
    what: 'upstream packages',
    lists: [`deb [arch=${arch} check-valid-until=no] ${mirror} ${suite} main`],
    roots: lines(file),
    install: true,
    foreign: true,
    attribute: true,
    keep: name => !root.has(name),
  }, arch, destination)
}

// The runtime rows: the archives pinned for the root -- the floor and this
// repository's packages -- as opposed to those pinned for later stages only. The
// GNU command set the floor installs and purges is both.
export function runtimeNames(rows: Row[]): string[] {
  return [...new Set(rows.filter(row => row.consumers.some(consumer => !consumer.startsWith('upstream-'))).map(row => row.name))].sort()
}

// The runtime rows again, at the snapshot of locks/sources.json: every name the lock pins
// for the root, resolved from the one source the release's apt row names.
export async function resolveRuntime(arch: Arch, destination: string | undefined): Promise<void> {
  const { mirror, suite } = sources()
  await resolve({
    what: 'runtime packages',
    lists: [`deb [arch=${arch} check-valid-until=no] ${mirror} ${suite} main`],
    roots: runtimeNames(selectRuntime(REPO, arch, { kind: 'all' })),
    install: true,
    foreign: true,
  }, arch, destination)
}

// A package a snapshot's versions add to the root's closure: locks/packages.tsv has to
// name its consumer before the lock can pin it.
export function addedNames(pinned: string[], resolved: string[]): string[] {
  const before = new Set(pinned)
  return [...new Set(resolved)].filter(name => !before.has(name)).sort()
}

// One `apt-get --print-uris` line: the quoted URL, the file name, the size and,
// except on the security archive's lines, the index hash, which is not used: the
// download is checked against the signed index's SHA256.
export function printedUri(line: string): { url: string, file: string } {
  const match = /^'([^']+)' (\S+) \d+(?: \S+)? *$/.exec(line)
  if (!match)
    fail(`unexpected apt-get --print-uris line: ${line}`)
  return { url: match[1]!, file: match[2]! }
}

// A package the base lock pins for the root that a root of locks/upstream.pkgs also
// needs -- one the floor installs and then purges, like coreutils or libgmp10 --
// has one row and one locks/packages.tsv line: its root consumers, then the
// upstream-<root> tags of the upstream closure that holds it. Lines that are
// upstream-only are pin-inputs' own and pass through untouched.
export function tagUpstream(selected: Map<string, string>, attributed: Map<string, string>): Map<string, string> {
  return new Map([...selected].map(([name, list]) => {
    const consumers = list.split(',')
    if (consumers.every(consumer => consumer.startsWith('upstream-')))
      return [name, list]
    const kept = consumers.filter(consumer => !consumer.startsWith('upstream-'))
    return [name, [...kept, ...(attributed.get(name)?.split(',') ?? [])].join(',')]
  }))
}

// `attribute` tags each resolved row upstream-<root> for every root whose own
// closure contains it.
async function resolve(request: { what: string, lists: string[], roots: string[], install: boolean, foreign?: boolean, attribute?: boolean, keep?: (name: string) => boolean }, arch: Arch, destination: string | undefined): Promise<void> {
  if (!destination)
    fail('pin-inputs requires --output')
  if (!request.foreign && output(['dpkg', '--print-architecture'], 'reading the host architecture').trim() !== arch)
    fail(`pin-inputs requires a native ${arch} image`)
  const work = mkdtempSync(join(tmpdir(), 'mica-system-base-pins.'))
  try {
    mkdirSync(join(work, 'lists/partial'), { recursive: true })
    writeFileSync(join(work, 'sources.list'), `${request.lists.join('\n')}\n`)
    writeFileSync(join(work, 'status'), '')
    const foreign = request.foreign ? ['-o', `APT::Architecture=${arch}`, '-o', `APT::Architectures::=${arch}`, '-o', `Dir::State::status=${work}/status`] : []
    const apt = [
      ...foreign,
      '-o',
      `Dir::Etc::SourceList=${work}/sources.list`,
      '-o',
      'Dir::Etc::SourceParts=-',
      '-o',
      `Dir::State::Lists=${work}/lists`,
      '-o',
      'Acquire::Languages=none',
    ]
    output(['apt-get', ...apt, 'update', '-q'], 'apt-get update against the snapshot')
    const { roots } = request
    // Attributed roots are resolved one by one and the rows are their union: roots
    // that cannot share a root -- the two inits' -- are pinned all the same.
    const attribution = new Map<string, string[]>()
    const perRoot: string[] = []
    for (const root of request.attribute ? roots : []) {
      for (const line of output(['apt-get', ...apt, 'install', '--print-uris', '-qq', '--no-install-recommends', root], `resolving ${root}`).split('\n').filter(Boolean)) {
        const file = /^'[^']+' (\S+) /.exec(line)?.[1] ?? ''
        if (!attribution.has(file))
          perRoot.push(line)
        attribution.set(file, [...(attribution.get(file) ?? []), `upstream-${root}`])
      }
    }
    const uris = request.attribute
      ? perRoot.join('\n')
      : output(
          request.install
            ? ['apt-get', ...apt, 'install', '--print-uris', '-qq', '--no-install-recommends', ...roots]
            : ['apt-get', ...apt, 'download', '--print-uris', '-qq', ...roots],
          `resolving the ${request.what}`,
        )
    const rows: Row[] = []
    for (const line of uris.split('\n').filter(Boolean)) {
      const { url, file } = printedUri(line)
      if (request.keep && !request.keep(file.slice(0, file.indexOf('_'))))
        continue
      const partial = join(work, file)
      const response = await fetch(url, { signal: AbortSignal.timeout(600_000) }).catch(() => undefined)
      if (!response?.ok)
        fail(`download failed: ${url}${response ? ` (HTTP ${response.status})` : ''}`)
      const got = await streamToFile(response, partial)
      const [name = '', version = '', architecture = ''] = output(
        ['dpkg-deb', '-W', '--showformat=${Package}\t${Version}\t${Architecture}', partial],
        `reading ${file}`,
      ).split('\t')
      // Checked against the signed index's SHA256; print-uris may report MD5.
      const record = output(['apt-cache', ...apt, 'show', '--no-all-versions', `${name}:${architecture}=${version}`], `reading the index record of ${file}`)
      const sha256 = /^SHA256: ([0-9a-f]{64})$/m.exec(record)?.[1]
      if (!sha256 || got !== sha256)
        fail(`SHA256 mismatch downloading ${url}`)
      rows.push({ name, version, architecture, sha256, url: decodeURIComponent(url), consumers: (attribution.get(file) ?? []).sort() })
    }
    if (!rows.length)
      fail(`apt resolved nothing for ${roots.join(', ')}`)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, `${formatRows(rows.sort((a, b) => a.name.localeCompare(b.name)))}\n`)
    console.log(`mica-system-base: resolved ${rows.length} ${request.what} for ${arch}`)
  }
  finally {
    rmSync(work, { recursive: true, force: true })
  }
}
