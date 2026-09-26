// src/publish.ts against an in-process OCI registry and GitHub API: the rootfs
// tag, a later attempt finishing a release, the lock of a published release, the
// gate, and the refusals. The pools themselves are mica-build-tools' `release
// pool`, run here only to publish what the lock names.
import type { RootfsBuild } from '../src/publish.ts'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { publishPools } from '@mica/build-tools'
import { sources } from '../src/pins.ts'
import { assertBanner, assertPools, dataAssets, dryRunLock, gate, parseLock, publishRootfs, readLayers, rootfsImages, sha256, writeLayer, writeLock } from '../src/publish.ts'
import { issue, releaseOf } from '../src/release.ts'
import { REPO, run, workdir, writePins } from './fixture.ts'

const UPSTREAM_URL = 'https://snapshot.debian.org/archive/debian/20260905T000000Z/pool/main/l/libfixture/libfixture_1.0-1'
const NAME = 'micaoss/mica-system-base'
const TAG = '20260914-0130'

// Just enough of the distribution API. The token endpoint issues 'anonymous'
// without credentials and 'user' with them; a private registry refuses the
// anonymous bearer.
function registry(options: { private?: boolean } = {}): { url: string, stop: () => void, put: (tag: string, body: string) => void, blob: (digest: string, body: Uint8Array) => void } {
  const blobs = new Map<string, Uint8Array>()
  const manifests = new Map<string, Uint8Array>()
  const digest = (bytes: Uint8Array): string => `sha256:${sha256(bytes)}`
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === '/token')
        return Response.json({ token: request.headers.get('authorization')?.startsWith('Basic ') ? 'user' : 'anonymous' })
      const bearer = request.headers.get('authorization')
      if (!bearer || (options.private && bearer === 'Bearer anonymous'))
        return new Response(null, { status: 401, headers: { 'WWW-Authenticate': `Bearer realm="${url.origin}/token",service="test"` } })
      const match = /^\/v2\/(.+)\/(blobs\/uploads\/.*|blobs\/sha256:[0-9a-f]{64}|manifests\/[^/]+)$/.exec(url.pathname)
      if (!match)
        return new Response('not found', { status: 404 })
      const [, repo = '', path = ''] = match
      if (path.startsWith('blobs/uploads/')) {
        if (request.method === 'POST')
          return new Response(null, { status: 202, headers: { Location: `/v2/${repo}/blobs/uploads/${crypto.randomUUID()}` } })
        const body = new Uint8Array(await request.arrayBuffer())
        if (digest(body) !== url.searchParams.get('digest'))
          return new Response('digest mismatch', { status: 400 })
        blobs.set(`${repo}@${digest(body)}`, body)
        return new Response(null, { status: 201 })
      }
      if (path.startsWith('blobs/')) {
        const blob = blobs.get(`${repo}@${path.slice('blobs/'.length)}`)
        return blob ? new Response(request.method === 'HEAD' ? null : blob) : new Response(null, { status: 404 })
      }
      const reference = path.slice('manifests/'.length)
      if (request.method === 'PUT') {
        const body = new Uint8Array(await request.arrayBuffer())
        manifests.set(`${repo}@${reference}`, body)
        manifests.set(`${repo}@${digest(body)}`, body)
        return new Response(null, { status: 201 })
      }
      const manifest = manifests.get(`${repo}@${reference}`)
      return manifest ? new Response(manifest) : new Response(null, { status: 404 })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
    put: (tag, body) => manifests.set(`${NAME}@${tag}`, new TextEncoder().encode(body)),
    blob: (digest, body) => blobs.set(`${NAME}@${digest}`, body),
  }
}

// GitHub's record of the release tag, and a repository with no earlier release.
function github(commit: () => string): { url: string, stop: () => void } {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === `/repos/${NAME}/git/ref/tags/${TAG}`)
        return Response.json({ object: { type: 'commit', sha: commit() } })
      if (url.pathname === `/repos/${NAME}/releases`)
        return Response.json([])
      return new Response(null, { status: 404 })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

describe('publication', () => {
  const work = workdir('publish')
  const repo = join(work, 'mica-system-base')
  const out = join(repo, '_out')
  const saved = { ...process.env }
  let server: ReturnType<typeof registry>
  let api: ReturnType<typeof github>
  let commit = ''
  const version = '1.0-1'
  const git = (...args: string[]): string => {
    const result = run(['git', '-C', repo, ...args], { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' })
    if (result.code !== 0)
      throw new Error(result.output)
    return result.output.trim()
  }
  const use = (target: ReturnType<typeof registry>): void => {
    process.env.MICA_OCI_REGISTRY = target.url
  }

  function deb(name: string, arch: string, pools: string[], extra = ''): void {
    const tree = join(work, 'tree', `${name}-${arch}`)
    rmSync(tree, { recursive: true, force: true })
    mkdirSync(join(tree, 'DEBIAN'), { recursive: true })
    mkdirSync(join(tree, 'usr/share/doc', name), { recursive: true })
    writeFileSync(join(tree, 'usr/share/doc', name, 'copyright'), 'fixture\n')
    writeFileSync(join(tree, 'DEBIAN/control'), `Package: ${name}\nVersion: ${version}\nArchitecture: ${arch}\nMaintainer: Mica OS <hi@micaos.dev>\nDescription: fixture\nMica-Source-Repo: mica-system-base\n${extra}`)
    for (const pool of pools) {
      mkdirSync(join(out, 'debs', pool, 'pool'), { recursive: true })
      const built = run(['dpkg-deb', '--build', '--root-owner-group', tree, join(out, 'debs', pool, 'pool', `${name}_${version}_${arch}.deb`)], { SOURCE_DATE_EPOCH: '1757800000' })
      if (built.code !== 0)
        throw new Error(built.output)
    }
  }
  function debs(): void {
    deb('fixture-data', 'all', ['amd64', 'arm64'])
    deb('fixture-tool', 'amd64', ['amd64'])
    deb('fixture-tool', 'arm64', ['arm64'])
  }

  beforeAll(() => {
    server = registry()
    api = github(() => commit)
    use(server)
    process.env.MICA_GITHUB_API = api.url
    process.env.GH_TOKEN = 'test-token'
    for (const [name, arches] of [['fixture-data', 'all'], ['fixture-tool', 'amd64,arm64']] as const) {
      mkdirSync(join(repo, 'debs', name), { recursive: true })
      writeFileSync(join(repo, 'debs', name, 'Dockerfile'), `# mica-deb: arches=${arches}\n`)
      writeFileSync(join(repo, 'debs', name, 'control'), `Package: ${name}\nVersion: ${version}\nSource-Date-Epoch: 1757800000\n`)
      writeFileSync(join(repo, 'debs', name, 'mica-inputs'), `# mica-inputs v1\npackage ${name}\n`)
    }
    writeFileSync(join(repo, 'package.json'), '{ "name": "mica-system-base" }\n')
    writeFileSync(join(repo, '.gitignore'), '_out/\n')
    writeFileSync(join(repo, 'sources.json'), readFileSync(join(REPO, 'sources.json')))
    // One upstream package pinned for later stages, as the release lock lists it.
    writeFileSync(join(repo, 'debs/consumers.pkgs'), 'upstream-*\n')
    mkdirSync(join(repo, 'locks'))
    writePins(repo, ['amd64', 'arm64'].map((arch, index) => ({ name: 'libfixture', arch, version: '1.0-1', sha: 'ab'[index]!.repeat(64), url: `${UPSTREAM_URL}_${arch}.deb`, consumers: ['upstream-libfixture', 'upstream-tool'] })))
    git('init', '-q')
    git('add', '.')
    git('commit', '-q', '-m', 'fixture')
    git('tag', TAG)
    git('update-ref', 'refs/remotes/origin/main', 'HEAD')
    commit = git('rev-parse', 'HEAD')
    // The producer-data assets a release names with its `data` rows.
    mkdirSync(join(out, 'rootfs'), { recursive: true })
    for (const arch of ['amd64', 'arm64'] as const)
      writeFileSync(join(out, `rootfs/${arch}.unowned.tsv`), `/etc/passwd\tbootstrap seed\n/etc/pam.d/common-auth\tpam-auth-update (libpam-runtime.postinst)\n/etc/${arch}.conf\tunknown\n`)
    debs()
  })
  afterAll(() => {
    server.stop()
    api.stop()
    process.env = saved
    rmSync(work, { recursive: true, force: true })
  })

  // One attempt's roots: a real tar layer per architecture whose /etc/issue names
  // `built` unless `named` says otherwise. `attempts` counts the roots packed.
  let attempts = 0
  function roots(built: string, named = built): () => RootfsBuild {
    return () => {
      attempts++
      const layers: RootfsBuild['layers'] = new Map()
      for (const arch of ['amd64', 'arm64'] as const) {
        const tree = join(work, 'roots', `${attempts}-${arch}`)
        mkdirSync(join(tree, 'etc'), { recursive: true })
        writeFileSync(join(tree, 'etc/issue'), issue(TAG, commit, named))
        writeFileSync(join(tree, 'etc/arch'), `${arch} ${attempts}\n`)
        const packed = run(['tar', '-C', tree, '-cf', `${tree}.tar`, '.'])
        if (packed.code !== 0)
          throw new Error(packed.output)
        const tar = new Uint8Array(readFileSync(`${tree}.tar`))
        layers.set(arch, { gzip: Bun.gzipSync(tar), diffId: `sha256:${sha256(tar)}` })
      }
      return { layers, built }
    }
  }
  const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)
  // A manifest or blob as the publishing credential reads it.
  const get = async (target: ReturnType<typeof registry>, path: string): Promise<Uint8Array> =>
    new Uint8Array(await (await fetch(`${target.url}/v2/${NAME}/${path}`, { headers: { Authorization: 'Bearer user' } })).arrayBuffer())
  const rootIndex = async (target = server): Promise<{ body: string, manifests: { digest: string, platform: { architecture: string } }[], annotations: Record<string, string> }> => {
    const body = text(await get(target, `manifests/rootfs.${TAG}`))
    return { body, ...JSON.parse(body) }
  }
  // The /etc/issue inside the published amd64 layer.
  const publishedIssue = async (target = server): Promise<string> => {
    const index = await rootIndex(target)
    const manifest = JSON.parse(text(await get(target, `manifests/${index.manifests[0]!.digest}`))) as { layers: { digest: string }[] }
    const layer = await get(target, `blobs/${manifest.layers[0]!.digest}`)
    return text(Bun.spawnSync(['tar', '-xOf', '-', './etc/issue'], { stdin: Bun.gunzipSync(new Uint8Array(layer)) }).stdout)
  }

  test('the rootfs is one index over both architectures, and a later attempt keeps it', async () => {
    const built = '2026-09-13T21:40:00Z'
    const line = await publishRootfs(repo, TAG, roots(built))
    expect(line).toContain(`${NAME}:rootfs.${TAG} (pushed`)
    const index = await rootIndex()
    expect(index.manifests.map(entry => entry.platform.architecture)).toEqual(['amd64', 'arm64'])
    expect(index.annotations['org.opencontainers.image.revision']).toBe(commit)
    expect(index.annotations['org.opencontainers.image.version']).toBe(TAG)
    expect(index.annotations['org.opencontainers.image.created']).toBe(built)
    const packed = attempts
    const again = await publishRootfs(repo, TAG, roots('2026-09-14T08:00:00Z'))
    expect(again).toContain(`(present, built ${built}, sha256:${sha256(new TextEncoder().encode(index.body))}`)
    expect(attempts).toBe(packed)
    expect((await rootIndex()).body).toBe(index.body)
  })

  test('an attempt that wrote the index but failed its anonymous read-back is finished by the next attempt', async () => {
    const access = { private: true }
    const interrupted = registry(access)
    use(interrupted)
    try {
      const first = '2026-09-13T22:00:00Z'
      await expect(publishRootfs(repo, TAG, roots(first))).rejects.toThrow('cannot be pulled anonymously')
      const index = await rootIndex(interrupted)
      expect(index.annotations['org.opencontainers.image.created']).toBe(first)
      await expect(publishRootfs(repo, TAG, roots('2026-09-13T23:00:00Z'))).rejects.toThrow('cannot be pulled anonymously')
      access.private = false
      const packed = attempts
      const line = await publishRootfs(repo, TAG, roots('2026-09-14T09:00:00Z'))
      expect(line).toContain(`(present, built ${first}, sha256:${sha256(new TextEncoder().encode(index.body))}`)
      expect(attempts).toBe(packed)
      expect((await rootIndex(interrupted)).body).toBe(index.body)
      expect(await publishedIssue(interrupted)).toBe(issue(TAG, commit, first))
    }
    finally {
      interrupted.stop()
      use(server)
    }
  })

  test('an existing root of another release, commit or content is refused, not finished', async () => {
    const built = '2026-09-13T21:40:00Z'
    const refused = async (tamper: (target: ReturnType<typeof registry>, index: Awaited<ReturnType<typeof rootIndex>>) => Promise<void> | void, message: string): Promise<void> => {
      const conflicting = registry()
      use(conflicting)
      try {
        await publishRootfs(repo, TAG, roots(built))
        await tamper(conflicting, await rootIndex(conflicting))
        await expect(publishRootfs(repo, TAG, roots('2026-09-14T10:00:00Z'))).rejects.toThrow(message)
      }
      finally {
        conflicting.stop()
        use(server)
      }
    }
    await refused((target, index) => target.put(`rootfs.${TAG}`, index.body.replaceAll(commit, 'f'.repeat(40))), `is not ${TAG} at ${commit}: its index does not name this release`)
    await refused((target, index) => target.put(`rootfs.${TAG}`, index.body.replaceAll(`"${TAG}"`, '"20260914-0129"')), 'its index does not name this release')
    await refused(target => target.put(`rootfs.${TAG}`, '{"schemaVersion":2}'), 'its index does not name this release')
    await refused(async (target, index) => {
      const manifest = JSON.parse(text(await get(target, `manifests/${index.manifests[1]!.digest}`))) as { layers: { digest: string }[] }
      target.blob(manifest.layers[0]!.digest, new TextEncoder().encode('other bytes'))
    }, 'is not served anonymously')
    // A root whose own /etc/issue names another build time: refused when published and on every later attempt.
    const relabelled = registry()
    use(relabelled)
    try {
      await expect(publishRootfs(repo, TAG, roots(built, '2026-09-12T00:00:00Z'))).rejects.toThrow('/etc/issue')
      await expect(publishRootfs(repo, TAG, roots(built))).rejects.toThrow('/etc/issue')
    }
    finally {
      relabelled.stop()
      use(server)
    }
  })

  test('mica-system-base.lock names the published rootfs, pools and packages by digest, beside its data assets', async () => {
    const pools = await publishPools(repo, 'mica-system-base', TAG, ['amd64', 'arm64'])
    const at = `ghcr.io/${NAME}`
    const index = await get(server, `manifests/rootfs.${TAG}`)
    const platforms = (JSON.parse(text(index)) as { manifests: { digest: string }[] }).manifests.map(entry => entry.digest)
    const archive = (arch: string, file: string): string => sha256(new Uint8Array(readFileSync(join(out, 'debs', arch, 'pool', file))))
    const data = dataAssets(repo, releaseOf(repo))
    const expected = [
      '# mica-lock v1',
      `# mica-system-base.lock: mica-system-base ${TAG}, written when the release was published.`,
      `release\tmica-system-base\t${TAG}\t${commit}`,
      `image\tmica-system-base\trootfs\tamd64\t${at}@${platforms[0]}`,
      `image\tmica-system-base\trootfs\tarm64\t${at}@${platforms[1]}`,
      `image\tmica-system-base\trootfs\tindex\t${at}:rootfs.${TAG}@sha256:${sha256(index)}`,
      ...pools.filter(row => row.startsWith('pool\t')),
      `package\tfixture-data\tamd64\t${version}\t${archive('amd64', `fixture-data_${version}_all.deb`)}`,
      `package\tfixture-data\tarm64\t${version}\t${archive('arm64', `fixture-data_${version}_all.deb`)}`,
      `package\tfixture-tool\tamd64\t${version}\t${archive('amd64', `fixture-tool_${version}_amd64.deb`)}`,
      `package\tfixture-tool\tarm64\t${version}\t${archive('arm64', `fixture-tool_${version}_arm64.deb`)}`,
      `upstream\tlibfixture\tamd64\t1.0-1\t${'a'.repeat(64)}\t${UPSTREAM_URL}_amd64.deb\tlibfixture,tool`,
      `upstream\tlibfixture\tarm64\t1.0-1\t${'b'.repeat(64)}\t${UPSTREAM_URL}_arm64.deb\tlibfixture,tool`,
      `apt\t${sources().mirror}\t${sources().suite}\tmain\t/usr/share/keyrings/debian-archive-keyring.gpg`,
      ...data.map(asset => `data\t${asset.name}\t${asset.file}\t${asset.sha256}`),
      '',
    ].join('\n')
    // The package rows are the ones `release pool` printed.
    expect(expected.split('\n').filter(row => row.startsWith('package\t'))).toEqual(pools.filter(row => row.startsWith('package\t')))
    const written = await writeLock(repo, out, TAG)
    expect(readFileSync(written.lock, 'utf8')).toBe(expected)
    expect(parseLock(expected, 'mica-system-base.lock').release).toBe(TAG)
    // The data files `release attach` takes, under the names their rows give.
    expect(written.data.map(path => path.slice(join(out, 'release').length + 1))).toEqual(data.map(asset => asset.file))
    for (const [position, asset] of data.entries())
      expect(sha256(readFileSync(written.data[position]!))).toBe(asset.sha256)
  })

  test('a dry run writes the lock of the local pools and root layers without a registry', () => {
    const layer = (arch: string): { gzip: Uint8Array, diffId: string } => ({ gzip: Bun.gzipSync(new TextEncoder().encode(`${arch} root`)), diffId: `sha256:${sha256(new TextEncoder().encode(`${arch} root`))}` })
    for (const arch of ['amd64', 'arm64'] as const)
      writeLayer(join(out, 'layers'), arch, layer(arch), '2026-09-14T01:40:00Z')
    const lock = dryRunLock(repo, TAG)
    const parsed = parseLock(lock, 'mica-system-base.lock')
    const images = rootfsImages(releaseOf(repo), readLayers(join(out, 'layers')))
    expect(parsed.rows.find(row => row[0] === 'image' && row[3] === 'index')![4]).toBe(`ghcr.io/${NAME}:rootfs.${TAG}@sha256:${sha256(images.index)}`)
    expect(parsed.rows.filter(row => row[0] === 'package').map(row => row.slice(1, 3).join(' '))).toEqual(['fixture-data amd64', 'fixture-data arm64', 'fixture-tool amd64', 'fixture-tool arm64'])
    // The pools of a dry run are the ones `release pool` publishes.
    expect(parsed.rows.filter(row => row[0] === 'pool').map(row => row[2])).toEqual(readFileSync(join(out, 'release', 'mica-system-base.lock'), 'utf8').split('\n').filter(row => row.startsWith('pool\t')).map(row => row.split('\t')[2]))
    expect(() => dryRunLock(repo, '2026-09-14')).toThrow('is not YYYYMMDD-HHMM')
  })

  test('the gate takes the declared packages, pool gate and pool guard; a Replaces is refused', async () => {
    expect(await gate(repo)).toEqual([
      `the ${TAG} pools hold amd64: 2, arm64: 2 archives of the declared packages`,
      'pool gate: 4 archives pass',
      ...([['amd64', 'fixture-data', 'all'], ['amd64', 'fixture-tool', 'amd64'], ['arm64', 'fixture-data', 'all'], ['arm64', 'fixture-tool', 'arm64']] as const).map(([pool, name, arch]) =>
        `pool guard: ${pool} ${name} ${version} new ${sha256(new Uint8Array(readFileSync(join(out, 'debs', pool, 'pool', `${name}_${version}_${arch}.deb`))))}`),
    ])
    deb('fixture-tool', 'arm64', ['arm64'], 'Replaces: fixture-data\n')
    await expect(gate(repo)).rejects.toThrow('declares Replaces')
    debs()
  })

  test('the pools hold exactly the declared packages of this repository', () => {
    expect(assertPools(repo, out, releaseOf(repo)).get('arm64')).toEqual([`fixture-data_${version}_all.deb`, `fixture-tool_${version}_arm64.deb`])
    rmSync(join(out, 'debs', 'arm64', 'pool', `fixture-data_${version}_all.deb`))
    expect(() => assertPools(repo, out, releaseOf(repo))).toThrow('the arm64 pool is')
    debs()
    const tree = join(work, 'tree', 'other')
    mkdirSync(join(tree, 'DEBIAN'), { recursive: true })
    writeFileSync(join(tree, 'DEBIAN/control'), `Package: fixture-tool\nVersion: ${version}\nArchitecture: arm64\nMaintainer: Mica OS <hi@micaos.dev>\nDescription: fixture\nMica-Source-Repo: mica-other\n`)
    run(['dpkg-deb', '--build', '--root-owner-group', tree, join(out, 'debs', 'arm64', 'pool', `fixture-tool_${version}_arm64.deb`)])
    expect(() => assertPools(repo, out, releaseOf(repo))).toThrow('was not built from')
    debs()
  })

  test('a released root may not carry a snapshot banner', () => {
    const tree = join(work, 'banner')
    mkdirSync(join(tree, 'etc'), { recursive: true })
    const release = releaseOf(repo)
    const snapshot = { ...release, label: `20260914-0102~git${commit.slice(0, 12)}`, released: false }
    writeFileSync(join(tree, 'etc/issue'), issue(snapshot.label, commit, '2026-09-14T01:40:00Z'))
    // A local build carries a snapshot label and that is what it is.
    expect(assertBanner(tree, snapshot)).toBe('2026-09-14T01:40:00Z')
    // The same banner in a release build is refused: a published root says its release.
    expect(() => assertBanner(tree, { ...snapshot, released: true })).toThrow('names the snapshot')
    // A release root names its release, its commit and nothing else.
    writeFileSync(join(tree, 'etc/issue'), issue(release.label, commit, '2026-09-14T01:40:00Z'))
    expect(assertBanner(tree, release)).toBe('2026-09-14T01:40:00Z')
    writeFileSync(join(tree, 'etc/issue'), issue(release.label, 'f'.repeat(40), '2026-09-14T01:40:00Z'))
    expect(() => assertBanner(tree, release)).toThrow('does not name')
  })

  test('each architecture packs its root layer; the index takes both with one build time', () => {
    const layers = join(work, 'layers')
    const layer = (text: string): { gzip: Uint8Array, diffId: string } => ({ gzip: Bun.gzipSync(new TextEncoder().encode(text)), diffId: `sha256:${sha256(new TextEncoder().encode(text))}` })
    writeLayer(layers, 'amd64', layer('amd64 root'), '2026-09-14T01:40:00Z')
    expect(() => readLayers(layers)).toThrow('no arm64 root layer')
    writeLayer(layers, 'arm64', layer('arm64 root'), '2026-09-14T01:41:00Z')
    expect(() => readLayers(layers)).toThrow('different build times')
    writeLayer(layers, 'arm64', layer('arm64 root'), '2026-09-14T01:40:00Z')
    const read = readLayers(layers)
    expect(read.built).toBe('2026-09-14T01:40:00Z')
    expect(read.layers.get('arm64')).toEqual(layer('arm64 root'))
    writeFileSync(join(layers, 'amd64', 'diff-id'), 'sha256:short\n')
    expect(() => readLayers(layers)).toThrow('diff-id')
  })

  test('a dirty or untagged checkout publishes nothing', async () => {
    const fresh = registry()
    use(fresh)
    try {
      writeFileSync(join(repo, 'NOTES'), 'uncommitted\n')
      await expect(publishRootfs(repo, TAG, roots('2026-09-14T11:00:00Z'))).rejects.toThrow('uncommitted changes')
      git('add', 'NOTES')
      git('commit', '-q', '-m', 'after the release')
      git('update-ref', 'refs/remotes/origin/main', 'HEAD')
      await expect(publishRootfs(repo, TAG, roots('2026-09-14T11:00:00Z'))).rejects.toThrow('not the checked-out commit')
    }
    finally {
      fresh.stop()
      use(server)
    }
  })
})
