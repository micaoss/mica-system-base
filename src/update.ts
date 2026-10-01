// The monthly update (update.yml): every pin moved to its upstream's latest, and
// every package whose inputs or build moved bumped, so the result builds, gates
// and releases like any change. Three steps, each its own process, since the
// first changes the mica-build-tools checkout the others import:
//
//   bun src/update.ts tools      mica-build-tools to the head of its main
//   bun src/update.ts pins       mica-build-env to its latest release, the Debian snapshot
//                                to today, the upstream sources to their latest, pin-inputs
//   bun src/update.ts versions   the trust anchors and tzdata re-recorded, the package
//                                versions bumped; the summary in _out/update-summary.md
//
// A step that finds nothing new changes nothing.
import type { Row } from '@mica/build-tools'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assetBase, checkLock, inputsHash, latestRelease, ociManifest, producerOf, readToolsPin, unxz, vercmp } from '@mica/build-tools'
import { buildPlan, declared } from './debs/docker.ts'
import { fail, report } from './errors.ts'
import { attached, output } from './exec.ts'
import { UPSTREAM_LOCK } from './lock.ts'
import { REPO, sources } from './pins.ts'

const TOOLS_PIN = 'locks/mica-build-tools.pin'
const ENV_PIN = 'locks/pins/mica-build-env.pin'
const SOURCES_JSON = 'locks/sources.json'
const RECORD = 'debs/mica-ca-trust/recorded.env'
const SUMMARY = '_out/update-summary.md'
// What each step changed, one line each, for the summary; the first step starts it.
const CHANGES = '_out/update-changes'

// The upstream every package's version follows: the lock row of what it builds,
// carries or wires in. A version is <that row's upstream version>-mica<N>.
export const UPSTREAM: Record<string, string> = {
  'mica-bluetooth': 'bluez',
  'mica-busybox': 'source.busybox',
  'mica-ca-trust': 'input.ca-certificates',
  'mica-mdev': 'source.busybox',
  'mica-openrc': 'openrc',
  'mica-ssh': 'input.dropbear-bin',
  'mica-system': 'base-files',
  'mica-systemd': 'systemd',
  'mica-systemd-boot': 'source.systemd',
  'mica-tzdata': 'input.tzdata',
  'mica-wifi': 'source.wpa-supplicant',
  'mica-wifi-ap': 'source.hostapd',
}

// The upstream part of a Debian version: no revision.
export function upstreamOf(version: string): string {
  return version.includes('-') ? version.slice(0, version.lastIndexOf('-')) : version
}

// The version of the lock row `name` (the amd64 or architecture-independent one).
export function upstreamVersion(repo: string, name: string): string {
  const line = readFileSync(join(repo, UPSTREAM_LOCK), 'utf8').split('\n').find(entry => entry.startsWith(`source\t${name}\tamd64\t`) || entry.startsWith(`source\t${name}\tall\t`))
  return line?.split('\t')[3] ?? fail(`${UPSTREAM_LOCK} has no ${name} row`)
}

// The next version of a package on `upstream`: <upstream>-mica1 for a new upstream,
// else the revision one up.
export function nextVersion(version: string, upstream: string): string {
  const match = /^(.+)-(?:mica)?(\d+)$/.exec(version) ?? fail(`${version} is not <upstream>-[mica]<revision>`)
  const [, current = '', revision = '0'] = match
  return upstream === current && /-mica\d+$/.test(version) ? `${current}-mica${Number(revision) + 1}` : `${upstream}-mica1`
}

// The highest version of `<prefix><version><suffix>` a download listing names.
export function latestListed(listing: string, prefix: string, suffix: string): string {
  const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const found = [...listing.matchAll(new RegExp(`${escape(prefix)}(\\d+(?:\\.\\d+)*)${escape(suffix)}`, 'g'))].map(match => match[1]!)
  if (!found.length)
    fail(`no ${prefix}<version>${suffix} in the listing`)
  return found.sort(vercmp).at(-1)!
}

// The fields of one package's stanza in a Debian Sources or Packages index.
export function stanza(index: string, name: string): Map<string, string> {
  const block = index.split('\n\n').find(text => new RegExp(`^Package: ${name.replace(/[.+]/g, '\\$&')}$`, 'm').test(text)) ?? fail(`the index has no ${name}`)
  const fields = new Map<string, string>()
  let key = ''
  for (const line of block.split('\n')) {
    if (/^\s/.test(line) && key) {
      fields.set(key, `${fields.get(key)}\n${line.trim()}`)
    }
    else if (line.includes(':')) {
      key = line.slice(0, line.indexOf(':'))
      fields.set(key, line.slice(key.length + 1).trim())
    }
  }
  return fields
}

export interface Pin { version: string, sha256: string, url: string }

// The orig tarball of a source package in a Sources index.
export function debianSource(index: string, name: string, mirror: string): Pin {
  const fields = stanza(index, name)
  const version = upstreamOf(fields.get('Version') ?? '')
  const file = `${name}_${version}.orig.tar.gz`
  const line = (fields.get('Checksums-Sha256') ?? '').split('\n').find(entry => entry.endsWith(` ${file}`)) ?? fail(`${name} has no ${file}`)
  return { version, sha256: line.split(' ')[0]!, url: `${mirror}/${fields.get('Directory')}/${file}` }
}

// The archive a metapackage depends on first, in a Packages index: the cloud kernel
// linux-image-cloud-amd64 names its versioned image.
export function debianBinary(index: string, meta: string, mirror: string): Pin {
  const target = (stanza(index, meta).get('Depends') ?? '').split(/[,\s]/)[0] ?? fail(`${meta} depends on nothing`)
  const fields = stanza(index, target)
  return { version: fields.get('Version') ?? '', sha256: fields.get('SHA256') ?? '', url: `${mirror}/${fields.get('Filename')}` }
}

// locks/upstream.lock with the source row `name` set to `pin`.
export function withSource(lock: string, name: string, pin: Pin): string {
  const prefix = `source\t${name}\tall\t`
  if (!lock.split('\n').some(line => line.startsWith(prefix)))
    fail(`${UPSTREAM_LOCK} has no ${name} row`)
  return lock.split('\n').map(line => line.startsWith(prefix) ? `${prefix}${pin.version}\t${pin.sha256}\t${pin.url}` : line).join('\n')
}

// The digest mica-ca-trust's packer records: sha256 over the `sha256sum` listing of
// every regular file under /usr/share/ca-certificates, sorted by path bytes.
export function anchorsDigest(root: string): string {
  const files: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`
      if (entry.isDirectory())
        walk(path)
      else if (entry.isFile())
        files.push(path)
    }
  }
  walk('/usr/share/ca-certificates')
  files.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
  const listing = files.map(path => `${sha256(readFileSync(join(root, path)))}  ${path}\n`).join('')
  return sha256(listing)
}

// A `KEY=value` line of an env file set to `value`.
export function withValue(text: string, key: string, value: string): string {
  if (!new RegExp(`^${key}=`, 'm').test(text))
    fail(`no ${key}= line`)
  return text.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`)
}

// A control template with a new Version and Source-Date-Epoch.
export function withVersion(control: string, version: string, epoch: number): string {
  return control.replace(/^Version: .*$/m, `Version: ${version}`).replace(/^Source-Date-Epoch: .*$/m, `Source-Date-Epoch: ${epoch}`)
}

function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(300000) })
  if (!response.ok)
    fail(`${url}: HTTP ${response.status}`)
  return response.text()
}

async function fetchIndex(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(300000) })
  if (!response.ok)
    fail(`${url}: HTTP ${response.status}`)
  return new TextDecoder().decode(unxz(new Uint8Array(await response.arrayBuffer())))
}

// A release archive of an upstream that publishes no digest beside it: hashed as downloaded.
async function download(url: string, version: string): Promise<Pin> {
  const response = await fetch(url, { signal: AbortSignal.timeout(300000) })
  if (!response.ok)
    fail(`${url}: HTTP ${response.status}`)
  return { version, sha256: sha256(new Uint8Array(await response.arrayBuffer())), url }
}

function sourceRow(name: string): Pin {
  const line = readFileSync(join(REPO, UPSTREAM_LOCK), 'utf8').split('\n').find(entry => entry.startsWith(`source\t${name}\t`)) ?? fail(`${UPSTREAM_LOCK} has no ${name} row`)
  const [, , , version = '', sha = '', url = ''] = line.split('\t')
  return { version, sha256: sha, url }
}

function git(...args: string[]): string {
  return output(['git', '-C', REPO, ...args], `git ${args.join(' ')}`).trim()
}

function note(line: string): void {
  mkdirSync(join(REPO, '_out'), { recursive: true })
  appendFileSync(join(REPO, CHANGES), `${line}\n`)
  console.log(`update: ${line}`)
}

async function tools(): Promise<void> {
  rmSync(join(REPO, CHANGES), { force: true })
  const pin = join(REPO, TOOLS_PIN)
  const current = readToolsPin(pin)
  const head = output(['git', 'ls-remote', 'https://github.com/micaoss/mica-build-tools', 'refs/heads/main'], 'reading mica-build-tools main').split('\t')[0] ?? ''
  if (!/^[0-9a-f]{40}$/.test(head))
    fail('mica-build-tools main has no commit')
  if (head === current)
    return
  writeFileSync(pin, readFileSync(pin, 'utf8').replace(/^COMMIT=.*$/m, `COMMIT=${head}`))
  note(`mica-build-tools ${current.slice(0, 7)} -> ${head.slice(0, 7)}`)
}

async function pins(): Promise<void> {
  // The build environment.
  const env = /^RELEASE=(.*)$/m.exec(readFileSync(join(REPO, ENV_PIN), 'utf8'))?.[1] ?? fail(`${ENV_PIN} names no RELEASE`)
  const latestEnv = await latestRelease('mica-build-env', { asset: 'mica-build-env.lock', scope: '' }) ?? fail('mica-build-env has no release')
  if (latestEnv !== env) {
    if (attached([join(REPO, 'bin/mica-tools'), 'locks', 'move', 'mica-build-env', latestEnv]) !== 0)
      fail(`moving mica-build-env to ${latestEnv} failed`)
    note(`mica-build-env ${env} -> ${latestEnv}`)
  }
  // The Debian snapshot, for the root and for every package's build tools.
  const today = `${new Date().toISOString().slice(0, 10).replaceAll('-', '')}T000000Z`
  const { suite, snapshot } = sources()
  if (today > snapshot) {
    const mirror = `https://snapshot.debian.org/archive/debian/${today}`
    writeFileSync(join(REPO, SOURCES_JSON), `${JSON.stringify({ suite, snapshot: today, mirror }, null, 2)}\n`)
    for (const entry of declared(REPO)) {
      const file = join(REPO, 'debs', entry.name, 'build-sources.json')
      if (existsSync(file))
        writeFileSync(file, `${JSON.stringify({ snapshot: today }, null, 2)}\n`)
    }
    note(`Debian snapshot ${snapshot} -> ${today}`)
  }
  // The upstream sources.
  const { mirror } = sources()
  const latest: Record<string, () => Promise<Pin>> = {
    'source.systemd': async () => debianSource(await fetchIndex(`${mirror}/dists/${suite}/main/source/Sources.xz`), 'systemd', mirror),
    'source.test-kernel': async () => debianBinary(await fetchIndex(`${mirror}/dists/${suite}/main/binary-amd64/Packages.xz`), 'linux-image-cloud-amd64', mirror),
    'source.busybox': async () => {
      const version = latestListed(await fetchText('https://busybox.net/downloads/'), 'busybox-', '.tar.bz2')
      return version === sourceRow('source.busybox').version ? sourceRow('source.busybox') : download(`https://busybox.net/downloads/busybox-${version}.tar.bz2`, version)
    },
    'source.hostapd': async () => {
      const version = latestListed(await fetchText('https://w1.fi/releases/'), 'hostapd-', '.tar.gz')
      return version === sourceRow('source.hostapd').version ? sourceRow('source.hostapd') : download(`https://w1.fi/releases/hostapd-${version}.tar.gz`, version)
    },
    'source.wpa-supplicant': async () => {
      const version = latestListed(await fetchText('https://w1.fi/releases/'), 'wpa_supplicant-', '.tar.gz')
      return version === sourceRow('source.wpa-supplicant').version ? sourceRow('source.wpa-supplicant') : download(`https://w1.fi/releases/wpa_supplicant-${version}.tar.gz`, version)
    },
  }
  for (const [name, resolve] of Object.entries(latest)) {
    const current = sourceRow(name)
    const pin = await resolve()
    if (pin.version === current.version)
      continue
    writeFileSync(join(REPO, UPSTREAM_LOCK), withSource(readFileSync(join(REPO, UPSTREAM_LOCK), 'utf8'), name, pin))
    note(`${name} ${current.version} -> ${pin.version}`)
  }
  // Every resolved row at the new snapshot, in the environment of the new pins.
  for (const command of [['environment'], ['pin-inputs']]) {
    if (attached(['bun', join(REPO, 'src/container.ts'), ...command]) !== 0)
      fail(`bun src/container.ts ${command.join(' ')} failed`)
  }
}

// The inputs hash each package and architecture was published with in the latest
// release, or nothing before a first release.
async function published(): Promise<{ tag: string, inputs: Map<string, string>, versions: Map<string, string> } | undefined> {
  const tag = await latestRelease('mica-system-base', { asset: 'mica-system-base.lock', scope: '' })
  if (tag === undefined)
    return undefined
  const work = mkdtempSync(join(tmpdir(), 'mica-system-base-update.'))
  try {
    const response = await fetch(`${assetBase('mica-system-base', tag)}mica-system-base.lock`)
    if (!response.ok)
      fail(`the lock of ${tag}: HTTP ${response.status}`)
    writeFileSync(join(work, 'lock'), await response.text())
    const rows: Row[] = checkLock(join(work, 'lock')).rows
    const inputs = new Map<string, string>()
    const versions = new Map<string, string>()
    for (const pool of rows.filter(row => row[0] === 'pool')) {
      const manifest = JSON.parse(new TextDecoder().decode(await ociManifest(pool[2]!, join(REPO, 'locks'), 'ci'))) as { layers?: { digest: string, annotations?: Record<string, string> }[] }
      for (const row of rows.filter(entry => entry[0] === 'package' && entry[2] === pool[1])) {
        const layer = manifest.layers?.find(entry => entry.digest === `sha256:${row[4]}`)
        inputs.set(`${row[1]}/${row[2]}`, layer?.annotations?.['mica.inputs'] ?? '')
        versions.set(row[1]!, row[3]!)
      }
    }
    return { tag, inputs, versions }
  }
  finally {
    rmSync(work, { recursive: true, force: true })
  }
}

async function versions(): Promise<void> {
  const lock = readFileSync(join(REPO, UPSTREAM_LOCK), 'utf8')
  // The trust anchors of the pinned ca-certificates, re-recorded.
  const ca = lock.split('\n').find(line => line.startsWith('source\tinput.ca-certificates\t'))?.split('\t') ?? fail('no input.ca-certificates row')
  const record = readFileSync(join(REPO, RECORD), 'utf8')
  const recorded = /^CA_CERTIFICATES_VERSION=(.*)$/m.exec(record)?.[1]
  if (recorded !== ca[3]) {
    const work = mkdtempSync(join(tmpdir(), 'mica-system-base-ca.'))
    try {
      const response = await fetch(ca[5]!, { signal: AbortSignal.timeout(300000) })
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (!response.ok || sha256(bytes) !== ca[4])
        fail(`${ca[5]} is not the pinned ca-certificates (HTTP ${response.status})`)
      writeFileSync(join(work, 'ca.deb'), bytes)
      output(['dpkg-deb', '-x', join(work, 'ca.deb'), join(work, 'root')], 'unpacking ca-certificates')
      const digest = anchorsDigest(join(work, 'root'))
      writeFileSync(join(REPO, RECORD), withValue(withValue(record, 'CA_CERTIFICATES_VERSION', ca[3]!), 'CA_CERTIFICATES_ANCHORS_SHA256', digest))
      note(`trust anchors of ca-certificates ${recorded} -> ${ca[3]} (${digest.slice(0, 12)})`)
    }
    finally {
      rmSync(work, { recursive: true, force: true })
    }
  }
  // mica-tzdata provides the tzdata it carries.
  const tzdata = lock.split('\n').find(line => line.startsWith('source\tinput.tzdata\t'))?.split('\t')[3] ?? fail('no input.tzdata row')
  const tzControl = join(REPO, 'debs/mica-tzdata/control')
  writeFileSync(tzControl, readFileSync(tzControl, 'utf8').replace(/^Provides: tzdata \(= .*\)$/m, `Provides: tzdata (= ${tzdata})`))
  // Every package whose inputs moved, or whose build did (the environment or the
  // packer), is bumped; one whose upstream moved takes the upstream's version.
  const before = await published()
  const buildMoved = git('status', '--porcelain', '--', 'locks/mica-build-env.lock', TOOLS_PIN) !== ''
  const epoch = Math.floor(Date.now() / 1000)
  for (const entry of declared(REPO)) {
    const row = UPSTREAM[entry.name] ?? fail(`src/update.ts names no upstream for ${entry.name}`)
    const upstream = upstreamOf(upstreamVersion(REPO, row))
    const published = before?.versions.get(entry.name)
    const moved = published === entry.version
      && (buildMoved || buildPlan([entry]).some(({ arch, pools }) => pools.some(pool => before!.inputs.get(`${entry.name}/${pool}`) !== inputsHash(REPO, producerOf(REPO, entry.name), arch))))
    const own = !/-mica\d+$/.test(entry.version)
    const next = upstream !== upstreamOf(entry.version) || own || moved ? nextVersion(entry.version, upstream) : entry.version
    if (next === entry.version)
      continue
    const control = join(REPO, 'debs', entry.name, 'control')
    writeFileSync(control, withVersion(readFileSync(control, 'utf8'), next, epoch))
    note(`${entry.name} ${entry.version} -> ${next}`)
  }
  mkdirSync(join(REPO, '_out'), { recursive: true })
  const changes = existsSync(join(REPO, CHANGES)) ? readFileSync(join(REPO, CHANGES), 'utf8').split('\n').filter(Boolean) : []
  const month = new Date().toISOString().slice(0, 7)
  writeFileSync(join(REPO, SUMMARY), `Update to the upstreams of ${month}\n\n${changes.map(line => `- ${line}`).join('\n')}\n`)
}

async function main(argv: string[]): Promise<void> {
  const [step] = argv
  if (argv.length === 1 && step === 'tools')
    return tools()
  if (argv.length === 1 && step === 'pins')
    return pins()
  if (argv.length === 1 && step === 'versions')
    return versions()
  fail('usage: bun src/update.ts tools | pins | versions')
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2))
  }
  catch (error) {
    process.exitCode = report(error)
  }
}
