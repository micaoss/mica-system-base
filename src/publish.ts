// The Base's own half of a release, from CI. mica-build-tools publishes the
// pools (`release pool`), compares every package with the latest release (`pool
// guard`) and attaches the lock (`release attach`); this publishes what only the
// Base has:
//
//   bun src/publish.ts layer --arch <arch>   one architecture's root layer, on its runner
//   bun src/publish.ts gate                  both pools as one build, then pool gate and pool guard
//   bun src/publish.ts rootfs <tag>          ghcr.io/micaoss/<repository>:rootfs.<tag>
//   bun src/publish.ts lock <tag>            <repository>.lock and its data assets, attached
//   bun src/publish.ts lock --dry-run --tag <tag>
//
// rootfs: one OCI image index over a linux/amd64 and a linux/arm64 image, each a
// single layer made from _out/rootfs/<arch>. Only a release publishes: `release
// check` passes for the tag first. Nothing is re-pointed: an existing rootfs tag,
// which carries its first build's time, must be this release and whole, and is
// then finished rather than rebuilt. Every publication is read back with no
// credential, so a package that is not public fails here and a later attempt
// completes it. The registry credential is mica-build-tools' (MICA_REGISTRY_TOKEN,
// GITHUB_TOKEN or GH_TOKEN, and MICA_REGISTRY_USER); MICA_OCI_REGISTRY replaces
// https://ghcr.io for a test registry.
import type { Lock } from '@mica/build-tools'
import type { Arch } from './lock.ts'
import type { Release } from './release.ts'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bearer, checkLock, digestOf, OCI_INDEX, OCI_MANIFEST, ociBlob, ociManifest, poolArchives, poolGate, poolGuard, poolManifest, Pusher, releaseAttach, releaseCheck } from '@mica/build-tools'
import { declared } from './debs/docker.ts'
import { fail, report } from './errors.ts'
import { capture, output } from './exec.ts'
import { ARCHES, selectRuntime } from './lock.ts'
import { environment, REPO, sources } from './pins.ts'
import { issue, ISSUE, releaseOf } from './release.ts'

const HOST = 'ghcr.io'
const OCI_CONFIG = 'application/vnd.oci.image.config.v1+json'
const OCI_LAYER = 'application/vnd.oci.image.layer.v1.tar+gzip'
const BUILT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
const TITLE = 'org.opencontainers.image.title'

export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

// The release this checkout publishes: `release check` passes for `tag`, and the
// checkout is that release.
export async function releaseToPublish(repo: string, tag: string): Promise<Release> {
  const release = releaseOf(repo)
  await releaseCheck(repo, release.repository, tag)
  if (!release.released || release.label !== tag)
    fail(`${repo} at ${release.commit.slice(0, 12)} is not release ${tag}`)
  return release
}

function annotations(release: Release, created: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'org.opencontainers.image.version': release.label,
    'org.opencontainers.image.revision': release.commit,
    'org.opencontainers.image.created': created,
    'org.opencontainers.image.source': `https://github.com/micaoss/${release.repository}`,
    'mica.source-repo': release.repository,
    'mica.source-commit': release.commit,
    ...extra,
  }
}

const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value))

// A manifest by tag, with the publishing credential or with none; undefined when
// the tag does not exist. mica-build-tools reads by digest only, and whether a
// tag exists, and what it holds, is what a later attempt must know.
async function tagged(name: string, tag: string, credential: boolean): Promise<Uint8Array | undefined> {
  const secret = process.env.MICA_REGISTRY_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
  if (credential && !secret)
    fail('publishing needs a token with write:packages in MICA_REGISTRY_TOKEN, GITHUB_TOKEN or GH_TOKEN')
  const user = process.env.MICA_REGISTRY_USER || process.env.GITHUB_ACTOR || 'mica'
  const token = await bearer(HOST, name, credential ? 'pull,push' : 'pull', credential ? { user, token: secret } : undefined)
  const response = await fetch(`${process.env.MICA_OCI_REGISTRY ?? `https://${HOST}`}/v2/${name}/manifests/${tag}`, {
    headers: { Accept: `${OCI_INDEX}, ${OCI_MANIFEST}`, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(60_000),
  })
  if (response.status === 404)
    return undefined
  if (response.status !== 200) {
    if (!credential && (response.status === 401 || response.status === 403))
      fail(`${HOST}/${name}:${tag} cannot be pulled anonymously; make the package public (https://github.com/orgs/micaoss/packages/container/package/${name.split('/').at(-1)}, Package settings -> Change visibility)`)
    fail(`reading ${HOST}/${name}:${tag} answered HTTP ${response.status}`)
  }
  return new Uint8Array(await response.arrayBuffer())
}

// The pools of _out/debs, built per architecture, as one build: each holds
// exactly the declared packages at their declared versions, and every archive
// names the repository -- the producer map only this repository has; pool gate
// checks what the archives answer by themselves. Returns the archives of each pool.
export function assertPools(repo: string, out: string, release: Release): Map<Arch, string[]> {
  const packages = declared(repo)
  const pools = new Map<Arch, string[]>()
  for (const arch of ARCHES) {
    const pool = join(out, 'debs', arch, 'pool')
    const files = existsSync(pool) ? readdirSync(pool).filter(file => file.endsWith('.deb')).sort() : []
    const expected = packages.filter(entry => entry.arches.includes('all') || entry.arches.includes(arch))
      .map(entry => `${entry.name}_${entry.version}_${entry.arches.includes('all') ? 'all' : arch}.deb`)
      .sort()
    if (files.join() !== expected.join())
      fail(`${pool} holds ${files.join(', ') || 'nothing'}; the ${arch} pool is ${expected.join(', ')}. Build it with: bun src/container.ts debs --arch ${arch}`)
    pools.set(arch, files)
  }
  for (const [arch, files] of pools) {
    for (const file of files) {
      const fields = output(['dpkg-deb', '--field', join(out, 'debs', arch, 'pool', file), 'Mica-Source-Repo'], `reading ${file}`)
      if (fields !== `${release.repository}\n`)
        fail(`${file} was not built from ${release.repository}`)
    }
  }
  return pools
}

// A pool manifest's layers, as the lock reads them.
interface Layer { digest: string, annotations?: Record<string, string> }

// A lock held in memory, checked by mica-build-tools under its own file name.
export function parseLock(text: string, file: string): Lock {
  const work = mkdtempSync(join(tmpdir(), 'mica-lock-'))
  try {
    writeFileSync(join(work, file), text)
    return checkLock(join(work, file))
  }
  finally {
    rmSync(work, { recursive: true, force: true })
  }
}

export interface RootfsLayer { gzip: Uint8Array, diffId: string }
export interface RootfsBuild { layers: Map<Arch, RootfsLayer>, built: string }

// A root layer packed on its architecture's runner, kept under
// <directory>/<arch>/ as layer.tar.gz, diff-id and built, and read back by the job
// that publishes the index.
export function writeLayer(directory: string, arch: Arch, layer: RootfsLayer, built: string): void {
  const into = join(directory, arch)
  rmSync(into, { recursive: true, force: true })
  mkdirSync(into, { recursive: true })
  writeFileSync(join(into, 'layer.tar.gz'), layer.gzip)
  writeFileSync(join(into, 'diff-id'), `${layer.diffId}\n`)
  writeFileSync(join(into, 'built'), `${built}\n`)
}

export function readLayers(directory: string): RootfsBuild {
  const layers = new Map<Arch, RootfsLayer>()
  const times = new Set<string>()
  for (const arch of ARCHES) {
    const from = join(directory, arch)
    if (!['layer.tar.gz', 'diff-id', 'built'].every(file => existsSync(join(from, file))))
      fail(`${directory} has no ${arch} root layer; pack it with: bun src/publish.ts layer --arch ${arch}`)
    const diffId = readFileSync(join(from, 'diff-id'), 'utf8').trim()
    const built = readFileSync(join(from, 'built'), 'utf8').trim()
    if (!/^sha256:[0-9a-f]{64}$/.test(diffId))
      fail(`${from}/diff-id is not sha256:<64 hex>`)
    if (!BUILT.test(built))
      fail(`${from}/built is not a UTC time`)
    layers.set(arch, { gzip: new Uint8Array(readFileSync(join(from, 'layer.tar.gz'))), diffId })
    times.add(built)
  }
  if (times.size !== 1)
    fail(`the root layers carry different build times (${[...times].join(', ')}); build both roots with one MICA_BUILD_TIME`)
  return { layers, built: [...times][0]! }
}

// A deterministic layer of one root: sorted, numeric owners, extended attributes
// kept, mtimes clamped to the commit date, and the contents of /dev, /proc, /sys,
// /run and /tmp left out (their directories stay). Made in the environment image,
// so the tar and gzip that write it are the pinned ones.
export function rootfsLayer(root: string, epoch: string, scratch: string): RootfsLayer {
  const image = `${environment().image}:${nativeArch()}`
  // Under the repository, not the system temporary directory: the daemon mounts it.
  mkdirSync(scratch, { recursive: true })
  const work = mkdtempSync(join(scratch, 'rootfs-layer.'))
  try {
    const script = [
      'set -eu',
      `tar --sort=name --numeric-owner --xattrs --xattrs-include='*' --pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime --mtime=@${epoch} --clamp-mtime --exclude='./dev/*' --exclude='./proc/*' --exclude='./sys/*' --exclude='./run/*' --exclude='./tmp/*' -C /root -cf /out/layer.tar .`,
      'gzip -n -c /out/layer.tar >/out/layer.tar.gz',
    ].join('\n')
    const run = capture(['docker', 'run', '--rm', '--label', 'ai-agent=true', '--network', 'none', '-v', `${root}:/root:ro`, '-v', `${work}:/out`, image, 'sh', '-c', script])
    if (run.code !== 0)
      fail(`packing ${root} failed: ${run.stderr.trim()}`)
    return { gzip: new Uint8Array(readFileSync(join(work, 'layer.tar.gz'))), diffId: `sha256:${sha256(new Uint8Array(readFileSync(join(work, 'layer.tar'))))}` }
  }
  finally {
    rmSync(work, { recursive: true, force: true })
  }
}

function nativeArch(): Arch {
  return process.arch === 'arm64' ? 'arm64' : 'amd64'
}

// The root was built from this checkout: its mica-system is the declared version
// and its /etc/issue names the release and the commit. Returns the build time.
export function assertRootFrom(repo: string, root: string, release: Release): string {
  const version = declared(repo).find(entry => entry.name === 'mica-system')!.version
  const installed = capture(['dpkg-query', `--admindir=${join(root, 'var/lib/dpkg')}`, '-W', '-f=${Version}', 'mica-system'])
  if (installed.code !== 0 || installed.stdout !== version)
    fail(`${root} carries mica-system ${installed.stdout || '(none)'}, not ${version}; build it with: bun src/container.ts rootfs --arch <arch>`)
  return assertBanner(root, release)
}

// The banner of a root: it names this release and commit, and in a release build
// it may not name a snapshot. It is the one identity a person reads off a running
// device, so a published root whose banner said `.dirty` would be an identity
// defect of its own. Returns the build time it carries.
export function assertBanner(root: string, release: Release): string {
  const identity = ISSUE.exec(readFileSync(join(root, 'etc/issue'), 'utf8'))
  if (!identity || identity[1] !== release.label || identity[3] !== release.commit)
    fail(`${root}/etc/issue does not name ${release.label} at ${release.commit}`)
  if (release.released && /~git|\.dirty/.test(identity[1]!))
    fail(`${root}/etc/issue names the snapshot ${identity[1]}, not a release; a published root's banner is its release`)
  return identity[2]!
}

// The rootfs index of a build and, per architecture, its image: config, layer and manifest.
export function rootfsImages(release: Release, { layers, built }: RootfsBuild): { index: Uint8Array, platforms: Map<Arch, { config: Uint8Array, layer: Uint8Array, manifest: Uint8Array }> } {
  const platforms = new Map<Arch, { config: Uint8Array, layer: Uint8Array, manifest: Uint8Array }>()
  for (const arch of ARCHES) {
    const layer = layers.get(arch)
    if (!layer)
      fail(`no ${arch} root to publish`)
    const config = json({ architecture: arch, os: 'linux', created: built, config: {}, rootfs: { type: 'layers', diff_ids: [layer.diffId] } })
    const manifest = json({
      schemaVersion: 2,
      mediaType: OCI_MANIFEST,
      config: { mediaType: OCI_CONFIG, digest: `sha256:${sha256(config)}`, size: config.length },
      layers: [{ mediaType: OCI_LAYER, digest: `sha256:${sha256(layer.gzip)}`, size: layer.gzip.length }],
      annotations: annotations(release, built, { 'mica.arch': arch }),
    })
    platforms.set(arch, { config, layer: layer.gzip, manifest })
  }
  const manifests = ARCHES.map(arch => ({ mediaType: OCI_MANIFEST, digest: `sha256:${sha256(platforms.get(arch)!.manifest)}`, size: platforms.get(arch)!.manifest.length, platform: { os: 'linux', architecture: arch } }))
  return { index: json({ schemaVersion: 2, mediaType: OCI_INDEX, manifests, annotations: annotations(release, built) }), platforms }
}

// Publishes rootfs.<tag> from `build`, or, when an earlier attempt of this
// release already wrote that tag, leaves it and its first build time alone and
// finishes its read-back; `build` is then not called.
export async function publishRootfs(repo: string, tag: string, build: () => RootfsBuild): Promise<string> {
  const release = await releaseToPublish(repo, tag)
  const name = `micaoss/${release.repository}`
  const rootfs = `rootfs.${release.label}`
  const existing = await tagged(name, rootfs, true)
  if (!existing) {
    const images = rootfsImages(release, build())
    const pusher = new Pusher(HOST, name)
    for (const arch of ARCHES) {
      const image = images.platforms.get(arch)!
      await pusher.blob(image.config)
      await pusher.blob(image.layer)
      await pusher.manifest(digestOf(image.manifest), image.manifest)
    }
    await pusher.manifest(rootfs, images.index, OCI_INDEX)
  }
  const { built, digest } = await readBackRootfs(repo, name, rootfs, release)
  return `${HOST}/${name}:${rootfs} (${existing ? 'present' : 'pushed'}, built ${built}, sha256:${digest}, linux/amd64 and linux/arm64)`
}

interface Descriptor { mediaType?: string, digest?: string, size?: number, platform?: { os?: string, architecture?: string }, annotations?: Record<string, string> }
interface Manifest { mediaType?: string, manifests?: Descriptor[], config?: Descriptor, layers?: Descriptor[], annotations?: Record<string, string> }

// rootfs.<label> read back whole with no credential: an index naming this release
// over linux/amd64 and linux/arm64, and in each image a manifest, config and
// layer matching their digests and sizes, the layer matching its diff_id, and its
// /etc/issue naming this release, commit and the index's build time. Returns
// that build time and the index digest.
async function readBackRootfs(repo: string, name: string, tag: string, release: Release): Promise<{ built: string, digest: string }> {
  const refuse: (why: string) => never = why => fail(`${HOST}/${name}:${tag} is not ${release.label} at ${release.commit}: ${why}; a tag is never re-pointed`)
  const parse = <T>(bytes: Uint8Array): T | undefined => {
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as T
    }
    catch {
      return undefined
    }
  }
  const same = (actual: Record<string, string> | undefined, expected: Record<string, string>): boolean =>
    JSON.stringify(Object.entries(actual ?? {}).sort()) === JSON.stringify(Object.entries(expected).sort())
  const locks = join(repo, 'locks')
  const read = async <T>(what: string, load: () => Promise<Uint8Array>, size?: number): Promise<{ bytes: Uint8Array, value: T | undefined }> => {
    const bytes = await load().catch(() => refuse(`${what} is not served anonymously with its digest`))
    if (size !== undefined && bytes.length !== size)
      refuse(`${what} is not served anonymously with its size`)
    return { bytes, value: parse<T>(bytes) }
  }
  const indexBytes = await tagged(name, tag, false) ?? fail(`${HOST}/${name}:${tag} does not exist`)
  const index = parse<Manifest>(indexBytes)
  const built = index?.annotations?.['org.opencontainers.image.created'] ?? ''
  if (index?.mediaType !== OCI_INDEX || !BUILT.test(built) || !same(index.annotations, annotations(release, built)))
    refuse('its index does not name this release')
  if (index.manifests?.map(entry => `${entry.mediaType} ${entry.platform?.os}/${entry.platform?.architecture}`).join() !== ARCHES.map(arch => `${OCI_MANIFEST} linux/${arch}`).join())
    refuse('its index is not one image each for linux/amd64 and linux/arm64')
  for (const [position, arch] of ARCHES.entries()) {
    const entry = index.manifests[position]!
    const { value: manifest } = await read<Manifest>(`its ${arch} manifest ${entry.digest}`, () => ociManifest(`${HOST}/${name}@${entry.digest}`, locks, 'ci'), entry.size)
    const layer = manifest?.layers?.[0]
    if (manifest?.mediaType !== OCI_MANIFEST || manifest.config?.mediaType !== OCI_CONFIG || manifest.layers?.length !== 1 || layer?.mediaType !== OCI_LAYER || !same(manifest.annotations, annotations(release, built, { 'mica.arch': arch })))
      refuse(`its ${arch} manifest does not name this release`)
    const blob = (descriptor: Descriptor): Promise<Uint8Array> => ociBlob(`${HOST}/${name}`, (descriptor.digest ?? '').slice('sha256:'.length), locks, 'ci')
    const { value: config } = await read<{ architecture?: string, os?: string, created?: string, rootfs?: { diff_ids?: string[] } }>(`its ${arch} config`, () => blob(manifest.config!), manifest.config.size)
    if (config?.architecture !== arch || config.os !== 'linux' || config.created !== built || config.rootfs?.diff_ids?.length !== 1)
      refuse(`its ${arch} config does not name this build`)
    const tar = Bun.gunzipSync(new Uint8Array((await read(`its ${arch} layer`, () => blob(layer), layer.size)).bytes))
    if (`sha256:${sha256(tar)}` !== config.rootfs.diff_ids[0])
      refuse(`its ${arch} layer does not match its diff_id`)
    const issued = Bun.spawnSync(['tar', '-xOf', '-', './etc/issue'], { stdin: tar, stdout: 'pipe', stderr: 'pipe' })
    if (issued.exitCode !== 0 || issued.stdout.toString() !== issue(release.label, release.commit, built))
      refuse(`the /etc/issue of its ${arch} root does not name this release, commit and build time ${built}`)
  }
  return { built, digest: sha256(indexBytes) }
}

// What the release lock names: the rootfs index and its platform manifests, and
// each pool manifest with its layers.
export interface Published {
  index: string
  platforms: Record<Arch, string>
  pools: Record<Arch, { digest: string, layers: Layer[] }>
}

export const REFERENCE = 'ghcr.io/micaoss'
const KEYRING = '/usr/share/keyrings/debian-archive-keyring.gpg'

// Producer data (mica:docs/design/release-lock.md 1.2.4): the paths of each
// root that no package owns, with their writers, as one asset per architecture
// named by a `data` row. A consumer that composes a root cannot derive them --
// ownership is its proof and these have no owner -- and a CI artifact is not
// content-addressed, expires and cannot be pinned, so they belong on the release.
export interface DataAsset { name: string, file: string, path: string, bytes: Uint8Array, sha256: string }

export function dataAssets(repo: string, release: Release): DataAsset[] {
  return ARCHES.map((arch) => {
    const path = join(repo, '_out', 'rootfs', `${arch}.unowned.tsv`)
    if (!existsSync(path))
      fail(`${path} is missing; build the root with: bun src/container.ts rootfs --arch ${arch}`)
    const bytes = new Uint8Array(readFileSync(path))
    return { name: `unowned.${arch}`, file: `${release.repository}-unowned.${arch}.tsv`, path, bytes, sha256: sha256(bytes) }
  })
}

// <repository>.lock (mica:docs/design/release-lock.md, sections 1 and 3): the
// release; the rootfs index and images; the pools; this repository's packages,
// each the layer of its pool with that digest; the Debian packages pinned for
// later stages with the upstream.pkgs roots they are pinned for; and the Debian
// snapshot as the one apt source. The lock must pass the format's rules.
export function renderLock(repo: string, release: Release, published: Published, data: DataAsset[]): string {
  const at = `${REFERENCE}/${release.repository}`
  const rows: string[][] = [
    ['release', release.repository, release.label, release.commit],
    ...ARCHES.map(arch => ['image', release.repository, 'rootfs', arch, `${at}@sha256:${published.platforms[arch]}`]),
    ['image', release.repository, 'rootfs', 'index', `${at}:rootfs.${release.label}@sha256:${published.index}`],
    ...ARCHES.map(arch => ['pool', arch, `${at}:pool.${arch}.${release.label}@sha256:${published.pools[arch].digest}`]),
  ]
  const packages = ARCHES.flatMap(arch => published.pools[arch].layers.map((layer) => {
    const title = /^([a-z0-9][a-z0-9+.-]*)_([^_]+)_(?:all|amd64|arm64)\.deb$/.exec(layer.annotations?.[TITLE] ?? '')
    if (!title)
      fail(`the ${arch} pool has a layer titled ${layer.annotations?.[TITLE]}, not <package>_<version>_<arch>.deb`)
    return ['package', title[1]!, arch, title[2]!, layer.digest.slice('sha256:'.length)]
  }))
  const upstream = ARCHES.flatMap(arch => selectRuntime(repo, arch, { kind: 'all' }).flatMap((row) => {
    const roots = row.consumers.filter(consumer => consumer.startsWith('upstream-')).map(consumer => consumer.slice('upstream-'.length)).sort()
    return roots.length ? [['upstream', row.name, arch, row.version, row.sha256, row.url, roots.join(',')]] : []
  }))
  const bytes = (value: string): Buffer => Buffer.from(value)
  const byKey = (a: string[], b: string[]): number => Buffer.compare(bytes(a[1]!), bytes(b[1]!)) || Buffer.compare(bytes(a[2]!), bytes(b[2]!))
  const { mirror, suite } = sources(repo)
  rows.push(...packages.sort(byKey), ...upstream.sort(byKey), ['apt', mirror, suite, 'main', KEYRING],
    ...data.map(asset => ['data', asset.name, asset.file, asset.sha256]).sort(byKey))
  const file = `${release.repository}.lock`
  const text = `${['# mica-lock v1', `# ${file}: ${release.repository} ${release.label}, written when the release was published.`, ...rows.map(row => row.join('\t'))].join('\n')}\n`
  parseLock(text, file)
  return text
}

// The lock of release `tag` from its rootfs and pools as the registry serves them
// with no credential, written with its data assets under <out>/release/; returns
// the lock's path and the data files.
export async function writeLock(repo: string, out: string, tag: string): Promise<{ lock: string, data: string[] }> {
  const release = await releaseToPublish(repo, tag)
  const name = `micaoss/${release.repository}`
  const read = async (reference: string): Promise<{ bytes: Uint8Array, manifest: Manifest }> => {
    const bytes = await tagged(name, reference, false) ?? fail(`${HOST}/${name}:${reference} does not exist; publish it first`)
    const manifest = JSON.parse(new TextDecoder().decode(bytes)) as Manifest
    // A rootfs names its release; a pool names none and is identified by its tag.
    if (reference.startsWith('rootfs.') && manifest.annotations?.['org.opencontainers.image.version'] !== release.label)
      fail(`${HOST}/${name}:${reference} names version ${manifest.annotations?.['org.opencontainers.image.version']}, not ${release.label}`)
    if (reference.startsWith('pool.') && manifest.annotations?.['mica.source-repo'] !== release.repository)
      fail(`${HOST}/${name}:${reference} is not a pool of ${release.repository}`)
    return { bytes, manifest }
  }
  const index = await read(`rootfs.${release.label}`)
  const platform = (arch: Arch): string => index.manifest.manifests?.find(entry => entry.platform?.architecture === arch)?.digest?.slice('sha256:'.length) ?? fail(`rootfs.${release.label} has no ${arch} image`)
  const pool = async (arch: Arch): Promise<{ digest: string, layers: Layer[] }> => {
    const { bytes, manifest } = await read(`pool.${arch}.${release.label}`)
    return { digest: sha256(bytes), layers: (manifest.layers ?? []) as Layer[] }
  }
  const data = dataAssets(repo, release)
  const text = renderLock(repo, release, {
    index: sha256(index.bytes),
    platforms: { amd64: platform('amd64'), arm64: platform('arm64') },
    pools: { amd64: await pool('amd64'), arm64: await pool('arm64') },
  }, data)
  const into = join(out, 'release')
  rmSync(into, { recursive: true, force: true })
  mkdirSync(into, { recursive: true })
  for (const asset of data)
    writeFileSync(join(into, asset.file), asset.bytes)
  writeFileSync(join(into, `${release.repository}.lock`), text)
  return { lock: join(into, `${release.repository}.lock`), data: data.map(asset => join(into, asset.file)) }
}

// The lock a release at `tag` would carry, from this checkout's pools
// (_out/debs, as `release pool` would publish them) and root layers, computed
// without a registry.
export function dryRunLock(repo: string, tag: string): string {
  if (!/^\d{8}-\d{4}$/.test(tag))
    fail(`--tag ${tag} is not YYYYMMDD-HHMM`)
  const built = releaseOf(repo)
  assertPools(repo, join(repo, '_out'), built)
  const release = { ...built, label: tag }
  const images = rootfsImages(release, readLayers(join(repo, '_out', 'layers')))
  const pool = (arch: Arch): { digest: string, layers: Layer[] } => {
    const archives = poolArchives(repo, release.repository, arch)
    const manifest = poolManifest(release.repository, arch, archives.map(archive => ({ title: archive.file, digest: `sha256:${archive.sha256}`, size: archive.bytes.length, inputs: archive.inputs })))
    return { digest: sha256(manifest), layers: (JSON.parse(new TextDecoder().decode(manifest)) as Manifest).layers as Layer[] }
  }
  return renderLock(repo, release, {
    index: sha256(images.index),
    platforms: { amd64: sha256(images.platforms.get('amd64')!.manifest), arm64: sha256(images.platforms.get('arm64')!.manifest) },
    pools: { amd64: pool('amd64'), arm64: pool('arm64') },
  }, dataAssets(repo, release))
}

// Both pools as one build: the declared packages (assertPools), then the gates of
// mica-build-tools -- pool gate over the archives, and pool guard for each one
// against the latest release, which refuses a package whose inputs or bytes
// changed without a version bump. Reads only.
export async function gate(repo: string): Promise<string[]> {
  const release = releaseOf(repo)
  const out = join(repo, '_out')
  const pools = assertPools(repo, out, release)
  const lines = [`the ${release.label} pools hold ${[...pools].map(([arch, files]) => `${arch}: ${files.length}`).join(', ')} archives of the declared packages`]
  const { archives, problems } = poolGate(join(out, 'debs'), ARCHES)
  if (problems.length)
    fail(`pool gate: ${problems.join('; ')}`)
  lines.push(`pool gate: ${archives} archives pass`)
  for (const [arch, files] of pools) {
    for (const file of files)
      lines.push(`pool guard: ${await poolGuard(repo, release.repository, arch, join(out, 'debs', arch, 'pool', file))}`)
  }
  return lines
}

async function main(argv: string[]): Promise<void> {
  const [kind, option, value] = argv
  const out = join(REPO, '_out')
  const layers = join(out, 'layers')
  if (kind === 'rootfs' && option && !value) {
    console.log(`publish: ${await publishRootfs(REPO, option, () => readLayers(layers))}`)
    return
  }
  if (kind === 'lock' && option === '--dry-run' && value === '--tag' && argv[3]) {
    process.stdout.write(dryRunLock(REPO, argv[3]))
    return
  }
  if (kind === 'lock' && option && !value) {
    const { lock, data } = await writeLock(REPO, out, option)
    for (const line of await releaseAttach(REPO, releaseOf(REPO).repository, option, lock, '', data))
      console.log(`publish: release ${option}: ${line}`)
    return
  }
  if (kind === 'layer' && option === '--arch' && (ARCHES as string[]).includes(value ?? '')) {
    const arch = value as Arch
    const release = releaseOf(REPO)
    const root = join(out, 'rootfs', arch)
    const built = assertRootFrom(REPO, root, release)
    writeLayer(layers, arch, rootfsLayer(root, release.epoch, join(out, '.publish')), built)
    console.log(`layer: ${arch} root of ${release.label}, built ${built}, in ${join(layers, arch)}`)
    return
  }
  if (kind === 'gate' && !option) {
    for (const line of await gate(REPO))
      console.log(`gate: ${line}`)
    return
  }
  fail('usage: bun src/publish.ts layer --arch amd64|arm64 | gate | rootfs <tag> | lock <tag> | lock --dry-run --tag <tag>')
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2))
  }
  catch (error) {
    process.exitCode = report(error)
  }
}
