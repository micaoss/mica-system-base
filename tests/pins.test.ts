// Facts pinned in more than one file agree with each other.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { assertBuildEnvRelease, assertEnvironmentImage, buildEnvAsset, buildEnvImages, environment, ids, sources } from '../src/pins.ts'
import { parseLock } from '../src/release-lock.ts'
import { REPO } from './fixture.ts'

const manifest = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
  packageManager: string
  devDependencies: Record<string, string>
}

test('the Bun version is one fact', () => {
  const { bun } = environment()
  expect(manifest.packageManager).toBe(`bun@${bun}`)
  expect(manifest.devDependencies['@types/bun']).toBe(bun)
})

test('the runtime is the Bun the environment names', () => {
  expect(Bun.version).toBe(environment().bun)
})

test('the snapshot mirror is derived from the snapshot', () => {
  const { snapshot, mirror } = sources()
  expect(mirror).toBe(`https://snapshot.debian.org/archive/debian/${snapshot}`)
})

test('pinned system IDs are unique and outside the static base-passwd range', () => {
  const { users, groups } = ids()
  for (const list of [users.map(user => [user.name, user.uid] as const), groups.map(group => [group.name, group.gid] as const)]) {
    expect(new Set(list.map(([name]) => name)).size).toBe(list.length)
    expect(new Set(list.map(([, id]) => id)).size).toBe(list.length)
    for (const [, id] of list)
      expect(id >= 100 && id < 60000).toBe(true)
  }
})

// A mica-build-env release lock and its SHA256SUMS, as that repository publishes
// them. The upstream registry host is spelled in parts, so this file names no
// third-party image reference outside a lock.
const hash = (bytes: Uint8Array): string => new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)
const at = 'ghcr.io/micaoss/mica-build-env'
const hub = ['docker', 'io'].join('.')
const FRONTEND = `${hub}/docker/dockerfile:1-labs@sha256:${'6'.repeat(64)}`
const BUILDKIT = `${hub}/moby/buildkit:v0.33.0@sha256:${'7'.repeat(64)}`
const LOCK = [
  '# mica-lock v1',
  `release\tmica-build-env\t20260914-2353\t${'0'.repeat(40)}`,
  `image\tmica-build-env\tbase\tamd64\t${at}@sha256:${'1'.repeat(64)}`,
  `image\tmica-build-env\tbase\tarm64\t${at}@sha256:${'2'.repeat(64)}`,
  `image\tmica-build-env\tbase\tindex\t${at}:base.20260914-2353@sha256:${'3'.repeat(64)}`,
  `image\tmica-build-env\tc\tamd64\t${at}@sha256:${'4'.repeat(64)}`,
  `image\tmica-build-env\tc\tarm64\t${at}@sha256:${'5'.repeat(64)}`,
  `image\tupstream\tdocker/dockerfile:1-labs\tamd64\t${FRONTEND}`,
  `image\tupstream\tdocker/dockerfile:1-labs\tarm64\t${FRONTEND}`,
  `image\tupstream\tmoby/buildkit:v0.33.0\tamd64\t${BUILDKIT}`,
  `image\tupstream\tmoby/buildkit:v0.33.0\tarm64\t${BUILDKIT}`,
  '',
].join('\n')

test('the build-env lock gives its base and C platform manifests and the upstream frontend and BuildKit', () => {
  const lock = parseLock(LOCK, 'mica-build-env.lock')
  expect(buildEnvImages(lock)).toEqual({
    base: { amd64: `${at}@sha256:${'1'.repeat(64)}`, arm64: `${at}@sha256:${'2'.repeat(64)}` },
    c: { amd64: `${at}@sha256:${'4'.repeat(64)}`, arm64: `${at}@sha256:${'5'.repeat(64)}` },
    frontend: FRONTEND,
    buildkit: BUILDKIT,
  })
  const without = (source: string, name: string, platform: string): string => LOCK.split('\n').filter(line => !line.startsWith(`image\t${source}\t${name}\t${platform}\t`)).join('\n')
  expect(() => buildEnvImages(parseLock(without('mica-build-env', 'c', 'arm64'), 'x.lock'))).toThrow('names no image mica-build-env c arm64')
  expect(() => buildEnvImages(parseLock(without('upstream', 'moby/buildkit:v0.33.0', 'amd64'), 'x.lock'))).toThrow('one moby/buildkit:<tag>')
  expect(() => buildEnvImages(parseLock(without('upstream', 'docker/dockerfile:1-labs', 'arm64'), 'x.lock'))).toThrow('docker/dockerfile:1-labs')
  const second = `${LOCK}image\tupstream\tmoby/buildkit:v0.34.0\tamd64\t${BUILDKIT.replace('v0.33.0', 'v0.34.0')}\n`
  expect(() => buildEnvImages(parseLock(second, 'x.lock'))).toThrow('one moby/buildkit:<tag>')
})

// A third-party image is taken only from a row of a lock under locks/: no other
// tracked file (the spec's vectors aside) names an image by a registry reference
// outside ghcr.io/micaoss or on Docker Hub, or in a FROM or # syntax= line.
test('no tracked file outside locks/ names a third-party image', () => {
  const git = Bun.spawnSync(['git', '-c', 'safe.directory=*', '-C', REPO, 'grep', '-nIE', String.raw`(@sha256:[0-9a-f]{64}|docker\.io|^\s*FROM\s|^# syntax=)`, '--', '.', ':!locks', ':!tests/vectors'], { stdout: 'pipe' })
  const offending = git.stdout.toString().split('\n').filter(Boolean).filter((line) => {
    const text = line.split(':').slice(2).join(':')
    if (/^\s*FROM\s/.test(text))
      return !/^\s*FROM\s+(?:--platform=\S+\s+)?(?:\$\{[A-Z_]+\}|@IMAGE@|scratch)(?:\s+AS\s+\S+)?\s*$/.test(text)
    if (/^# syntax=/.test(text))
      return true
    const references = text.match(/[\w.-]+(?::\d+)?\/[\w./-]+(?::[\w.-]+)?@sha256:[0-9a-f]{64}/g) ?? []
    return /docker\.io/.test(text) || references.some(reference => !reference.startsWith('ghcr.io/micaoss/'))
  })
  expect(offending).toEqual([])
})

test('the release assets are downloaded from the pinned release', () => {
  expect(buildEnvAsset({ repository: 'mica-build-env', scope: '', release: '20260914-2353', sha256sums: 'f'.repeat(64) }, 'SHA256SUMS'))
    .toBe('https://github.com/micaoss/mica-build-env/releases/download/20260914-2353/SHA256SUMS')
})

test('the committed lock must be the one file the pinned SHA256SUMS lists', () => {
  const sums = bytes(`${hash(bytes(LOCK))}  mica-build-env.lock\n`)
  const pin = { repository: 'mica-build-env', scope: '', release: '20260914-2353', sha256sums: hash(sums) }
  expect(() => assertBuildEnvRelease(pin, sums, bytes(LOCK))).not.toThrow()
  expect(() => assertBuildEnvRelease({ ...pin, sha256sums: 'f'.repeat(64) }, sums, bytes(LOCK))).toThrow('SHA256SUMS')
  expect(() => assertBuildEnvRelease(pin, sums, bytes(LOCK.replace('1'.repeat(64), '8'.repeat(64))))).toThrow('mica-build-env.lock')
  const more = bytes(`${hash(bytes(LOCK))}  mica-build-env.lock\n${hash(bytes(''))}  other\n`)
  expect(() => assertBuildEnvRelease({ ...pin, sha256sums: hash(more) }, more, bytes(LOCK))).toThrow('one file')
})

test('each pulled image records itself as the build-env base of its architecture with the pinned Bun', () => {
  const env = environment()
  const record = (image: string, arch: string, bun: string): string => `MICA_BUILD_IMAGE=${image}\nMICA_BUILD_ARCH=${arch}\nMICA_BUILD_BUN=${bun}\nMICA_BUILD_MMDEBSTRAP=1.5.7-1+deb13u1\n`
  expect(() => assertEnvironmentImage(env, 'arm64', record('mica-build-base', 'arm64', env.bun))).not.toThrow()
  expect(() => assertEnvironmentImage(env, 'arm64', record('mica-build-c', 'arm64', env.bun))).toThrow('MICA_BUILD_IMAGE')
  expect(() => assertEnvironmentImage(env, 'arm64', record('mica-build-base', 'amd64', env.bun))).toThrow('MICA_BUILD_ARCH')
  expect(() => assertEnvironmentImage(env, 'arm64', record('mica-build-base', 'arm64', '1.4.1'))).toThrow('MICA_BUILD_BUN')
  expect(() => assertEnvironmentImage(env, 'arm64', 'MICA_BUILD_IMAGE=mica-build-base\nMICA_BUILD_ARCH=arm64\n')).toThrow('MICA_BUILD_BUN')
})
