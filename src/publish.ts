// Publish a release of this repository, from CI, into its own public package:
//
//   bun src/publish.ts pool     <registry>/<repository>:pool.<arch>.<YYYYMMDD-HHMM>
//   bun src/publish.ts rootfs   <registry>/<repository>:rootfs.<YYYYMMDD-HHMM>
//   bun src/publish.ts lock     mica-system-base.lock and SHA256SUMS on the GitHub Release
//
// pool: one artifact per architecture, one layer per archive of _out/debs/<arch>/pool.
// rootfs: one OCI image index over a linux/amd64 and a linux/arm64 image, each a
// single layer made from _out/rootfs/<arch>.
//
// Only a release publishes: a clean checkout whose HEAD carries its release tag
// YYYYMMDD-HHMM, and only what that commit built. Nothing is re-pointed: an
// existing pool tag must hold exactly these bytes, and an existing rootfs tag,
// which carries its first build's time, must be this release and whole, and is
// then finished rather than rebuilt. Every publication is read back with no
// credential, so a package that is not public fails here and a later attempt
// completes it. MICA_REGISTRY (ghcr.io/micaoss), MICA_REGISTRY_USER and GH_TOKEN
// configure the registry; MICA_REGISTRY_PLAIN_HTTP=1 is for a local test registry.
import type { Arch } from './lock.ts'
import type { Release } from './release.ts'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { declared, inputsHash } from './debs/docker.ts'
import { fail, report } from './errors.ts'
import { capture, output } from './exec.ts'
import { ARCHES, selectRuntime } from './lock.ts'
import { environment, REPO, sources } from './pins.ts'
import { parseLock } from './release-lock.ts'
import { OCI_INDEX, OCI_MANIFEST, Registry, sha256 } from './registry.ts'
import { issue, ISSUE, releaseOf } from './release.ts'

const EMPTY = new TextEncoder().encode('{}')
const OCI_CONFIG = 'application/vnd.oci.image.config.v1+json'
const OCI_LAYER = 'application/vnd.oci.image.layer.v1.tar+gzip'
const BUILT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
const TITLE = 'org.opencontainers.image.title'

// The release this checkout publishes.
export function releaseToPublish(repo: string): Release {
  const release = releaseOf(repo)
  if (!release.released)
    fail(`${repo} at ${release.commit.slice(0, 12)} is not a release: publishing needs a clean checkout whose HEAD carries its release tag YYYYMMDD-HHMM`)
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

// Push `bytes` as <repo>:<tag> unless the tag already holds exactly them.
async function putTag(registry: Registry, repo: string, tag: string, mediaType: string, bytes: Uint8Array): Promise<'pushed' | 'present'> {
  const existing = await registry.manifest(repo, tag)
  if (existing.status === 200) {
    if (sha256(existing.body) !== sha256(bytes))
      fail(`${registry.host}/${repo}:${tag} exists with other content (sha256:${sha256(existing.body)}, this build sha256:${sha256(bytes)}); a tag is never re-pointed`)
    return 'present'
  }
  if (existing.status !== 404)
    fail(`reading ${registry.host}/${repo}:${tag} answered HTTP ${existing.status}`)
  await registry.putManifest(repo, tag, mediaType, bytes)
  return 'pushed'
}

// The tag and the blobs read with no credential; returns the tag's manifest.
async function readBack(registry: Registry, repo: string, tag: string, digests: string[]): Promise<Uint8Array> {
  const settings = `https://github.com/orgs/${registry.owner}/packages/container/package/${repo.split('/').at(-1)}`
  const manifest = await registry.anonymous(repo, tag)
  if (manifest === undefined)
    fail(`${registry.host}/${repo}:${tag} cannot be pulled anonymously; make the package public (${settings}, Package settings -> Change visibility)`)
  for (const digest of digests)
    await anonymousBlob(registry, repo, digest)
  return manifest
}

async function anonymousBlob(registry: Registry, repo: string, digest: string, size?: number): Promise<Uint8Array<ArrayBuffer>> {
  const blob = await registry.anonymousBlob(repo, digest)
  if (blob === undefined || (size !== undefined && blob.length !== size))
    fail(`${registry.host}/${repo} does not serve ${digest} anonymously with those bytes`)
  return blob
}

// The pools of _out/debs, built per architecture, as one build: each holds
// exactly the declared packages at their declared versions, every archive names
// the repository, and an `all` archive is the same bytes in both pools. Returns
// the archives of each pool.
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
  for (const file of pools.get('amd64')!.filter(file => file.endsWith('_all.deb'))) {
    const [amd64, arm64] = ARCHES.map(arch => sha256(new Uint8Array(readFileSync(join(out, 'debs', arch, 'pool', file)))))
    if (amd64 !== arm64)
      fail(`${file} differs between the amd64 and arm64 pools (sha256 ${amd64} and ${arm64}); an all package must build to the same bytes on both`)
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

interface Layer { mediaType: string, digest: string, size: number, annotations: Record<string, string> }

const ARCHIVE = /^([a-z0-9][a-z0-9+.-]*)_([^_]+)_(all|amd64|arm64)\.deb$/

// The pool manifest of one architecture: an empty config and one layer per
// archive, titled with its file name and annotated with its package's inputs.
// Nothing in it names a release, so a pool whose packages did not change is the
// same manifest in the next release.
export function poolManifest(repo: string, release: Release, arch: Arch, pool: string, files: string[]): { manifest: Uint8Array, blobs: Uint8Array[], layers: Layer[] } {
  const packages = declared(repo)
  const blobs = files.map(file => new Uint8Array(readFileSync(join(pool, file))))
  const layers = files.map((file, index) => {
    const [, name = '', , target = ''] = ARCHIVE.exec(file) ?? fail(`${file} is not <package>_<version>_<arch>.deb`)
    const entry = packages.find(candidate => candidate.name === name) ?? fail(`${file} is no package of debs/`)
    return { mediaType: 'application/vnd.mica.deb', digest: `sha256:${sha256(blobs[index]!)}`, size: blobs[index]!.length, annotations: { [TITLE]: file, 'mica.inputs': inputsHash(repo, entry, target as Arch | 'all') } }
  })
  const manifest = json({
    schemaVersion: 2,
    mediaType: OCI_MANIFEST,
    artifactType: 'application/vnd.mica.pool',
    config: { mediaType: 'application/vnd.oci.empty.v1+json', digest: `sha256:${sha256(EMPTY)}`, size: EMPTY.length },
    layers,
    annotations: { 'mica.source-repo': release.repository, 'mica.arch': arch },
  })
  return { manifest, blobs, layers }
}

// A package of a published pool.
export interface PublishedPackage { name: string, version: string, digest: string, inputs: string }

export interface PriorRelease { label: string, pools: Map<Arch, PublishedPackage[]>, predates?: boolean }

// The latest release before this one, as consumers read it: its lock checked
// against its SHA256SUMS, and every pool it names read with no credential at its
// digest. Undefined when there is no earlier release; an earlier release whose
// lock or pools cannot be read is refused, never skipped. A release whose pools
// record no mica.inputs at all predates version-locked packages: its release-
// stamped versions are not compared, and every package is built.
export async function priorRelease(release: Release, registry: Registry, assets: ReleaseAssets): Promise<PriorRelease | undefined> {
  const label = (await assets.releases()).filter(tag => /^\d{8}-\d{4}$/.test(tag) && tag !== release.label && (!release.released || tag < release.label)).sort().at(-1)
  if (!label)
    return undefined
  const file = `${release.repository}.lock`
  const [lock, sums] = await Promise.all([assets.download(label, file), assets.download(label, 'SHA256SUMS')])
  if (!lock || !sums || new TextDecoder().decode(sums) !== `${sha256(lock)}  ${file}\n`)
    fail(`release ${label} does not serve a ${file} its SHA256SUMS lists; the previous packages cannot be compared`)
  const pools = new Map<Arch, PublishedPackage[]>()
  for (const row of parseLock(new TextDecoder().decode(lock), `${file} of ${label}`).rows.filter(candidate => candidate[0] === 'pool')) {
    const digest = row[2]!.slice(row[2]!.indexOf('@') + 1)
    const name = `${registry.owner}/${release.repository}`
    const bytes = await registry.anonymous(name, digest)
    if (bytes === undefined || `sha256:${sha256(bytes)}` !== digest)
      fail(`the ${row[1]} pool of release ${label} (${digest}) cannot be read anonymously with its digest`)
    const manifest = JSON.parse(new TextDecoder().decode(bytes)) as Manifest
    pools.set(row[1] as Arch, (manifest.layers ?? []).map((layer) => {
      const title = ARCHIVE.exec(layer.annotations?.[TITLE] ?? '') ?? fail(`the ${row[1]} pool of release ${label} has a layer titled ${layer.annotations?.[TITLE]}`)
      return { name: title[1]!, version: title[2]!, digest: layer.digest ?? '', inputs: layer.annotations?.['mica.inputs'] ?? '' }
    }))
  }
  const recorded = [...pools.values()].flat().map(entry => Boolean(entry.inputs))
  if (!recorded.includes(true))
    return { label, pools: new Map(), predates: true }
  if (recorded.includes(false))
    fail(`release ${label} has pool layers without mica.inputs beside layers with it`)
  return { label, pools }
}

// Packages are locked by their version: against the prior release, a package of
// the same name, architecture and version must have the same inputs and rebuild
// to the published bytes, which the release then reuses; a higher version is
// built; a lower one is refused. Returns one line per archive.
export function assertVersions(repo: string, out: string, release: Release, prior: PriorRelease | undefined): string[] {
  const lines: string[] = []
  for (const [arch, files] of assertPools(repo, out, release)) {
    const { layers } = poolManifest(repo, release, arch, join(out, 'debs', arch, 'pool'), files)
    for (const layer of layers) {
      const [, name = '', version = ''] = ARCHIVE.exec(layer.annotations[TITLE]!)!
      const published = prior?.pools.get(arch)?.find(candidate => candidate.name === name)
      if (!published) {
        lines.push(`${arch} ${name} ${version}: ${prior?.predates ? `built; release ${prior.label} predates version-locked packages` : 'new'}`)
        continue
      }
      if (published.version !== version) {
        if (capture(['dpkg', '--compare-versions', version, 'gt', published.version]).code !== 0)
          fail(`${name} ${version} (${arch}) is not higher than ${published.version} of release ${prior!.label}`)
        lines.push(`${arch} ${name} ${version}: built, above ${published.version} of ${prior!.label}`)
        continue
      }
      if (published.inputs !== layer.annotations['mica.inputs'])
        fail(`inputs of ${name} changed without a version bump: ${version} (${arch}) of release ${prior!.label} records inputs ${published.inputs || '(none)'}, this tree ${layer.annotations['mica.inputs']}`)
      if (published.digest !== layer.digest)
        fail(`${name} ${version} (${arch}) builds to ${layer.digest}, not the ${published.digest} release ${prior!.label} published; bump its version`)
      lines.push(`${arch} ${name} ${version}: reused from ${prior!.label}, byte-identical`)
    }
  }
  return lines
}

export async function publishPool(repo: string, out: string, registry: Registry, assets: ReleaseAssets): Promise<string[]> {
  const release = releaseToPublish(repo)
  const name = `${registry.owner}/${release.repository}`
  const published = assertVersions(repo, out, release, await priorRelease(release, registry, assets))
  for (const [arch, files] of assertPools(repo, out, release)) {
    const { manifest, blobs, layers } = poolManifest(repo, release, arch, join(out, 'debs', arch, 'pool'), files)
    for (const blob of blobs)
      await registry.putBlob(name, blob)
    await registry.putBlob(name, EMPTY)
    const tag = `pool.${arch}.${release.label}`
    const state = await putTag(registry, name, tag, OCI_MANIFEST, manifest)
    await readBack(registry, name, tag, layers.map(layer => layer.digest))
    published.push(`${registry.host}/${name}:${tag} (${state}, sha256:${sha256(manifest)}, ${layers.length} archives)`)
  }
  return published
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

// Publishes rootfs.<label> from `build`, or, when an earlier attempt of this
// release already wrote that tag, leaves it and its first build time alone and
// finishes its read-back; `build` is then not called.
export async function publishRootfs(repo: string, build: () => RootfsBuild, registry: Registry): Promise<string> {
  const release = releaseToPublish(repo)
  const name = `${registry.owner}/${release.repository}`
  const tag = `rootfs.${release.label}`
  const existing = await registry.manifest(name, tag)
  if (existing.status !== 200 && existing.status !== 404)
    fail(`reading ${registry.host}/${name}:${tag} answered HTTP ${existing.status}`)
  if (existing.status === 404) {
    const images = rootfsImages(release, build())
    for (const arch of ARCHES) {
      const image = images.platforms.get(arch)!
      await registry.putBlob(name, image.config)
      await registry.putBlob(name, image.layer)
      await registry.putManifest(name, `sha256:${sha256(image.manifest)}`, OCI_MANIFEST, image.manifest)
    }
    await putTag(registry, name, tag, OCI_INDEX, images.index)
  }
  const { built, digest } = await readBackRootfs(registry, name, tag, release)
  return `${registry.host}/${name}:${tag} (${existing.status === 200 ? 'present' : 'pushed'}, built ${built}, sha256:${digest}, linux/amd64 and linux/arm64)`
}

interface Descriptor { mediaType?: string, digest?: string, size?: number, platform?: { os?: string, architecture?: string }, annotations?: Record<string, string> }
interface Manifest { mediaType?: string, manifests?: Descriptor[], config?: Descriptor, layers?: Descriptor[], annotations?: Record<string, string> }

// rootfs.<label> read back whole with no credential: an index naming this release
// over linux/amd64 and linux/arm64, and in each image a manifest, config and
// layer matching their digests and sizes, the layer matching its diff_id, and its
// /etc/issue naming this release, commit and the index's build time. Returns
// that build time and the index digest.
async function readBackRootfs(registry: Registry, name: string, tag: string, release: Release): Promise<{ built: string, digest: string }> {
  const refuse: (why: string) => never = why => fail(`${registry.host}/${name}:${tag} is not ${release.label} at ${release.commit}: ${why}; a tag is never re-pointed`)
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
  const indexBytes = await readBack(registry, name, tag, [])
  const index = parse<Manifest>(indexBytes)
  const built = index?.annotations?.['org.opencontainers.image.created'] ?? ''
  if (index?.mediaType !== OCI_INDEX || !BUILT.test(built) || !same(index.annotations, annotations(release, built)))
    refuse('its index does not name this release')
  if (index.manifests?.map(entry => `${entry.mediaType} ${entry.platform?.os}/${entry.platform?.architecture}`).join() !== ARCHES.map(arch => `${OCI_MANIFEST} linux/${arch}`).join())
    refuse('its index is not one image each for linux/amd64 and linux/arm64')
  for (const [position, arch] of ARCHES.entries()) {
    const entry = index.manifests[position]!
    const manifestBytes = await registry.anonymous(name, entry.digest ?? '')
    if (manifestBytes === undefined || `sha256:${sha256(manifestBytes)}` !== entry.digest || manifestBytes.length !== entry.size)
      refuse(`its ${arch} manifest ${entry.digest} is not served anonymously with those bytes`)
    const manifest = parse<Manifest>(manifestBytes)
    const layer = manifest?.layers?.[0]
    if (manifest?.mediaType !== OCI_MANIFEST || manifest.config?.mediaType !== OCI_CONFIG || manifest.layers?.length !== 1 || layer?.mediaType !== OCI_LAYER || !same(manifest.annotations, annotations(release, built, { 'mica.arch': arch })))
      refuse(`its ${arch} manifest does not name this release`)
    const config = parse<{ architecture?: string, os?: string, created?: string, rootfs?: { diff_ids?: string[] } }>(await anonymousBlob(registry, name, manifest.config.digest ?? '', manifest.config.size))
    if (config?.architecture !== arch || config.os !== 'linux' || config.created !== built || config.rootfs?.diff_ids?.length !== 1)
      refuse(`its ${arch} config does not name this build`)
    const tar = Bun.gunzipSync(await anonymousBlob(registry, name, layer.digest ?? '', layer.size))
    if (`sha256:${sha256(tar)}` !== config.rootfs.diff_ids[0])
      refuse(`its ${arch} layer does not match its diff_id`)
    const issued = Bun.spawnSync(['tar', '-xOf', '-', './etc/issue'], { stdin: tar, stdout: 'pipe', stderr: 'pipe' })
    if (issued.exitCode !== 0 || issued.stdout.toString() !== issue(release.label, release.commit, built))
      refuse(`the /etc/issue of its ${arch} root does not name this release, commit and build time ${built}`)
  }
  return { built, digest: sha256(indexBytes) }
}

// A GitHub Release's assets: listed and uploaded with the workflow's credential,
// read with none.
export interface ReleaseAssets {
  releases: () => Promise<string[]>
  list: (tag: string) => Promise<string[]>
  download: (tag: string, name: string) => Promise<Uint8Array | undefined>
  upload: (tag: string, name: string, bytes: Uint8Array) => Promise<void>
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

// <repository>.lock (mica:docs/design/release-lock.md, sections 1 and 3): the
// release; the rootfs index and images; the pools; this repository's packages,
// each the layer of its pool with that digest; the Debian packages pinned for
// later stages with the upstream.pkgs roots they are pinned for; and the Debian
// snapshot as the one apt source. The lock must pass the format's rules.
export function renderLock(repo: string, release: Release, published: Published): string {
  const at = `${REFERENCE}/${release.repository}`
  const rows: string[][] = [
    ['release', release.repository, release.label, release.commit],
    ...ARCHES.map(arch => ['image', release.repository, 'rootfs', arch, `${at}@sha256:${published.platforms[arch]}`]),
    ['image', release.repository, 'rootfs', 'index', `${at}:rootfs.${release.label}@sha256:${published.index}`],
    ...ARCHES.map(arch => ['pool', arch, `${at}:pool.${arch}.${release.label}@sha256:${published.pools[arch].digest}`]),
  ]
  const packages = ARCHES.flatMap(arch => published.pools[arch].layers.map((layer) => {
    const title = /^([a-z0-9][a-z0-9+.-]*)_([^_]+)_(?:all|amd64|arm64)\.deb$/.exec(layer.annotations[TITLE] ?? '')
    if (!title)
      fail(`the ${arch} pool has a layer titled ${layer.annotations[TITLE]}, not <package>_<version>_<arch>.deb`)
    return ['package', title[1]!, arch, title[2]!, layer.digest.slice('sha256:'.length)]
  }))
  const upstream = ARCHES.flatMap(arch => selectRuntime(repo, arch, { kind: 'all' }).flatMap((row) => {
    const roots = row.consumers.filter(consumer => consumer.startsWith('upstream-')).map(consumer => consumer.slice('upstream-'.length)).sort()
    return roots.length ? [['upstream', row.name, arch, row.version, row.sha256, row.url, roots.join(',')]] : []
  }))
  const bytes = (value: string): Buffer => Buffer.from(value)
  const byKey = (a: string[], b: string[]): number => Buffer.compare(bytes(a[1]!), bytes(b[1]!)) || Buffer.compare(bytes(a[2]!), bytes(b[2]!))
  const { mirror, suite } = sources(repo)
  rows.push(...packages.sort(byKey), ...upstream.sort(byKey), ['apt', mirror, suite, 'main', KEYRING])
  const file = `${release.repository}.lock`
  const text = `${['# mica-lock v1', `# ${file}: ${release.repository} ${release.label}, written when the release was published.`, ...rows.map(row => row.join('\t'))].join('\n')}\n`
  parseLock(text, file)
  return text
}

// <repository>.lock and SHA256SUMS on the release, the lock first: the rootfs
// index and the pools of this release as the registry serves them with no
// credential. Whether an asset exists is asked of the release, never of its
// download URL, which GitHub may answer from a cached 404 for a while after the
// upload. An asset already on the release must hold exactly these bytes and is
// never replaced; every asset is read back with no credential, and one GitHub
// does not serve yet is waited for, six times ten seconds at most.
export async function publishLock(repo: string, registry: Registry, assets: ReleaseAssets, wait = (ms: number): Promise<void> => Bun.sleep(ms)): Promise<string[]> {
  const release = releaseToPublish(repo)
  const name = `${registry.owner}/${release.repository}`
  const read = async (tag: string): Promise<{ bytes: Uint8Array, manifest: Manifest }> => {
    const bytes = await registry.anonymous(name, tag)
    if (bytes === undefined)
      fail(`${registry.host}/${name}:${tag} cannot be read anonymously; publish it first`)
    const manifest = JSON.parse(new TextDecoder().decode(bytes)) as Manifest
    // A rootfs names its release; a pool names none and is identified by its tag.
    if (tag.startsWith('rootfs.') && manifest.annotations?.['org.opencontainers.image.version'] !== release.label)
      fail(`${registry.host}/${name}:${tag} names version ${manifest.annotations?.['org.opencontainers.image.version']}, not ${release.label}`)
    if (tag.startsWith('pool.') && manifest.annotations?.['mica.source-repo'] !== release.repository)
      fail(`${registry.host}/${name}:${tag} is not a pool of ${release.repository}`)
    return { bytes, manifest }
  }
  const index = await read(`rootfs.${release.label}`)
  const platform = (arch: Arch): string => index.manifest.manifests?.find(entry => entry.platform?.architecture === arch)?.digest?.slice('sha256:'.length) ?? fail(`rootfs.${release.label} has no ${arch} image`)
  const pool = async (arch: Arch): Promise<{ digest: string, layers: Layer[] }> => {
    const { bytes, manifest } = await read(`pool.${arch}.${release.label}`)
    return { digest: sha256(bytes), layers: (manifest.layers ?? []) as Layer[] }
  }
  const lock = new TextEncoder().encode(renderLock(repo, release, {
    index: sha256(index.bytes),
    platforms: { amd64: platform('amd64'), arm64: platform('arm64') },
    pools: { amd64: await pool('amd64'), arm64: await pool('arm64') },
  }))
  const file = `${release.repository}.lock`
  const sums = new TextEncoder().encode(`${sha256(lock)}  ${file}\n`)
  const same = (a: Uint8Array | undefined, b: Uint8Array): boolean => a !== undefined && a.length === b.length && sha256(a) === sha256(b)
  const served = async (asset: string): Promise<Uint8Array | undefined> => {
    let bytes = await assets.download(release.label, asset)
    for (let attempt = 0; bytes === undefined && attempt < 6; attempt++) {
      await wait(10_000)
      bytes = await assets.download(release.label, asset)
    }
    return bytes
  }
  const present = new Set(await assets.list(release.label))
  const extra = [...present].filter(asset => asset !== file && asset !== 'SHA256SUMS')
  if (extra.length)
    fail(`release ${release.label} carries ${extra.join(', ')}; a release carries exactly ${file} and SHA256SUMS`)
  const results: string[] = []
  for (const [asset, bytes] of [[file, lock], ['SHA256SUMS', sums]] as const) {
    if (present.has(asset)) {
      const existing = await served(asset)
      if (!same(existing, bytes))
        fail(`${asset} of release ${release.label} exists with other content (sha256 ${existing ? sha256(existing) : 'not served'}, this publication ${sha256(bytes)}); a release asset is never replaced`)
      results.push(`${asset} (present)`)
      continue
    }
    await assets.upload(release.label, asset, bytes)
    if (!same(await served(asset), bytes))
      fail(`${asset} of release ${release.label} does not read back with the uploaded bytes`)
    results.push(`${asset} (uploaded)`)
  }
  return results
}

// The lock a release at `tag` would carry, from this checkout's pools and root
// layers, computed without a registry.
export function dryRunLock(repo: string, out: string, tag: string): string {
  if (!/^\d{8}-\d{4}$/.test(tag))
    fail(`--tag ${tag} is not YYYYMMDD-HHMM`)
  const built = releaseOf(repo)
  const pools = assertPools(repo, out, built)
  const release = { ...built, label: tag }
  const images = rootfsImages(release, readLayers(join(out, 'layers')))
  const pool = (arch: Arch): { digest: string, layers: Layer[] } => {
    const { manifest, layers } = poolManifest(repo, release, arch, join(out, 'debs', arch, 'pool'), pools.get(arch)!)
    return { digest: sha256(manifest), layers }
  }
  return renderLock(repo, release, {
    index: sha256(images.index),
    platforms: { amd64: sha256(images.platforms.get('amd64')!.manifest), arm64: sha256(images.platforms.get('arm64')!.manifest) },
    pools: { amd64: pool('amd64'), arm64: pool('arm64') },
  })
}

// The release of GITHUB_REPOSITORY (micaoss/<repository> by default): listed and
// uploaded through gh with GH_TOKEN (never --clobber), downloaded anonymously.
export function githubReleaseAssets(repository: string): ReleaseAssets {
  return {
    releases: async () => {
      const listed = capture(['gh', 'release', 'list', '--repo', repository, '--exclude-drafts', '--limit', '1000', '--json', 'tagName', '--jq', '.[].tagName'])
      if (listed.code !== 0)
        fail(`listing the releases of ${repository} failed: ${listed.stderr.trim()}`)
      return listed.stdout.split('\n').filter(Boolean)
    },
    list: async (tag) => {
      const listed = capture(['gh', 'release', 'view', tag, '--repo', repository, '--json', 'assets', '--jq', '.assets[].name'])
      if (listed.code !== 0)
        fail(`listing the assets of ${repository} release ${tag} failed: ${listed.stderr.trim()}`)
      return listed.stdout.split('\n').filter(Boolean)
    },
    download: async (tag, name) => {
      const response = await fetch(`https://github.com/${repository}/releases/download/${tag}/${name}`, { signal: AbortSignal.timeout(60_000) })
      if (response.status === 404)
        return undefined
      if (!response.ok)
        fail(`downloading ${name} of ${repository} release ${tag} answered HTTP ${response.status}`)
      return new Uint8Array(await response.arrayBuffer())
    },
    upload: async (tag, name, bytes) => {
      const scratch = mkdtempSync(join(REPO, '_out', '.release-asset.'))
      try {
        writeFileSync(join(scratch, name), bytes)
        const uploaded = capture(['gh', 'release', 'upload', tag, join(scratch, name), '--repo', repository])
        if (uploaded.code !== 0)
          fail(`uploading ${name} to ${repository} release ${tag} failed: ${uploaded.stderr.trim()}`)
      }
      finally {
        rmSync(scratch, { recursive: true, force: true })
      }
    },
  }
}

export function registryFromEnv(): Registry {
  const token = process.env.GH_TOKEN ?? ''
  if (!token)
    fail('GH_TOKEN is unset; publishing needs a token with write:packages, which CI\'s own token has')
  return new Registry(process.env.MICA_REGISTRY ?? 'ghcr.io/micaoss', process.env.MICA_REGISTRY_USER ?? 'micaoss', token, process.env.MICA_REGISTRY_PLAIN_HTTP === '1')
}

// pool and rootfs publish; lock attaches <repository>.lock and SHA256SUMS to the
// release, or with --dry-run --tag YYYYMMDD-HHMM prints the lock of this build;
// layer packs one architecture's root on its runner; gate checks the pools of
// both architectures as one build and, reading only, their packages against the
// latest release's (assertVersions).
async function main(argv: string[]): Promise<void> {
  const [kind, option, value] = argv
  const out = join(REPO, '_out')
  const layers = join(out, 'layers')
  const repository = process.env.GITHUB_REPOSITORY ?? `micaoss/${releaseOf(REPO).repository}`
  if (kind === 'pool') {
    for (const line of await publishPool(REPO, out, registryFromEnv(), githubReleaseAssets(repository)))
      console.log(`publish: ${line}`)
    return
  }
  if (kind === 'rootfs') {
    releaseToPublish(REPO)
    console.log(`publish: ${await publishRootfs(REPO, () => readLayers(layers), registryFromEnv())}`)
    return
  }
  if (kind === 'lock' && option === '--dry-run' && argv[2] === '--tag' && argv[3]) {
    process.stdout.write(dryRunLock(REPO, out, argv[3]))
    return
  }
  if (kind === 'lock' && !option) {
    const release = releaseToPublish(REPO)
    mkdirSync(out, { recursive: true })
    for (const line of await publishLock(REPO, registryFromEnv(), githubReleaseAssets(repository)))
      console.log(`publish: ${repository} release ${release.label}: ${line}`)
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
  if (kind === 'gate') {
    const release = releaseOf(REPO)
    const pools = assertPools(REPO, out, release)
    console.log(`gate: the ${release.label} pools hold ${[...pools].map(([arch, files]) => `${arch}: ${files.length}`).join(', ')} archives; the all archives are identical`)
    const anonymous = new Registry(process.env.MICA_REGISTRY ?? 'ghcr.io/micaoss', '', '', process.env.MICA_REGISTRY_PLAIN_HTTP === '1')
    const prior = await priorRelease(release, anonymous, githubReleaseAssets(repository))
    for (const line of assertVersions(REPO, out, release, prior))
      console.log(`gate: ${line}`)
    if (!prior)
      console.log('gate: no earlier release; every package is built')
    return
  }
  fail('usage: bun src/publish.ts pool | rootfs | lock [--dry-run --tag YYYYMMDD-HHMM] | layer --arch amd64|arm64 | gate')
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2))
  }
  catch (error) {
    process.exitCode = report(error)
  }
}
