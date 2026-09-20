// The release lock format (mica:docs/design/release-lock.md): a producer's
// `mica-lock v1` release lock (section 1), a consumer's `mica-pin v1` pins
// (section 4) and `locks/upstream.lock` (section 4.1). A reader refuses a file at
// the first rule it breaks and names that rule, as the spec's vectors do.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { Refusal } from './errors.ts'

export class LockRefusal extends Refusal {
  constructor(readonly rule: string, readonly file: string, detail: string) {
    super(`${file}: refused (${rule}): ${detail}`)
  }
}

export const KINDS = { release: 4, image: 5, pool: 3, package: 5, board: 5, upstream: 7, apt: 5, input: 4, origin: 3, built: 5, index: 3, product: 8, bundle: 4, asset: 6, data: 4 } as const
export type Kind = keyof typeof KINDS
const BASE_ONLY: Kind[] = ['upstream', 'apt']
const BUILD_ONLY: Kind[] = ['input', 'origin', 'built', 'index', 'product', 'bundle', 'asset']
const INDEX_KINDS: Kind[] = ['origin', 'built', 'index']
// mica-build's version index is a scope of its own, and only its own.
const INDEX_SCOPE = 'mica'
export const BASE_REPOSITORY = 'mica-system-base'
// Repositories whose releases are scoped (<scope>/<release>, pins SCOPE=).
const SCOPED = ['mica-boards', 'mica-build']
const COMPONENTS = ['board', 'kernel', 'uboot', 'firmware', 'packer']
const PROFILES = ['dev', 'prod']
const BUNDLES = ['image', 'update']
const UPDATE_SUFFIX: Record<string, string> = { full: 'micaupd', root: 'root.micaupd', kernel: 'kernel.micaupd' }
const SCOPE = /^[a-z0-9][a-z0-9-]*$/
const GENERATION = /^[1-9]\d*$/

const REPOSITORY = /^[a-z0-9][a-z0-9-]*$/
const RELEASE = /^\d{8}-\d{4}$/
const COMMIT = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/
const ARCHES = ['amd64', 'arm64']
const PLATFORMS = ['index', 'amd64', 'arm64', '386']
const NAME = /^[a-z0-9][a-z0-9.+-]*$/
const VERSION = /^[A-Za-z0-9.+~:-]+$/
const REFERENCE = /^(ghcr\.io\/micaoss|local)\/([a-z0-9][a-z0-9-]*)(?::([\w.-]+))?@sha256:[0-9a-f]{64}$/
// An upstream image (1.2.1): its original name, and its original reference with
// the registry host spelled out.
const UPSTREAM_NAME = /^[a-z0-9][a-z0-9._/-]*(?::[\w.-]+)?$/
const UPSTREAM_REFERENCE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?\/[a-z0-9._/-]+(?::[\w.-]+)?@sha256:[0-9a-f]{64}$/
export const UPSTREAM = 'upstream'

// An `image upstream <name> <platform> <reference>` row, in a release lock or in
// locks/upstream.lock.
function upstreamImage(row: string[], refuse: (rule: string, detail: string) => never): void {
  if (!UPSTREAM_NAME.test(row[2]!) || !PLATFORMS.includes(row[3]!))
    refuse('field-value', `image upstream ${row[2]} ${row[3]}`)
  if (!row[4]!.includes('@sha256:'))
    refuse('reference-digest', `reference ${row[4]}`)
  if (row[4]!.startsWith('ghcr.io/micaoss/') || row[4]!.startsWith('local/'))
    refuse('reference-upstream', `the upstream image ${row[2]} is referenced as ${row[4]}`)
  if (!UPSTREAM_REFERENCE.test(row[4]!))
    refuse('field-value', `reference ${row[4]}`)
}

export interface Lock { repository: string, scope: string, release: string, commit: string, rows: string[][] }

// The rows of a file under a header, comments dropped, after the file rules of 1.1.
function rowsOf(text: string, header: string, file: string): string[][] {
  const refuse = (rule: string, detail: string): never => {
    throw new LockRefusal(rule, file, detail)
  }
  if (!text.endsWith('\n') || text.includes('\r'))
    refuse('encoding', 'no final LF, or a CR')
  const lines = text.slice(0, -1).split('\n')
  if (lines[0] !== header)
    refuse('header', `line 1 is not '${header}'`)
  const rows: string[][] = []
  for (const [index, line] of lines.entries()) {
    if (index === 0)
      continue
    if (line === '' || line.endsWith('\t') || line.startsWith(' '))
      refuse('encoding', `line ${index + 1} is empty, starts with a space or ends with a tab`)
    if (!line.startsWith('#'))
      rows.push(line.split('\t'))
  }
  return rows
}

function bytes(value: string): number[] {
  return [...new TextEncoder().encode(value)]
}

// Sort keys compared as bytes, kind by kind in the given order.
function sorted(keys: (string | number)[][]): boolean {
  const compare = (a: (string | number)[], b: (string | number)[]): number => {
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
      const [x, y] = [a[index], b[index]]
      if (x === undefined || y === undefined)
        return x === undefined ? -1 : 1
      if (typeof x === 'number' || typeof y === 'number') {
        if (x !== y)
          return Number(x) - Number(y)
        continue
      }
      const [p, q] = [bytes(x), bytes(y)]
      for (let at = 0; at < Math.min(p.length, q.length); at++) {
        if (p[at] !== q[at])
          return p[at]! - q[at]!
      }
      if (p.length !== q.length)
        return p.length - q.length
    }
    return 0
  }
  return keys.every((key, index) => index === 0 || compare(keys[index - 1]!, key) <= 0)
}

// A release lock (section 1). `file` names it in refusals.
export function parseLock(text: string, file: string): Lock {
  const refuse = (rule: string, detail: string): never => {
    throw new LockRefusal(rule, file, detail)
  }
  const rows = rowsOf(text, '# mica-lock v1', file)
  for (const row of rows) {
    if (!Object.hasOwn(KINDS, row[0]!))
      refuse('kind-unknown', `unknown kind '${row[0]}'`)
    if (row.length !== KINDS[row[0] as Kind])
      refuse('column-count', `a ${row[0]} row has ${row.length} columns, not ${KINDS[row[0] as Kind]}`)
  }
  if (rows[0]?.[0] !== 'release' || rows.filter(row => row[0] === 'release').length !== 1)
    refuse('release-row', 'the release row is not exactly once and first')
  const [, repository = '', scoped = '', commit = ''] = rows[0]!
  const scope = scoped.includes('.') ? scoped.slice(0, scoped.lastIndexOf('.')) : ''
  const release = scoped.slice(scoped.lastIndexOf('.') + 1)
  const field = (ok: boolean, what: string): void => {
    if (!ok)
      refuse('field-value', what)
  }
  field(REPOSITORY.test(repository) && (RELEASE.test(release) || release === 'offline') && COMMIT.test(commit) && (scope === '' || SCOPE.test(scope)), 'the release row\'s repository, release or commit')
  if ((scope !== '') !== SCOPED.includes(repository))
    refuse('release-scope', `release ${scoped} of ${repository}`)
  if (scope === INDEX_SCOPE && repository !== 'mica-build')
    refuse('index-scope', `the ${INDEX_SCOPE} scope belongs to mica-build`)
  const indexLock = repository === 'mica-build' && scope === INDEX_SCOPE
  const registry = release === 'offline' ? 'local' : 'ghcr.io/micaoss'
  // Returns the reference's tag, empty when it has none.
  const reference = (value: string, expected = repository): string => {
    if (!value.includes('@sha256:'))
      refuse('reference-digest', `reference ${value}`)
    const match = REFERENCE.exec(value)
    if (!match)
      return refuse(value.startsWith('ghcr.io/micaoss/') || value.startsWith('local/') ? 'field-value' : 'reference-registry', `reference ${value}`)
    if (match[1] !== registry)
      refuse('reference-registry', `${value} is not under ${registry}`)
    if (match[2] !== expected)
      refuse('reference-repository', `${value} is not of ${expected}`)
    return match[3] ?? ''
  }
  const boardScope = repository === 'mica-boards' ? scope : ''
  // An index row names one of mica-build's own scoped releases, never the index.
  const indexInput = (name: string): void => {
    const [inputRepository = '', inputScope = ''] = name.includes('.') ? [name.slice(0, name.indexOf('.')), name.slice(name.indexOf('.') + 1)] : [name, '']
    field(inputRepository === 'mica-build' && SCOPE.test(inputScope), `input ${name}`)
    if (inputScope === INDEX_SCOPE)
      refuse('index-scope', `input ${name}`)
  }
  const assetFile = (row: string[], assetRelease: string): boolean => {
    const prefix = `mica-${row[1]}-${assetRelease}.`
    return row[2] === 'image' ? row[4]!.startsWith(prefix) : row[4] === prefix + (UPDATE_SUFFIX[row[3]!] ?? '\n')
  }
  const keys = new Set<string>()
  const order: (string | number)[][] = []
  const pools = new Set<string>()
  for (const row of rows.slice(1)) {
    const kind = row[0] as Kind
    let key: string[]
    if (kind === 'image') {
      if (row[1] === UPSTREAM) {
        upstreamImage(row, refuse)
      }
      else if (REPOSITORY.test(row[1]!)) {
        field(NAME.test(row[2]!) && PLATFORMS.includes(row[3]!), `image ${row[1]} ${row[2]} ${row[3]}`)
        reference(row[4]!, row[1]!)
        if (row[1] !== repository)
          refuse('image-source', `an image of ${row[1]} in a lock of ${repository}`)
      }
      else {
        refuse('image-source', `image source ${row[1]}`)
      }
      key = [row[1]!, row[2]!, row[3]!]
    }
    else if (kind === 'pool') {
      field(ARCHES.includes(row[1]!), `pool ${row[1]}`)
      const tag = reference(row[2]!)
      if (boardScope && !tag.startsWith(`pool.${boardScope}.${row[1]}.`))
        refuse('scope-content', `pool ${tag} outside ${boardScope}`)
      key = [row[1]!]
      pools.add(row[1]!)
    }
    else if (kind === 'package') {
      field(NAME.test(row[1]!) && ARCHES.includes(row[2]!) && VERSION.test(row[3]!) && SHA256.test(row[4]!), `package ${row[1]} ${row[2]}`)
      key = [row[1]!, row[2]!]
    }
    else if (kind === 'board') {
      field(NAME.test(row[1]!) && COMPONENTS.includes(row[2]!) && ARCHES.includes(row[3]!), `board ${row[1]} ${row[2]}`)
      const tag = reference(row[4]!)
      if (boardScope && (row[1] !== boardScope || !tag.startsWith(`${row[2]}.${row[1]}.`)))
        refuse('scope-content', `board ${row[1]} ${row[2]} outside ${boardScope}`)
      key = [row[1]!, row[2]!]
    }
    else if (kind === 'upstream') {
      const roots = row[6]!.split(',')
      field(NAME.test(row[1]!) && ARCHES.includes(row[2]!) && VERSION.test(row[3]!) && SHA256.test(row[4]!) && row[5]!.startsWith('https://')
        && roots.every(root => NAME.test(root)) && roots.join() === [...new Set(roots)].sort().join(), `upstream ${row[1]} ${row[2]}`)
      key = [row[1]!, row[2]!]
    }
    else if (kind === 'apt') {
      field(row[1]!.startsWith('https://') && row[2] !== '' && row[3] !== '' && row[4]!.startsWith('/'), 'apt')
      key = []
    }
    else if (kind === 'input') {
      const [name = '', inputScope = ''] = row[1]!.includes('.') ? [row[1]!.slice(0, row[1]!.indexOf('.')), row[1]!.slice(row[1]!.indexOf('.') + 1)] : [row[1]!, '']
      field(REPOSITORY.test(name) && (inputScope === '' || SCOPE.test(inputScope)) && (RELEASE.test(row[2]!) || row[2] === 'offline') && SHA256.test(row[3]!), `input ${row[1]}`)
      if ((inputScope !== '') !== SCOPED.includes(name))
        refuse('release-scope', `input ${row[1]}`)
      key = [row[1]!]
    }
    else if (kind === 'origin') {
      indexInput(row[1]!)
      field(COMMIT.test(row[2]!), `origin ${row[1]}`)
      key = [row[1]!]
    }
    else if (kind === 'built') {
      indexInput(row[1]!)
      const [name = '', builtScope = ''] = row[2]!.includes('.') ? [row[2]!.slice(0, row[2]!.indexOf('.')), row[2]!.slice(row[2]!.indexOf('.') + 1)] : [row[2]!, '']
      if (!(REPOSITORY.test(name) && (builtScope === '' || SCOPE.test(builtScope)) && (builtScope !== '') === SCOPED.includes(name) && (RELEASE.test(row[3]!) || row[3] === 'offline') && SHA256.test(row[4]!)))
        refuse('index-built-form', `built ${row[1]} ${row[2]}`)
      key = [row[1]!, row[2]!]
    }
    else if (kind === 'index') {
      field(SCOPE.test(row[1]!), `index ${row[1]}`)
      if (row[1] === INDEX_SCOPE)
        refuse('index-scope', `index ${row[1]}`)
      indexInput(row[2]!)
      key = [row[1]!]
    }
    else if (kind === 'product') {
      field(SCOPE.test(row[1]!) && SCOPE.test(row[2]!) && PROFILES.includes(row[3]!) && GENERATION.test(row[4]!) && row.slice(5, 8).every(value => SHA256.test(value)), `product ${row[1]}`)
      if (row[1] === INDEX_SCOPE || row[2] === INDEX_SCOPE)
        refuse('index-scope', `product ${row[1]} ${row[2]}`)
      key = [row[1]!]
    }
    else if (kind === 'bundle') {
      field(SCOPE.test(row[1]!) && BUNDLES.includes(row[2]!), `bundle ${row[1]} ${row[2]}`)
      reference(row[3]!)
      key = [row[1]!, row[2]!]
    }
    else if (kind === 'asset') {
      field(SCOPE.test(row[1]!) && BUNDLES.includes(row[2]!) && SHA256.test(row[5]!)
        && (row[2] === 'image' ? NAME.test(row[3]!) : Object.hasOwn(UPDATE_SUFFIX, row[3]!)), `asset ${row[1]} ${row[2]} ${row[3]}`)
      if (!indexLock)
        field(assetFile(row, release), `asset file ${row[4]}`)
      key = [row[1]!, row[2]!, row[3]!]
    }
    else if (kind === 'data') {
      // 1.2.4: producer data, one file per row. The file is a second key, so two
      // names for one file cannot make its meaning depend on the row a reader took.
      field(NAME.test(row[1]!) && NAME.test(row[2]!) && SHA256.test(row[3]!), `data ${row[1]} ${row[2]}`)
      if (rows.some(other => other !== row && other[0] === 'data' && other[2] === row[2]))
        refuse('data-file', `two data rows name ${row[2]}`)
      key = [row[1]!]
    }
    else {
      refuse('release-row', 'a second release row')
    }
    const identity = [kind, ...key!].join('\t')
    if (keys.has(identity))
      refuse('duplicate-key', `two ${kind} rows ${key!.join(' ')}`)
    keys.add(identity)
    order.push([Object.keys(KINDS).indexOf(kind), ...key!])
  }
  if (repository !== BASE_REPOSITORY && rows.some(row => BASE_ONLY.includes(row[0] as Kind)))
    refuse('base-only-kind', `an upstream or apt row in a lock of ${repository}`)
  if (repository !== 'mica-build' && rows.some(row => BUILD_ONLY.includes(row[0] as Kind)))
    refuse('build-only-kind', `an input, product, bundle or asset row in a lock of ${repository}`)
  if (!indexLock && rows.some(row => INDEX_KINDS.includes(row[0] as Kind)))
    refuse('index-scope', 'an origin, built or index row outside the version index')
  if (indexLock) {
    if (!rows.some(row => row[0] === 'index'))
      refuse('index-scope', 'a version index with no index row')
    if (rows.some(row => (['image', 'pool', 'package', 'board', 'upstream', 'apt'] as string[]).includes(row[0]!))
      || rows.some(row => row[0] === 'input' && (row[1]!.includes('.') ? row[1]!.slice(0, row[1]!.indexOf('.')) : row[1]) !== 'mica-build'))
      refuse('index-only-inputs', 'a version index naming something other than mica-build releases')
    const inputs = new Map(rows.filter(row => row[0] === 'input').map(row => [row[1]!, row[2]!]))
    if (rows.some(row => (row[0] === 'origin' || row[0] === 'built') && !inputs.has(row[1]!))
      || rows.some(row => row[0] === 'index' && !inputs.has(row[2]!))
      || [...inputs.keys()].some(name => rows.filter(row => row[0] === 'origin' && row[1] === name).length !== 1 || !rows.some(row => row[0] === 'built' && row[1] === name)))
      refuse('index-input', 'an index input without its origin and built rows')
    const indexed = new Map(rows.filter(row => row[0] === 'index').map(row => [row[1]!, inputs.get(row[2]!)!]))
    if (JSON.stringify([...new Set(rows.filter(row => row[0] === 'product').map(row => row[1]))].sort()) !== JSON.stringify([...indexed.keys()].sort())
      || rows.some(row => (row[0] === 'bundle' || row[0] === 'asset') && !indexed.has(row[1]!)))
      refuse('index-product-source', 'a product or bundle of no indexed scope')
    for (const row of rows) {
      if (row[0] === 'bundle' && REFERENCE.exec(row[3]!)?.[3] !== `${row[2]}.${row[1]}.${indexed.get(row[1]!)}`)
        refuse('index-product-source', `bundle ${row[1]} ${row[2]}`)
      if (row[0] === 'asset' && !assetFile(row, indexed.get(row[1]!)!))
        refuse('index-product-source', `asset ${row[1]} ${row[2]} ${row[3]}`)
    }
  }
  const products = new Set(rows.filter(row => row[0] === 'product').map(row => row[1]))
  const bundles = new Set(rows.filter(row => row[0] === 'bundle').map(row => `${row[1]} ${row[2]}`))
  if (rows.some(row => (row[0] === 'bundle' || row[0] === 'asset') && !products.has(row[1])))
    refuse('bundle-without-product', 'a bundle or asset of no product')
  if (rows.some(row => row[0] === 'asset' && !bundles.has(`${row[1]} ${row[2]}`)))
    refuse('asset-without-bundle', 'an asset of no bundle')
  if (rows.some(row => row[0] === 'bundle' && row[2] === 'update' && !rows.some(asset => asset[0] === 'asset' && asset[1] === row[1] && asset[2] === 'update' && asset[3] === 'full')))
    refuse('update-full', 'an update bundle without its full asset')
  const orphan = rows.find(row => row[0] === 'package' && !pools.has(row[2]!))
  if (orphan)
    refuse('package-without-pool', `package ${orphan[1]} ${orphan[2]} has no pool`)
  if (repository === 'mica-boards' && !['board', 'kernel'].every(component => rows.some(row => row[0] === 'board' && row[2] === component)))
    refuse('board-components', 'a board lock without its board and kernel components')
  if (!sorted(order))
    refuse('sort-order', 'rows out of order')
  return { repository, scope, release, commit, rows: rows.slice(1) }
}

export const UPSTREAM_KINDS = { image: 5, source: 6, git: 5 } as const

// locks/upstream.lock (section 4.1).
export function parseUpstream(text: string, file: string): string[][] {
  const refuse = (rule: string, detail: string): never => {
    throw new LockRefusal(rule, file, detail)
  }
  const rows = rowsOf(text, '# mica-lock v1', file)
  for (const row of rows) {
    if (row[0] === 'release')
      refuse('upstream-release-row', 'a release row')
    if (!Object.hasOwn(UPSTREAM_KINDS, row[0]!))
      refuse('kind-unknown', `unknown kind '${row[0]}'`)
    if (row.length !== UPSTREAM_KINDS[row[0] as keyof typeof UPSTREAM_KINDS])
      refuse('column-count', `a ${row[0]} row has ${row.length} columns`)
  }
  const field = (ok: boolean, what: string): void => {
    if (!ok)
      refuse('field-value', what)
  }
  const keys = new Set<string>()
  const order: (string | number)[][] = []
  for (const row of rows) {
    let key: string[]
    if (row[0] === 'image') {
      if (row[1] !== UPSTREAM)
        refuse('image-source', `image source ${row[1]}; locks/upstream.lock holds upstream images only`)
      upstreamImage(row, refuse)
      key = [row[1]!, row[2]!, row[3]!]
    }
    else if (row[0] === 'source') {
      field(NAME.test(row[1]!) && [...ARCHES, 'all'].includes(row[2]!) && VERSION.test(row[3]!) && SHA256.test(row[4]!) && row[5]!.startsWith('https://'), `source ${row[1]} ${row[2]}`)
      key = [row[1]!, row[2]!]
    }
    else {
      field(NAME.test(row[1]!) && row[2]!.startsWith('https://') && row[3] !== '' && COMMIT.test(row[4]!), `git ${row[1]}`)
      key = [row[1]!]
    }
    const identity = [row[0], ...key].join('\t')
    if (keys.has(identity))
      refuse('duplicate-key', `two ${row[0]} rows ${key.join(' ')}`)
    keys.add(identity)
    order.push([Object.keys(UPSTREAM_KINDS).indexOf(row[0]!), ...key])
  }
  if (!sorted(order))
    refuse('sort-order', 'rows out of order')
  return rows
}

export interface Pin { repository: string, scope: string, release: string, sha256sums: string, checkout?: string }

function parsePin(text: string, file: string): Pin {
  const refuse = (rule: string, detail: string): never => {
    throw new LockRefusal(rule, file, detail)
  }
  if (!text.endsWith('\n') || text.includes('\r'))
    refuse('encoding', 'no final LF, or a CR')
  const lines = text.slice(0, -1).split('\n')
  if (lines[0] !== '# mica-pin v1')
    refuse('header', 'line 1 is not \'# mica-pin v1\'')
  const pairs = lines.slice(1).map(line => line.includes('=') ? [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)] as const : [line, ''] as const)
  const values = new Map(pairs)
  const offline = values.get('RELEASE') === 'offline'
  const scoped = values.has('SCOPE')
  if (pairs.map(([key]) => key).join() !== ['REPOSITORY', ...(scoped ? ['SCOPE'] : []), 'RELEASE', 'SHA256SUMS', ...(offline ? ['CHECKOUT'] : [])].join())
    refuse('pin-format', 'keys are not REPOSITORY, SCOPE (if scoped), RELEASE, SHA256SUMS (and CHECKOUT only offline), in order')
  const pin: Pin = { repository: values.get('REPOSITORY')!, scope: values.get('SCOPE') ?? '', release: values.get('RELEASE')!, sha256sums: values.get('SHA256SUMS')! }
  if (!REPOSITORY.test(pin.repository) || !SHA256.test(pin.sha256sums) || !(offline || RELEASE.test(pin.release)) || (scoped && !SCOPE.test(pin.scope)) || (offline && !isAbsolute(values.get('CHECKOUT')!)))
    refuse('field-value', 'a repository, scope, release, sha256 or checkout out of form')
  if (offline)
    pin.checkout = values.get('CHECKOUT')!
  return pin
}

export interface Input { pin: Pin, lock: Lock }

// A consumer's locks/ (section 4): every producer lock with its pin and every pin
// with its lock, each named <repository>[.<scope>]; `ci` refuses an offline pin.
// Returns the inputs by that name.
export function readInputs(locks: string, ci: boolean): Map<string, Input> {
  const refuse = (rule: string, file: string, detail: string): never => {
    throw new LockRefusal(rule, file, detail)
  }
  const pinsDirectory = join(locks, 'pins')
  const pins = (existsSync(pinsDirectory) ? readdirSync(pinsDirectory) : []).filter(file => file.endsWith('.pin')).map(file => file.slice(0, -4)).sort()
  const locked = readdirSync(locks).filter(file => file.endsWith('.lock') && file !== 'upstream.lock').map(file => file.slice(0, -5)).sort()
  const records = new Map<string, Pin>()
  for (const name of pins) {
    const file = join(pinsDirectory, `${name}.pin`)
    const pin = parsePin(readFileSync(file, 'utf8'), file)
    const [repository = '', scope = ''] = name.includes('.') ? [name.slice(0, name.indexOf('.')), name.slice(name.indexOf('.') + 1)] : [name, '']
    if (pin.repository !== repository)
      refuse('name-mismatch', file, `REPOSITORY=${pin.repository}`)
    if (pin.scope !== scope)
      refuse('scope-mismatch', file, `SCOPE=${pin.scope}`)
    if ((pin.scope !== '') !== SCOPED.includes(repository))
      refuse('release-scope', file, `SCOPE of ${repository}`)
    records.set(name, pin)
  }
  for (const repository of pins) {
    if (!locked.includes(repository))
      refuse('pin-without-lock', join(pinsDirectory, `${repository}.pin`), `no ${repository}.lock`)
  }
  for (const repository of locked) {
    if (!pins.includes(repository))
      refuse('lock-without-pin', join(locks, `${repository}.lock`), `no pins/${repository}.pin`)
  }
  const inputs = new Map<string, Input>()
  for (const [repository, pin] of records) {
    const file = join(locks, `${repository}.lock`)
    let lock: Lock
    try {
      lock = parseLock(readFileSync(file, 'utf8'), file)
    }
    catch (error) {
      if (error instanceof LockRefusal)
        refuse('lock-invalid', file, error.message)
      throw error
    }
    if (lock.repository !== pin.repository)
      refuse('lock-invalid', file, `the release row names ${lock.repository}`)
    if (lock.scope !== pin.scope)
      refuse('scope-mismatch', file, `scope ${lock.scope}, pinned ${pin.scope}`)
    if (lock.release !== pin.release)
      refuse('release-mismatch', file, `release ${lock.release}, pinned ${pin.release}`)
    if (pin.checkout !== undefined && ci)
      refuse('checkout-in-ci', join(pinsDirectory, `${repository}.pin`), 'an offline pin under CI or in a release build')
    inputs.set(repository, { pin, lock })
  }
  return inputs
}

// CI or a GitHub Actions run: an offline pin is refused there.
export function underCi(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.CI || env.GITHUB_ACTIONS)
}
