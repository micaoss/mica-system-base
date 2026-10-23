// The Base built locally, as a release would publish it, for a consumer's offline
// pin (mica-build-tools:docs/spec/release-lock.md sections 6 and 7):
//
//   bun run offline        (bun src/offline.ts)
//
//   builds  per architecture: the packages, the base root and its layer
//           (bun src/container.ts debs|rootfs, bun src/publish.ts layer), with
//           one build time
//   writes  _out/offline/mica-system-base.lock   the release lock of this commit,
//                                                 release `offline`, every image
//                                                 and pool `local/mica-system-base`
//           _out/offline/oci/                     an OCI image layout: the pools as
//                                                 `release pool` lays them out, and
//                                                 the rootfs index, its manifests,
//                                                 configs and layers
//           _out/offline/<data file>              each `data` row's file
//           _out/offline/SHA256SUMS               over the lock
//
// `mica-tools local-lock mica-system-base <checkout>` verifies it and writes the
// consumer's offline pin. A dirty tree is refused, and so is CI: an offline build
// is never a release input.
import type { Arch } from './lock.ts'
import type { Release } from './release.ts'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { digestOf, EMPTY_CONFIG, modeOf, OCI_INDEX, OCI_MANIFEST, poolArchives, poolGate, poolManifest } from '@mica/build-tools'
import { fail, report } from './errors.ts'
import { ARCHES } from './lock.ts'
import { REPO } from './pins.ts'
import { assertPools, dataAssets, readLayers, renderLock, rootfsImages, sha256 } from './publish.ts'
import { buildTime, releaseOf } from './release.ts'

const REF_NAME = 'org.opencontainers.image.ref.name'

// The release of a checkout an offline build may be made of: clean, and not under CI.
export function offlineRelease(repo: string, env: NodeJS.ProcessEnv = process.env): Release {
  if (modeOf(env) === 'ci')
    fail('an offline build is never made under CI: its outputs are no release input')
  const release = releaseOf(repo)
  if (release.label.endsWith('.dirty'))
    fail(`${repo} has uncommitted changes; an offline build is of a commit`)
  return release
}

// _out/offline of the pools in _out/debs, the root layers in _out/layers and the
// data in _out/rootfs; returns the lock's text.
export function offlineLayout(repo: string, release: Release): string {
  const out = join(repo, '_out')
  const into = join(out, 'offline')
  const blobs = join(into, 'oci/blobs/sha256')
  rmSync(into, { recursive: true, force: true })
  mkdirSync(blobs, { recursive: true })
  const put = (bytes: Uint8Array): string => {
    const digest = sha256(bytes)
    writeFileSync(join(blobs, digest), bytes)
    return digest
  }
  assertPools(repo, out, release)
  const { problems } = poolGate(join(out, 'debs'), ARCHES)
  if (problems.length)
    fail(`pool gate: ${problems.join('; ')}`)

  const refs: object[] = []
  put(EMPTY_CONFIG)
  const pools = {} as Record<Arch, { digest: string, layers: { digest: string, annotations?: Record<string, string> }[] }>
  for (const arch of ARCHES) {
    const archives = poolArchives(repo, release.repository, arch)
    for (const archive of archives)
      put(archive.bytes)
    const manifest = poolManifest(release.repository, arch, archives.map(archive => ({ title: archive.file, digest: `sha256:${archive.sha256}`, size: archive.bytes.length, inputs: archive.inputs })))
    const digest = put(manifest)
    refs.push({ mediaType: OCI_MANIFEST, digest: `sha256:${digest}`, size: manifest.length, annotations: { [REF_NAME]: `pool.${arch}.offline` } })
    pools[arch] = { digest, layers: (JSON.parse(new TextDecoder().decode(manifest)) as { layers: { digest: string, annotations?: Record<string, string> }[] }).layers }
  }

  const images = rootfsImages(release, readLayers(join(out, 'layers')))
  const platforms = {} as Record<Arch, string>
  for (const arch of ARCHES) {
    const image = images.platforms.get(arch)!
    put(image.config)
    put(image.layer)
    platforms[arch] = put(image.manifest)
  }
  const index = put(images.index)
  refs.push({ mediaType: OCI_INDEX, digest: `sha256:${index}`, size: images.index.length, annotations: { [REF_NAME]: 'rootfs.offline' } })
  writeFileSync(join(into, 'oci/oci-layout'), '{"imageLayoutVersion":"1.0.0"}\n')
  writeFileSync(join(into, 'oci/index.json'), `${JSON.stringify({ schemaVersion: 2, manifests: refs }, null, 2)}\n`)

  const data = dataAssets(repo, release)
  for (const asset of data)
    writeFileSync(join(into, asset.file), asset.bytes)
  const file = `${release.repository}.lock`
  const text = renderLock(repo, { ...release, label: 'offline' }, { index, platforms, pools }, data, 'local')
  writeFileSync(join(into, file), text)
  writeFileSync(join(into, 'SHA256SUMS'), `${digestOf(new TextEncoder().encode(text)).slice('sha256:'.length)}  ${file}\n`)
  return text
}

function step(argv: string[], env: Record<string, string>): void {
  const run = Bun.spawnSync(argv, { cwd: REPO, stdout: 'inherit', stderr: 'inherit', env: { ...process.env, ...env } })
  if (run.exitCode !== 0)
    fail(`${argv.join(' ')} failed (status ${run.exitCode})`)
}

function main(argv: string[]): void {
  if (argv.length)
    fail('usage: bun src/offline.ts')
  const release = offlineRelease(REPO)
  // One build time for every root: the index carries one.
  const env = { MICA_BUILD_TIME: buildTime() }
  for (const arch of ARCHES) {
    step(['bun', 'src/container.ts', 'debs', '--arch', arch], env)
    step(['bun', 'src/container.ts', 'rootfs', '--arch', arch], env)
    step(['bun', 'src/publish.ts', 'layer', '--arch', arch], env)
  }
  offlineLayout(REPO, release)
  console.log(`offline: ${release.repository} at ${release.commit} in ${join(REPO, '_out/offline')} (${ARCHES.join(', ')})`)
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2))
  }
  catch (error) {
    process.exitCode = report(error)
  }
}
