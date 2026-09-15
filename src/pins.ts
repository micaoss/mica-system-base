import type { Arch } from './lock.ts'
import type { Lock, Pin } from './release-lock.ts'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fail } from './errors.ts'
import { readInputs, underCi } from './release-lock.ts'

export const REPO = resolve(import.meta.dir, '..')

function readJson(file: string, repo = REPO): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(join(repo, file), 'utf8'))
  }
  catch (error) {
    fail(`${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${file}: expected an object`)
  return value as Record<string, unknown>
}

function text(record: Record<string, unknown>, key: string, file: string, pattern: RegExp): string {
  const value = record[key]
  if (typeof value !== 'string' || !pattern.test(value))
    fail(`${file}: invalid ${key}`)
  return value
}

// The build environment. environment.json holds the local tag of the environment
// image per architecture and the Bun the base image carries; every image comes
// from locks/mica-build-env.lock, that release's lock committed unchanged beside
// its pin locks/pins/mica-build-env.pin: its own base image, and the C image for
// the packages compiled from source, each by platform manifest; and from its
// upstream rows, by original reference, the BuildKit Dockerfile frontend and the
// BuildKit the builder runs.
export interface Environment {
  image: string
  bun: string
  buildEnv: Pin
  base: Record<Arch, string>
  c: Record<Arch, string>
  frontend: string
  buildkit: string
}

export const BUILD_ENV = 'mica-build-env'
const FRONTEND = 'docker/dockerfile:1-labs'
const BUILDKIT = 'moby/buildkit:'

// The images this repository takes out of the build-env lock.
export function buildEnvImages(lock: Lock): Omit<Environment, 'image' | 'bun' | 'buildEnv'> {
  const images = lock.rows.filter(row => row[0] === 'image')
  const image = (name: string, platform: string): string => {
    const found = images.filter(row => row[1] === BUILD_ENV && row[2] === name && row[3] === platform)
    if (found.length !== 1)
      fail(`locks/${BUILD_ENV}.lock names no image ${BUILD_ENV} ${name} ${platform}`)
    return found[0]![4]!
  }
  const platforms = (name: string): Record<Arch, string> => ({ amd64: image(name, 'amd64'), arm64: image(name, 'arm64') })
  // An upstream image by its name, or by its path when the tag is the lock's to choose.
  const upstream = (name: string): string => {
    const rows = images.filter(row => row[1] === 'upstream' && (name.endsWith(':') ? row[2]!.startsWith(name) : row[2] === name))
    const references = new Set(rows.filter(row => row[3] === 'amd64' || row[3] === 'arm64').map(row => `${row[2]} ${row[4]}`))
    if (references.size !== 1 || !['amd64', 'arm64'].every(platform => rows.some(row => row[3] === platform)))
      fail(`locks/${BUILD_ENV}.lock does not name ${name.endsWith(':') ? `one ${name}<tag>` : name} as one upstream image for amd64 and arm64`)
    return [...references][0]!.split(' ')[1]!
  }
  return { base: platforms('base'), c: platforms('c'), frontend: upstream(FRONTEND), buildkit: upstream(BUILDKIT) }
}

// Where an asset of the pinned mica-build-env release is downloaded from.
export function buildEnvAsset(pin: Pin, asset: string): string {
  return `https://github.com/micaoss/${pin.repository}/releases/download/${pin.release}/${asset}`
}

export function environment(): Environment {
  const record = readJson('environment.json')
  if (Object.keys(record).sort().join() !== 'bun,image')
    fail('environment.json: expected exactly image and bun')
  const input = readInputs(join(REPO, 'locks'), underCi()).get(BUILD_ENV)
  if (!input)
    fail(`locks/ has no ${BUILD_ENV}.lock`)
  return {
    image: text(record, 'image', 'environment.json', /^[a-z0-9][\w./-]*$/),
    bun: text(record, 'bun', 'environment.json', /^\d+\.\d+\.\d+$/),
    buildEnv: input.pin,
    ...buildEnvImages(input.lock),
  }
}

// The pinned mica-build-env release: its SHA256SUMS hashes to the pinned value
// and lists exactly the committed lock, byte for byte.
export function assertBuildEnvRelease(pin: Pin, sums: Uint8Array, lock: Uint8Array): void {
  const hash = (bytes: Uint8Array): string => new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
  const release = `${pin.repository} ${pin.release}`
  if (hash(sums) !== pin.sha256sums)
    fail(`the SHA256SUMS of ${release} hashes to ${hash(sums)}, not the pinned ${pin.sha256sums}`)
  if (new TextDecoder().decode(sums) !== `${hash(lock)}  ${pin.repository}.lock\n`)
    fail(`locks/${pin.repository}.lock (sha256 ${hash(lock)}) is not the one file the SHA256SUMS of ${release} lists`)
}

// /etc/mica-build/base.env of a pulled environment image: the build-env base image
// of that architecture, carrying the Bun environment.json names.
export function assertEnvironmentImage(env: Environment, arch: string, record: string): void {
  const value = (key: string): string | undefined => record.split('\n').find(line => line.startsWith(`${key}=`))?.slice(key.length + 1)
  for (const [key, expected] of [['MICA_BUILD_IMAGE', 'mica-build-base'], ['MICA_BUILD_ARCH', arch], ['MICA_BUILD_BUN', env.bun]] as const) {
    if (value(key) !== expected)
      fail(`the ${arch} environment image records ${key}=${value(key) ?? '(none)'}, not ${expected}`)
  }
}

export interface Sources { suite: string, snapshot: string, mirror: string }

export function sources(repo = REPO): Sources {
  const record = readJson('sources.json', repo)
  const suite = text(record, 'suite', 'sources.json', /^[a-z]+$/)
  const snapshot = text(record, 'snapshot', 'sources.json', /^\d{8}T\d{6}Z$/)
  const mirror = text(record, 'mirror', 'sources.json', /^https:\/\//)
  if (mirror !== `https://snapshot.debian.org/archive/debian/${snapshot}`)
    fail('sources.json: mirror is not the snapshot archive of snapshot')
  return { suite, snapshot, mirror }
}

export interface PinnedUser { name: string, uid: number, gid: number, gecos: string, home: string, shell: string }
export interface PinnedGroup { name: string, gid: number }
export interface Ids { users: PinnedUser[], groups: PinnedGroup[] }

// System IDs created by maintainer scripts, fixed at the values shipped roots use.
export function ids(): Ids {
  const record = readJson('ids.json')
  const list = (key: string, keys: string[]): Record<string, unknown>[] => {
    const value = record[key]
    if (!Array.isArray(value))
      fail(`ids.json: ${key} must be an array`)
    return value.map((entry: unknown) => {
      if (!entry || typeof entry !== 'object' || Object.keys(entry).sort().join() !== [...keys].sort().join())
        fail(`ids.json: ${key} entries have exactly ${keys.join(', ')}`)
      return entry as Record<string, unknown>
    })
  }
  const users = list('users', ['name', 'uid', 'gid', 'gecos', 'home', 'shell']).map(entry => entry as unknown as PinnedUser)
  const groups = list('groups', ['name', 'gid']).map(entry => entry as unknown as PinnedGroup)
  for (const entry of [...users, ...groups]) {
    if (!/^[a-z_][\w-]*$/.test(entry.name))
      fail(`ids.json: invalid name ${entry.name}`)
  }
  return { users, groups }
}

export function requireBun(): void {
  const expected = environment().bun
  if (Bun.version !== expected)
    fail(`this code runs under Bun ${expected} from the environment image; this is Bun ${Bun.version}`)
}
