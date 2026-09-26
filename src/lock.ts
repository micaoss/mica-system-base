// The Debian pins of locks/upstream.lock and the selections a command works on.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkUpstream } from '@mica/build-tools'
import { fail, Refusal } from './errors.ts'

export type Arch = 'amd64' | 'arm64'
export const ARCHES: Arch[] = ['amd64', 'arm64']

export const UPSTREAM_LOCK = 'locks/upstream.lock'
export const SELECTIONS = 'packages.tsv'

export interface Row {
  name: string
  version: string
  architecture: string
  sha256: string
  url: string
  consumers: string[]
}

export type Selection
  = | { kind: 'base' }
    | { kind: 'all' }
    | { kind: 'consumers', file: string }
    | { kind: 'package', name: string }

// The rows that are not the runtime lock: a package's inputs, its build closure
// and the upstream sources it compiles.
const INPUT = 'input.'
const BUILD = 'build.'
const SOURCE = 'source.'

const PACKAGE_NAME = /^[a-z0-9][a-z0-9+.-]+$/
const SNAPSHOT_URL = /^https:\/\/snapshot\.debian\.org\/archive\/debian(?:-security)?\/\d{8}T\d{6}Z\/pool\/[^\s?#]+\.deb$/

export function lines(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n').map(line => line.replace(/#.*/, '').trim()).filter(Boolean)
}

// Every source row of locks/upstream.lock: name, arch (amd64, arm64 or all),
// version, sha256, url.
export function sourceRows(repo: string): string[][] {
  return checkUpstream(join(repo, UPSTREAM_LOCK)).filter(row => row[0] === 'source').map(row => row.slice(1))
}

// The Debian archives whose lock name starts with `prefix` (no prefix: the
// runtime lock), for one architecture, named without the prefix; an `all` row
// serves both architectures.
function debianRows(repo: string, arch: Arch, prefix: string): Row[] {
  const runtime = (name: string): boolean => ![INPUT, BUILD, SOURCE].some(other => name.startsWith(other))
  return sourceRows(repo).filter(([name = '', target]) => (prefix ? name.startsWith(prefix) : runtime(name)) && (target === arch || target === 'all')).map(([name = '', target = '', version = '', sha256 = '', url = '']) => {
    if (!SNAPSHOT_URL.test(url))
      fail(`invalid package lock: ${UPSTREAM_LOCK}: ${name} is not a Debian snapshot archive: ${url}`)
    return { name: name.slice(prefix.length), version, architecture: target, sha256, url, consumers: [] }
  })
}

// debs/consumers.pkgs names a package, or a family as `<prefix>-*`.
class Consumers {
  private readonly entries: Set<string>
  constructor(repo: string) {
    this.entries = new Set(lines(join(repo, 'debs/consumers.pkgs')))
  }

  static inFamily(name: string, entry: string): boolean {
    if (!entry.endsWith('-*'))
      return false
    const prefix = entry.slice(0, -1)
    return name.length > prefix.length && name.startsWith(prefix)
  }

  known(name: string): boolean {
    return this.entries.has(name) || [...this.entries].some(entry => Consumers.inFamily(name, entry))
  }
}

// packages.tsv: each runtime package and the consumers that select it.
function selections(repo: string, consumers: Consumers): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const line of lines(join(repo, SELECTIONS))) {
    const [name = '', list = '', ...extra] = line.split('\t')
    const tags = list.split(',')
    if (!PACKAGE_NAME.test(name) || name === 'apt' || extra.length || found.has(name))
      fail(`${SELECTIONS}: invalid package name ${name}`)
    if (!list || new Set(tags).size !== tags.length)
      fail(`${SELECTIONS}: invalid consumers of ${name}`)
    for (const consumer of tags) {
      if (consumer !== 'base' && !consumers.known(consumer))
        fail(`${SELECTIONS}: unknown package consumer ${consumer} of ${name}`)
    }
    found.set(name, tags)
  }
  return found
}

export function selectRuntime(repo: string, arch: Arch, selection: Selection): Row[] {
  try {
    const consumers = new Consumers(repo)
    const wanted = new Set(['base'])
    if (selection.kind === 'consumers') {
      const requested = lines(selection.file)
      if (!requested.length)
        fail('package selection is empty')
      for (const consumer of requested) {
        if (!consumers.known(consumer))
          fail(`unknown package consumer: ${consumer}`)
        wanted.add(consumer)
      }
    }
    const wantedBy = (consumer: string): boolean =>
      wanted.has(consumer) || [...wanted].some(name => Consumers.inFamily(name, consumer))
    const tags = selections(repo, consumers)
    const runtime = sourceRows(repo).filter(([name = '']) => ![INPUT, BUILD, SOURCE].some(prefix => name.startsWith(prefix)))
    for (const [name = ''] of runtime) {
      if (!tags.has(name))
        fail(`${name} is pinned in ${UPSTREAM_LOCK} and selected by nothing in ${SELECTIONS}`)
    }
    for (const name of tags.keys()) {
      if (!runtime.some(row => row[0] === name))
        fail(`${SELECTIONS} selects ${name}, which ${UPSTREAM_LOCK} does not pin`)
    }
    if (selection.kind === 'package') {
      if (!PACKAGE_NAME.test(selection.name) || !tags.has(selection.name))
        fail(`${selection.name} is not pinned`)
      if (!runtime.some(([name, target]) => name === selection.name && (target === arch || target === 'all')))
        fail(`package has no ${arch} variant`)
    }
    const rows = debianRows(repo, arch, '')
      .map(row => ({ ...row, consumers: tags.get(row.name)! }))
      .filter(row => selection.kind === 'all' || (selection.kind === 'package' ? row.name === selection.name : row.consumers.some(wantedBy)))
    if (!rows.length)
      fail('package selection is empty')
    return rows
  }
  catch (error) {
    if (error instanceof Refusal && !error.message.startsWith('invalid package lock: '))
      fail(`invalid package lock: ${error.message}`)
    throw error
  }
}

// Inputs: archives a package of debs/ takes files out of (input.<name>); unpacked
// at build time, never installed in a root.
export function selectInputs(repo: string, arch: Arch): Row[] {
  return debianRows(repo, arch, INPUT)
}

// Build pins: the closure of the build tools a package installs into its build
// stage (build.<package>.<name>), resolved on that stage's image against the
// snapshot in debs/<package>/build-sources.json; every package's, or one's.
export function selectBuild(repo: string, arch: Arch, only?: string): Row[] {
  return only ? debianRows(repo, arch, `${BUILD}${only}.`) : debianRows(repo, arch, BUILD).map(row => ({ ...row, name: row.name.slice(row.name.indexOf('.') + 1) }))
}

// The upstream source archive source.<name> a package of debs/ compiles.
export function selectSource(repo: string, name: string): { version: string, sha256: string, url: string } {
  const row = sourceRows(repo).find(([candidate, arch]) => candidate === `${SOURCE}${name}` && arch === 'all')
  if (!row)
    fail(`${UPSTREAM_LOCK} pins no source.${name}`)
  return { version: row[2]!, sha256: row[3]!, url: row[4]! }
}

export function buildSnapshot(repo: string, name: string): string {
  const file = join(repo, 'debs', name, 'build-sources.json')
  try {
    const record = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (!record || typeof record !== 'object' || Object.keys(record).join() !== 'snapshot' || !/^\d{8}T\d{6}Z$/.test(String((record as { snapshot: unknown }).snapshot)))
      fail('expected exactly a snapshot like 20260914T000000Z')
    return (record as { snapshot: string }).snapshot
  }
  catch (error) {
    fail(`debs/${name}/build-sources.json: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// Source rows for rows resolved per architecture, named with `prefix`: one `all`
// row when both architectures resolved the same Architecture: all archive.
export function lockRows(prefix: string, byArch: Map<Arch, Row[]>): string[][] {
  const names = [...new Set(ARCHES.flatMap(arch => (byArch.get(arch) ?? []).map(row => row.name)))]
  return names.flatMap((name) => {
    const [amd64, arm64] = ARCHES.map(arch => (byArch.get(arch) ?? []).find(row => row.name === name))
    if (amd64?.architecture === 'all' && arm64?.architecture === 'all' && amd64.sha256 === arm64.sha256)
      return [['source', `${prefix}${name}`, 'all', amd64.version, amd64.sha256, amd64.url]]
    return ARCHES.flatMap((arch) => {
      const row = (byArch.get(arch) ?? []).find(candidate => candidate.name === name)
      if (!row)
        return []
      if (row.architecture !== arch)
        fail(`${name} resolved as ${row.architecture} for ${arch} and differently for the other architecture`)
      return [['source', `${prefix}${name}`, arch, row.version, row.sha256, row.url]]
    })
  })
}

export function formatRows(rows: Row[]): string {
  return rows.map(row => [row.name, row.version, row.architecture, row.sha256, row.url, row.consumers.join(',')].join('\t')).join('\n')
}

export function parseRows(input: string): Row[] {
  return input.split('\n').filter(Boolean).map((line) => {
    const [name = '', version = '', architecture = '', sha256 = '', url = '', consumers = ''] = line.split('\t')
    return { name, version, architecture, sha256, url, consumers: consumers ? consumers.split(',') : [] }
  })
}
