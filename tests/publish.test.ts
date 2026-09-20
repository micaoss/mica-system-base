// src/publish.ts against an in-process OCI registry: the pool and rootfs tags,
// idempotent republication, a later attempt finishing a release, and the refusals.
import type { ReleaseAssets, RootfsBuild } from '../src/publish.ts'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { declared, inputsHash } from '../src/debs/docker.ts'
import { assertBanner, assertPools, assertVersions, dataAssets, dryRunLock, poolManifest, priorRelease, publishLock, publishPool, publishRootfs, readLayers, rootfsImages, writeLayer } from '../src/publish.ts'
import { Registry, sha256 } from '../src/registry.ts'
import { parseLock } from '../src/release-lock.ts'
import { issue, releaseOf } from '../src/release.ts'
import { REPO, run, workdir, writePins } from './fixture.ts'

const UPSTREAM_URL = 'https://snapshot.debian.org/archive/debian/20260905T000000Z/pool/main/l/libfixture/libfixture_1.0-1'

// Just enough of the distribution API. The token endpoint issues 'anonymous'
// without credentials and 'user' with them; a private registry refuses the
// anonymous bearer.
function registry(options: { private?: boolean } = {}): { port: number, stop: () => void, put: (repo: string, tag: string, body: string) => void, blob: (repo: string, digest: string, body: Uint8Array) => void } {
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
      const match = /^\/v2\/(.+)\/(tags\/list|blobs\/uploads\/.*|blobs\/sha256:[0-9a-f]{64}|manifests\/[^/]+)$/.exec(url.pathname)
      if (!match)
        return new Response('not found', { status: 404 })
      const [, repo = '', path = ''] = match
      if (path === 'tags/list')
        return Response.json({ name: repo, tags: [] })
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
    port: server.port!,
    stop: () => server.stop(true),
    put: (repo, tag, body) => manifests.set(`${repo}@${tag}`, new TextEncoder().encode(body)),
    blob: (repo, digest, body) => blobs.set(`${repo}@${digest}`, body),
  }
}

describe('publication', () => {
  const work = workdir('publish')
  const repo = join(work, 'mica-system-base')
  const out = join(work, 'out')
  let server: ReturnType<typeof registry>
  let commit = ''
  let version = ''
  const git = (...args: string[]): string => {
    const result = run(['git', '-C', repo, ...args], { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' })
    if (result.code !== 0)
      throw new Error(result.output)
    return result.output.trim()
  }
  const client = (port = server.port): Registry => new Registry(`127.0.0.1:${port}/testorg`, 'test', 'test-token', true)

  function deb(name: string, arch: string, pools: string[], source = 'mica-system-base', description = 'fixture'): void {
    const tree = join(work, 'tree', `${name}-${arch}`)
    rmSync(tree, { recursive: true, force: true })
    mkdirSync(join(tree, 'DEBIAN'), { recursive: true })
    writeFileSync(join(tree, 'DEBIAN/control'), `Package: ${name}\nVersion: ${version}\nArchitecture: ${arch}\nMaintainer: Mica OS <hi@micaos.dev>\nDescription: ${description}\nMica-Source-Repo: ${source}\n`)
    for (const pool of pools) {
      mkdirSync(join(out, 'debs', pool, 'pool'), { recursive: true })
      const built = run(['dpkg-deb', '--build', '--root-owner-group', tree, join(out, 'debs', pool, 'pool', `${name}_${version}_${arch}.deb`)], { SOURCE_DATE_EPOCH: '1757800000' })
      if (built.code !== 0)
        throw new Error(built.output)
    }
  }

  beforeAll(() => {
    server = registry()
    for (const [name, arches] of [['fixture-data', 'all'], ['fixture-tool', 'amd64,arm64']] as const) {
      mkdirSync(join(repo, 'debs', name), { recursive: true })
      writeFileSync(join(repo, 'debs', name, 'Dockerfile'), `# mica-deb: arches=${arches}\n`)
      writeFileSync(join(repo, 'debs', name, 'control'), `Package: ${name}\nVersion: 1.0-1\nSource-Date-Epoch: 1757800000\n`)
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
    git('tag', '20260914-0130')
    commit = git('rev-parse', 'HEAD')
    version = '1.0-1'
    // The producer-data assets a release names with its `data` rows.
    mkdirSync(join(repo, '_out/rootfs'), { recursive: true })
    for (const arch of ['amd64', 'arm64'] as const)
      writeFileSync(join(repo, `_out/rootfs/${arch}.unowned.tsv`), `/etc/passwd\tbootstrap seed\n/etc/pam.d/common-auth\tpam-auth-update (libpam-runtime.postinst)\n/etc/${arch}.conf\tunknown\n`)
    deb('fixture-data', 'all', ['amd64', 'arm64'])
    deb('fixture-tool', 'amd64', ['amd64'])
    deb('fixture-tool', 'arm64', ['arm64'])
  })
  afterAll(() => {
    server.stop()
    rmSync(work, { recursive: true, force: true })
  })

  test('a pool names no release: its manifest carries the repository, the architecture and each package\'s inputs', () => {
    const release = releaseOf(repo)
    const pools = assertPools(repo, out, release)
    const { manifest, layers } = poolManifest(repo, release, 'arm64', join(out, 'debs', 'arm64', 'pool'), pools.get('arm64')!)
    expect((JSON.parse(text(manifest)) as { annotations: Record<string, string> }).annotations).toEqual({ 'mica.source-repo': 'mica-system-base', 'mica.arch': 'arm64' })
    const data = declared(repo).find(entry => entry.name === 'fixture-data')!
    expect(layers.map(layer => layer.annotations)).toEqual([
      { 'org.opencontainers.image.title': `fixture-data_${version}_all.deb`, 'mica.inputs': inputsHash(repo, data, 'all') },
      { 'org.opencontainers.image.title': `fixture-tool_${version}_arm64.deb`, 'mica.inputs': inputsHash(repo, declared(repo).find(entry => entry.name === 'fixture-tool')!, 'arm64') },
    ])
    // Another release label gives the same manifest.
    expect(sha256(poolManifest(repo, { ...release, label: '20261001-0000', commit: 'f'.repeat(40) }, 'arm64', join(out, 'debs', 'arm64', 'pool'), pools.get('arm64')!).manifest)).toBe(sha256(manifest))
  })

  test('a package is locked by its version against the latest release', async () => {
    const release = releaseOf(repo)
    const pools = assertPools(repo, out, release)
    const published = (arch: 'amd64' | 'arm64'): { name: string, version: string, digest: string, inputs: string }[] => poolManifest(repo, release, arch, join(out, 'debs', arch, 'pool'), pools.get(arch)!).layers.map(layer => ({
      name: layer.annotations['org.opencontainers.image.title']!.split('_')[0]!,
      version,
      digest: layer.digest,
      inputs: layer.annotations['mica.inputs']!,
    }))
    const prior = (change: (entry: { name: string, version: string, digest: string, inputs: string }) => object = entry => entry): { label: string, pools: Map<'amd64' | 'arm64', { name: string, version: string, digest: string, inputs: string }[]> } =>
      ({ label: '20260901-0000', pools: new Map((['amd64', 'arm64'] as const).map(arch => [arch, published(arch).map(entry => ({ ...entry, ...change(entry) }))])) })
    expect(assertVersions(repo, out, release, undefined)).toContain(`amd64 fixture-tool ${version}: new`)
    expect(assertVersions(repo, out, release, prior())).toContain(`arm64 fixture-data ${version}: reused from 20260901-0000, byte-identical`)
    expect(assertVersions(repo, out, release, prior(() => ({ version: '0.9-1' })))).toContain(`amd64 fixture-tool ${version}: built, above 0.9-1 of 20260901-0000`)
    expect(() => assertVersions(repo, out, release, prior(() => ({ version: '1.1-1' })))).toThrow('is not higher than 1.1-1')
    expect(() => assertVersions(repo, out, release, prior(() => ({ inputs: 'e'.repeat(64) })))).toThrow('inputs of fixture-data changed without a version bump')
    expect(() => assertVersions(repo, out, release, prior(() => ({ digest: `sha256:${'e'.repeat(64)}` })))).toThrow('bump its version')

    // The prior release is read as a consumer reads it: its lock, SHA256SUMS and pools.
    const later = { ...release, label: '20260914-0200' }
    const earlier = assets()
    await expect(priorRelease(later, client(), earlier)).resolves.toBeUndefined()
    earlier.files.set('20260914-0130/mica-system-base.lock', new TextEncoder().encode('# mica-lock v1\n'))
    await expect(priorRelease(later, client(), earlier)).rejects.toThrow('does not serve a mica-system-base.lock its SHA256SUMS lists')
    // A release from before version-locked packages records no inputs: nothing is compared.
    expect(assertVersions(repo, out, release, { label: '20260901-0000', pools: new Map(), predates: true })).toContain(`amd64 fixture-tool ${version}: built; release 20260901-0000 predates version-locked packages`)
  })

  test('the pools are pushed once per architecture and recognised when present', async () => {
    // With no earlier release every package is new; then each pool is pushed.
    const first = await publishPool(repo, out, client(), assets())
    expect(first.slice(0, 4)).toEqual(['amd64', 'amd64', 'arm64', 'arm64'].map((arch, index) => `${arch} fixture-${index % 2 ? 'tool' : 'data'} ${version}: new`))
    expect(first[4]).toContain('testorg/mica-system-base:pool.amd64.20260914-0130 (pushed')
    expect(first[5]).toContain('(pushed')
    const again = await publishPool(repo, out, client(), assets())
    expect(again.slice(4).every(line => line.includes('(present'))).toBe(true)
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
        writeFileSync(join(tree, 'etc/issue'), issue('20260914-0130', commit, named))
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
  const rootIndex = async (port = server.port): Promise<{ body: string, manifests: { digest: string, platform: { architecture: string } }[], annotations: Record<string, string> }> => {
    const body = text((await client(port).manifest('testorg/mica-system-base', 'rootfs.20260914-0130')).body)
    return { body, ...JSON.parse(body) }
  }
  // The /etc/issue inside the published amd64 layer.
  const publishedIssue = async (port = server.port): Promise<string> => {
    const index = await rootIndex(port)
    const manifest = JSON.parse(text((await client(port).manifest('testorg/mica-system-base', index.manifests[0]!.digest)).body)) as { layers: { digest: string }[] }
    const layer = await client(port).request('GET', 'testorg/mica-system-base', 'pull', `blobs/${manifest.layers[0]!.digest}`)
    return text(Bun.spawnSync(['tar', '-xOf', '-', './etc/issue'], { stdin: Bun.gunzipSync(layer.body) }).stdout)
  }

  test('the rootfs is one index over both architectures, and a later attempt keeps it', async () => {
    const built = '2026-09-13T21:40:00Z'
    const line = await publishRootfs(repo, roots(built), client())
    expect(line).toContain('testorg/mica-system-base:rootfs.20260914-0130 (pushed')
    const index = await rootIndex()
    expect(index.manifests.map(entry => entry.platform.architecture)).toEqual(['amd64', 'arm64'])
    expect(index.annotations['org.opencontainers.image.revision']).toBe(commit)
    expect(index.annotations['org.opencontainers.image.version']).toBe('20260914-0130')
    expect(index.annotations['org.opencontainers.image.created']).toBe(built)
    const packed = attempts
    const again = await publishRootfs(repo, roots('2026-09-14T08:00:00Z'), client())
    expect(again).toContain(`(present, built ${built}, sha256:${sha256(new TextEncoder().encode(index.body))}`)
    expect(attempts).toBe(packed)
    expect((await rootIndex()).body).toBe(index.body)
  })

  test('an attempt that wrote the index but failed its anonymous read-back is finished by the next attempt', async () => {
    const access = { private: true }
    const interrupted = registry(access)
    try {
      const first = '2026-09-13T22:00:00Z'
      await expect(publishRootfs(repo, roots(first), client(interrupted.port))).rejects.toThrow('cannot be pulled anonymously')
      const index = await rootIndex(interrupted.port)
      expect(index.annotations['org.opencontainers.image.created']).toBe(first)
      await expect(publishRootfs(repo, roots('2026-09-13T23:00:00Z'), client(interrupted.port))).rejects.toThrow('cannot be pulled anonymously')
      access.private = false
      const packed = attempts
      const line = await publishRootfs(repo, roots('2026-09-14T09:00:00Z'), client(interrupted.port))
      expect(line).toContain(`(present, built ${first}, sha256:${sha256(new TextEncoder().encode(index.body))}`)
      expect(attempts).toBe(packed)
      expect((await rootIndex(interrupted.port)).body).toBe(index.body)
      expect(await publishedIssue(interrupted.port)).toBe(issue('20260914-0130', commit, first))
    }
    finally {
      interrupted.stop()
    }
  })

  test('an existing root of another release, commit or content is refused, not finished', async () => {
    const built = '2026-09-13T21:40:00Z'
    const refused = async (tamper: (server: ReturnType<typeof registry>, index: Awaited<ReturnType<typeof rootIndex>>) => Promise<void> | void, message: string): Promise<void> => {
      const conflicting = registry()
      try {
        await publishRootfs(repo, roots(built), client(conflicting.port))
        await tamper(conflicting, await rootIndex(conflicting.port))
        await expect(publishRootfs(repo, roots('2026-09-14T10:00:00Z'), client(conflicting.port))).rejects.toThrow(message)
      }
      finally {
        conflicting.stop()
      }
    }
    await refused((server, index) => server.put('testorg/mica-system-base', 'rootfs.20260914-0130', index.body.replaceAll(commit, 'f'.repeat(40))), `is not 20260914-0130 at ${commit}: its index does not name this release`)
    await refused((server, index) => server.put('testorg/mica-system-base', 'rootfs.20260914-0130', index.body.replaceAll('"20260914-0130"', '"20260914-0129"')), 'its index does not name this release')
    await refused(server => server.put('testorg/mica-system-base', 'rootfs.20260914-0130', '{"schemaVersion":2}'), 'its index does not name this release')
    await refused(async (server, index) => {
      const manifest = JSON.parse(text((await client(server.port).manifest('testorg/mica-system-base', index.manifests[1]!.digest)).body)) as { layers: { digest: string }[] }
      server.blob('testorg/mica-system-base', manifest.layers[0]!.digest, new TextEncoder().encode('other bytes'))
    }, 'does not serve')
    // A root whose own /etc/issue names another build time: refused when published and on every later attempt.
    const relabelled = registry()
    try {
      await expect(publishRootfs(repo, roots(built, '2026-09-12T00:00:00Z'), client(relabelled.port))).rejects.toThrow('/etc/issue')
      await expect(publishRootfs(repo, roots(built), client(relabelled.port))).rejects.toThrow('/etc/issue')
    }
    finally {
      relabelled.stop()
    }
  })

  // The release assets as the GitHub Release serves them to anyone.
  // The release assets as the GitHub Release serves them: listed with the
  // workflow's token, downloaded by anyone. `early` records an anonymous download
  // of an asset before it was uploaded, which GitHub may answer with a cached 404.
  function assets(): ReleaseAssets & { files: Map<string, Uint8Array>, uploads: string[], early: string[] } {
    const files = new Map<string, Uint8Array>()
    const uploads: string[] = []
    const early: string[] = []
    return {
      files,
      uploads,
      early,
      releases: async () => [...new Set([...files.keys()].map(key => key.split('/')[0]!))],
      list: async tag => [...files.keys()].filter(key => key.startsWith(`${tag}/`)).map(key => key.slice(tag.length + 1)),
      download: async (tag, name) => {
        if (!files.has(`${tag}/${name}`))
          early.push(name)
        return files.get(`${tag}/${name}`)
      },
      upload: async (tag, name, bytes) => {
        uploads.push(name)
        files.set(`${tag}/${name}`, bytes)
      },
    }
  }

  test('mica-system-base.lock names the published rootfs, pools and packages by digest, with SHA256SUMS, and is never replaced', async () => {
    const name = 'testorg/mica-system-base'
    const at = 'ghcr.io/micaoss/mica-system-base'
    const index = (await client().manifest(name, 'rootfs.20260914-0130')).body
    const platforms = (JSON.parse(text(index)) as { manifests: { digest: string }[] }).manifests.map(entry => entry.digest)
    const pool = async (arch: string): Promise<string> => `sha256:${sha256((await client().manifest(name, `pool.${arch}.20260914-0130`)).body)}`
    const archive = (arch: string, file: string): string => sha256(new Uint8Array(readFileSync(join(out, 'debs', arch, 'pool', file))))
    const lock = [
      '# mica-lock v1',
      '# mica-system-base.lock: mica-system-base 20260914-0130, written when the release was published.',
      `release\tmica-system-base\t20260914-0130\t${commit}`,
      `image\tmica-system-base\trootfs\tamd64\t${at}@${platforms[0]}`,
      `image\tmica-system-base\trootfs\tarm64\t${at}@${platforms[1]}`,
      `image\tmica-system-base\trootfs\tindex\t${at}:rootfs.20260914-0130@sha256:${sha256(index)}`,
      `pool\tamd64\t${at}:pool.amd64.20260914-0130@${await pool('amd64')}`,
      `pool\tarm64\t${at}:pool.arm64.20260914-0130@${await pool('arm64')}`,
      `package\tfixture-data\tamd64\t${version}\t${archive('amd64', `fixture-data_${version}_all.deb`)}`,
      `package\tfixture-data\tarm64\t${version}\t${archive('arm64', `fixture-data_${version}_all.deb`)}`,
      `package\tfixture-tool\tamd64\t${version}\t${archive('amd64', `fixture-tool_${version}_amd64.deb`)}`,
      `package\tfixture-tool\tarm64\t${version}\t${archive('arm64', `fixture-tool_${version}_arm64.deb`)}`,
      `upstream\tlibfixture\tamd64\t1.0-1\t${'a'.repeat(64)}\t${UPSTREAM_URL}_amd64.deb\tlibfixture,tool`,
      `upstream\tlibfixture\tarm64\t1.0-1\t${'b'.repeat(64)}\t${UPSTREAM_URL}_arm64.deb\tlibfixture,tool`,
      'apt\thttps://snapshot.debian.org/archive/debian/20260905T000000Z\ttrixie\tmain\t/usr/share/keyrings/debian-archive-keyring.gpg',
      ...dataAssets(repo, releaseOf(repo)).map(asset => `data\t${asset.name}\t${asset.file}\t${asset.sha256}`),
      '',
    ].join('\n')
    const data = dataAssets(repo, releaseOf(repo))
    const release = assets()
    // The data files are uploaded before the lock that names them.
    expect(await publishLock(repo, client(), release)).toEqual([
      'mica-system-base-unowned.amd64.tsv (uploaded)',
      'mica-system-base-unowned.arm64.tsv (uploaded)',
      'mica-system-base.lock (uploaded)',
      'SHA256SUMS (uploaded)',
    ])
    for (const asset of data)
      expect(release.files.get(`20260914-0130/${asset.file}`)).toEqual(asset.bytes)
    // SHA256SUMS still lists only the lock; the data files hang off its rows.
    expect(parseLock(text(release.files.get('20260914-0130/mica-system-base.lock')!), 'lock').rows.filter(row => row[0] === 'data')).toHaveLength(2)
    expect(text(release.files.get('20260914-0130/mica-system-base.lock')!)).toBe(lock)
    expect(text(release.files.get('20260914-0130/SHA256SUMS')!)).toBe(`${sha256(new TextEncoder().encode(lock))}  mica-system-base.lock\n`)
    expect(parseLock(lock, 'mica-system-base.lock').release).toBe('20260914-0130')

    // The next release reads this one's packages back and reuses them.
    const prior = await priorRelease({ ...releaseOf(repo), label: '20260914-0200' }, client(), release)
    expect(prior?.label).toBe('20260914-0130')
    expect(assertVersions(repo, out, releaseOf(repo), prior)).toEqual([
      `amd64 fixture-data ${version}: reused from 20260914-0130, byte-identical`,
      `amd64 fixture-tool ${version}: reused from 20260914-0130, byte-identical`,
      `arm64 fixture-data ${version}: reused from 20260914-0130, byte-identical`,
      `arm64 fixture-tool ${version}: reused from 20260914-0130, byte-identical`,
    ])

    // A later attempt finds the same assets and uploads nothing; an interrupted one finishes.
    expect(await publishLock(repo, client(), release)).toEqual([
      'mica-system-base-unowned.amd64.tsv (present)',
      'mica-system-base-unowned.arm64.tsv (present)',
      'mica-system-base.lock (present)',
      'SHA256SUMS (present)',
    ])
    release.files.delete('20260914-0130/SHA256SUMS')
    expect((await publishLock(repo, client(), release)).at(-1)).toBe('SHA256SUMS (uploaded)')
    expect(release.uploads).toEqual(['mica-system-base-unowned.amd64.tsv', 'mica-system-base-unowned.arm64.tsv', 'mica-system-base.lock', 'SHA256SUMS', 'SHA256SUMS'])
    // Whether an asset exists is asked of the release, never of the download URL.
    expect(release.early).toEqual([])

    // A release carries nothing beside the lock and SHA256SUMS.
    const crowded = assets()
    crowded.files.set('20260914-0130/system-base.lock', new TextEncoder().encode('old\n'))
    await expect(publishLock(repo, client(), crowded)).rejects.toThrow('release 20260914-0130 carries system-base.lock')

    // An asset with other bytes is never replaced, and a read-back that differs fails.
    release.files.set('20260914-0130/mica-system-base.lock', new TextEncoder().encode('other\n'))
    await expect(publishLock(repo, client(), release)).rejects.toThrow('mica-system-base.lock of release 20260914-0130 exists with other content')
    const lossy = assets()
    lossy.upload = async (tag, file, bytes) => {
      lossy.files.set(`${tag}/${file}`, file === 'SHA256SUMS' ? new TextEncoder().encode('truncated') : bytes)
    }
    await expect(publishLock(repo, client(), lossy, async () => {})).rejects.toThrow('SHA256SUMS of release 20260914-0130 does not read back')

    // A just-uploaded asset may not be served yet: its read-back waits, within bounds.
    const slow = assets()
    let hidden = 0
    const download = slow.download
    slow.download = async (tag, file) => {
      if (slow.uploads.includes(file) && hidden < 3) {
        hidden++
        return undefined
      }
      return download(tag, file)
    }
    const waits: number[] = []
    expect(await publishLock(repo, client(), slow, async (ms) => {
      waits.push(ms)
    })).toEqual(['mica-system-base-unowned.amd64.tsv (uploaded)', 'mica-system-base-unowned.arm64.tsv (uploaded)', 'mica-system-base.lock (uploaded)', 'SHA256SUMS (uploaded)'])
    expect(waits).toEqual([10_000, 10_000, 10_000])
    const lost = assets()
    const upload = lost.upload
    lost.upload = async (tag, file, bytes) => upload(tag, file, bytes)
    lost.download = async () => undefined
    // The first asset uploaded is the first to be read back, and it is a data file.
    await expect(publishLock(repo, client(), lost, async () => {})).rejects.toThrow('mica-system-base-unowned.amd64.tsv of release 20260914-0130 does not read back')
    // A listed asset that is not served yet is waited for before it is compared.
    const listed = assets()
    await publishLock(repo, client(), listed, async () => {})
    let late = 2
    const served = listed.download
    listed.download = async (tag, file) => (late-- > 0 ? undefined : served(tag, file))
    expect(await publishLock(repo, client(), listed, async () => {})).toEqual(['mica-system-base-unowned.amd64.tsv (present)', 'mica-system-base-unowned.arm64.tsv (present)', 'mica-system-base.lock (present)', 'SHA256SUMS (present)'])
  })

  test('a dry run writes the lock of the local pools and root layers without a registry', () => {
    const layer = (arch: string): { gzip: Uint8Array, diffId: string } => ({ gzip: Bun.gzipSync(new TextEncoder().encode(`${arch} root`)), diffId: `sha256:${sha256(new TextEncoder().encode(`${arch} root`))}` })
    for (const arch of ['amd64', 'arm64'] as const)
      writeLayer(join(out, 'layers'), arch, layer(arch), '2026-09-14T01:40:00Z')
    const lock = dryRunLock(repo, out, '20260914-0130')
    const parsed = parseLock(lock, 'mica-system-base.lock')
    const images = rootfsImages(releaseOf(repo), readLayers(join(out, 'layers')))
    expect(parsed.rows.find(row => row[0] === 'image' && row[3] === 'index')![4]).toBe(`ghcr.io/micaoss/mica-system-base:rootfs.20260914-0130@sha256:${sha256(images.index)}`)
    expect(parsed.rows.filter(row => row[0] === 'package').map(row => row.slice(1, 3).join(' '))).toEqual(['fixture-data amd64', 'fixture-data arm64', 'fixture-tool amd64', 'fixture-tool arm64'])
    expect(() => dryRunLock(repo, out, '2026-09-14')).toThrow('is not YYYYMMDD-HHMM')
  })

  test('a tag holding other bytes is never re-pointed', async () => {
    server.put('testorg/mica-system-base', 'pool.amd64.20260914-0130', '{"schemaVersion":2}')
    await expect(publishPool(repo, out, client(), assets())).rejects.toThrow('never re-pointed')
  })

  test('a package that cannot be read anonymously fails the publication', async () => {
    const hidden = registry({ private: true })
    try {
      await expect(publishPool(repo, out, client(hidden.port), assets())).rejects.toThrow('cannot be pulled anonymously')
    }
    finally {
      hidden.stop()
    }
  })

  test('the pools of both architectures are one build: an all archive is the same bytes in each', () => {
    expect(assertPools(repo, out, releaseOf(repo)).get('arm64')).toEqual([`fixture-data_${version}_all.deb`, `fixture-tool_${version}_arm64.deb`])
    deb('fixture-data', 'all', ['arm64'], commit, 'another build')
    expect(() => assertPools(repo, out, releaseOf(repo))).toThrow(`fixture-data_${version}_all.deb differs between the amd64 and arm64 pools`)
    deb('fixture-data', 'all', ['arm64'])
    expect(() => assertPools(repo, out, releaseOf(repo))).not.toThrow()
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

  test('an archive of another repository, a missing archive, a dirty or untagged checkout are refused', async () => {
    const fresh = registry()
    try {
      deb('fixture-tool', 'arm64', ['arm64'], 'mica-other')
      await expect(publishPool(repo, out, client(fresh.port), assets())).rejects.toThrow('was not built from')
      deb('fixture-tool', 'arm64', ['arm64'])
      rmSync(join(out, 'debs', 'arm64', 'pool', `fixture-data_${version}_all.deb`))
      await expect(publishPool(repo, out, client(fresh.port), assets())).rejects.toThrow('the arm64 pool is')
      deb('fixture-data', 'all', ['arm64'])
      writeFileSync(join(repo, 'NOTES'), 'uncommitted\n')
      await expect(publishPool(repo, out, client(fresh.port), assets())).rejects.toThrow('is not a release')
      writeFileSync(join(repo, 'NOTES'), 'after the release\n')
      git('add', 'NOTES')
      git('commit', '-q', '-m', 'after the release')
      await expect(publishPool(repo, out, client(fresh.port), assets())).rejects.toThrow('is not a release')
    }
    finally {
      fresh.stop()
    }
  })
})
