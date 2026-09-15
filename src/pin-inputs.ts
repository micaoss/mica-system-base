// Resolve the archives pinned outside the runtime lock: inside the environment
// image, the inputs this repository's packages take files out of; inside a
// package's build image, the closure of the build tools it installs.
import type { Arch, Row } from './lock.ts'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { declared } from './debs/docker.ts'
import { fail } from './errors.ts'
import { output } from './exec.ts'
import { buildSnapshot, formatRows, lines, selectRuntime } from './lock.ts'
import { REPO, sources } from './pins.ts'
import { sha256File } from './verify.ts'

// The inputs every package under debs/ declares; the archives themselves, never
// their closure: nothing here is installed.
export function inputRoots(repo: string): string[] {
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

// The Debian packages of upstream.pkgs and their closure, resolved for `arch` from
// nothing installed at all (any architecture can be resolved from any image),
// less the packages the lock already pins for the base, which must be the same
// versions.
export async function resolveUpstream(file: string, arch: Arch, destination: string | undefined): Promise<void> {
  const { mirror, suite } = sources()
  const locked = new Map(selectRuntime(REPO, arch, { kind: 'all' }).filter(row => row.consumers.some(consumer => !consumer.startsWith('upstream-'))).map(row => [row.name, row]))
  await resolve({
    what: 'upstream packages',
    lists: [`deb [arch=${arch} check-valid-until=no] ${mirror} ${suite} main`],
    roots: lines(file),
    install: true,
    foreign: true,
    attribute: true,
    keep: (row) => {
      const pinned = locked.get(row.name)
      if (pinned && pinned.version !== row.version)
        fail(`${row.name} ${row.version} resolves for upstream.pkgs but the lock pins ${pinned.version}`)
      return !pinned
    },
  }, arch, destination)
}

// `attribute` tags each resolved row upstream-<root> for every root whose own
// closure contains it.
async function resolve(request: { what: string, lists: string[], roots: string[], install: boolean, foreign?: boolean, attribute?: boolean, keep?: (row: Row) => boolean }, arch: Arch, destination: string | undefined): Promise<void> {
  if (!destination)
    fail('pin-inputs requires --output')
  if (!request.foreign && output(['dpkg', '--print-architecture'], 'reading the host architecture').trim() !== arch)
    fail(`pin-inputs requires a native ${arch} image`)
  const work = mkdtempSync(join(tmpdir(), 'debian-base-pins.'))
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
    const uris = output(
      request.install
        ? ['apt-get', ...apt, 'install', '--print-uris', '-qq', '--no-install-recommends', ...roots]
        : ['apt-get', ...apt, 'download', '--print-uris', '-qq', ...roots],
      `resolving the ${request.what}`,
    )
    const attribution = new Map<string, string[]>()
    for (const root of request.attribute ? roots : []) {
      for (const line of output(['apt-get', ...apt, 'install', '--print-uris', '-qq', '--no-install-recommends', root], `resolving ${root}`).split('\n').filter(Boolean)) {
        const file = /^'[^']+' (\S+) /.exec(line)?.[1] ?? ''
        attribution.set(file, [...(attribution.get(file) ?? []), `upstream-${root}`])
      }
    }
    const rows: Row[] = []
    for (const line of uris.split('\n').filter(Boolean)) {
      if (request.keep && !request.keep({ name: /^'[^']*' ([^_]+)_/.exec(line)?.[1] ?? '', version: decodeURIComponent(/^'[^']*' [^_]+_([^_]+)_/.exec(line)?.[1] ?? ''), architecture: '', sha256: '', url: '', consumers: [] }))
        continue
      const match = /^'([^']+)' (\S+) \d+ \S+$/.exec(line)
      if (!match)
        fail(`unexpected apt-get --print-uris line: ${line}`)
      const [, url = '', file = ''] = match
      const partial = join(work, file)
      const fetched = Bun.spawnSync([process.execPath, join(import.meta.dir, 'fetch.ts'), url, partial], { stdio: ['ignore', 'inherit', 'inherit'] })
      if (fetched.exitCode !== 0)
        fail(`download failed: ${url}`)
      const [name = '', version = '', architecture = ''] = output(
        ['dpkg-deb', '-W', '--showformat=${Package}\t${Version}\t${Architecture}', partial],
        `reading ${file}`,
      ).split('\t')
      // Checked against the signed index's SHA256; print-uris may report MD5.
      const record = output(['apt-cache', ...apt, 'show', '--no-all-versions', `${name}:${architecture}=${version}`], `reading the index record of ${file}`)
      const sha256 = /^SHA256: ([0-9a-f]{64})$/m.exec(record)?.[1]
      if (!sha256 || await sha256File(partial) !== sha256)
        fail(`SHA256 mismatch downloading ${url}`)
      rows.push({ name, version, architecture, sha256, url: decodeURIComponent(url), consumers: (attribution.get(file) ?? []).sort() })
    }
    if (!rows.length)
      fail(`apt resolved nothing for ${roots.join(', ')}`)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, `${formatRows(rows.sort((a, b) => a.name.localeCompare(b.name)))}\n`)
    console.log(`debian-base: resolved ${rows.length} ${request.what} for ${arch}`)
  }
  finally {
    rmSync(work, { recursive: true, force: true })
  }
}
