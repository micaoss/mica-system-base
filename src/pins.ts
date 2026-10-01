import type { Input } from '@mica/build-tools'
import type { Arch } from './lock.ts'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { checkLocks, modeOf, resolveImage } from '@mica/build-tools'
import { fail } from './errors.ts'

export const REPO = resolve(import.meta.dir, '..')
// The snapshot locks/upstream.lock is resolved from, and the root's fixed system IDs.
const SOURCES = 'locks/sources.json'
const IDS = 'config/ids.json'
// The local tag each architecture's environment image is pulled under.
const IMAGE = 'localhost/mica-system-base-env'

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

// The build environment: the local tag the environment image is pulled under, the
// Bun it carries (package.json's packageManager), and the images of
// locks/mica-build-env.lock, read through mica-build-tools -- its base and C images
// by platform manifest, and from its upstream rows the Dockerfile frontend and the
// BuildKit the builder runs. `mica-tools locks verify` holds the lock to its release.
export interface Environment {
  image: string
  bun: string
  base: Record<Arch, string>
  c: Record<Arch, string>
  frontend: string
  buildkit: string
}

const BUILD_ENV = 'mica-build-env'
const FRONTEND = 'docker/dockerfile:1-labs'
const BUILDKIT = 'moby/buildkit:'

// The images this repository takes out of the build-env lock. BuildKit is named by
// its path: its tag is the lock's to choose, and there must be exactly one.
export function buildEnvImages(inputs: Input[], locks: string): Omit<Environment, 'image' | 'bun'> {
  const image = (selector: string): string => resolveImage(selector, inputs, locks)
  const platforms = (name: string): Record<Arch, string> => ({ amd64: image(`${BUILD_ENV}:${name}@amd64`), arm64: image(`${BUILD_ENV}:${name}@arm64`) })
  const input = inputs.find(entry => entry.lock.repository === BUILD_ENV)
  if (!input)
    fail(`locks/ has no ${BUILD_ENV}.lock`)
  const buildkit = [...new Set(input.lock.rows.filter(row => row[0] === 'image' && row[1] === 'upstream' && row[2]!.startsWith(BUILDKIT)).map(row => row[2]!))]
  if (buildkit.length !== 1)
    fail(`locks/${BUILD_ENV}.lock does not name one ${BUILDKIT}<tag>`)
  return { base: platforms('base'), c: platforms('c'), frontend: image(`upstream:${FRONTEND}`), buildkit: image(`upstream:${buildkit[0]}`) }
}

// The Bun this repository runs under, package.json's packageManager.
function bunVersion(): string {
  return /^bun@(\d+\.\d+\.\d+)$/.exec(String(readJson('package.json').packageManager))?.[1] ?? fail('package.json: packageManager is not bun@<version>')
}

let cached: Environment | undefined

export function environment(): Environment {
  if (!cached) {
    const locks = join(REPO, 'locks')
    cached = { image: IMAGE, bun: bunVersion(), ...buildEnvImages(checkLocks(locks, modeOf()), locks) }
  }
  return cached
}

// /etc/mica-build/base.env of a pulled environment image: the build-env base image
// of that architecture, carrying the Bun package.json names.
export function assertEnvironmentImage(env: Environment, arch: string, record: string): void {
  const value = (key: string): string | undefined => record.split('\n').find(line => line.startsWith(`${key}=`))?.slice(key.length + 1)
  for (const [key, expected] of [['MICA_BUILD_IMAGE', 'mica-build-base'], ['MICA_BUILD_ARCH', arch], ['MICA_BUILD_BUN', env.bun]] as const) {
    if (value(key) !== expected)
      fail(`the ${arch} environment image records ${key}=${value(key) ?? '(none)'}, not ${expected}`)
  }
}

export interface Sources { suite: string, snapshot: string, mirror: string }

export function sources(repo = REPO): Sources {
  const record = readJson(SOURCES, repo)
  const suite = text(record, 'suite', SOURCES, /^[a-z]+$/)
  const snapshot = text(record, 'snapshot', SOURCES, /^\d{8}T\d{6}Z$/)
  const mirror = text(record, 'mirror', SOURCES, /^https:\/\//)
  if (mirror !== `https://snapshot.debian.org/archive/debian/${snapshot}`)
    fail(`${SOURCES}: mirror is not the snapshot archive of snapshot`)
  return { suite, snapshot, mirror }
}

export interface PinnedUser { name: string, uid: number, gid: number, gecos: string, home: string, shell: string }
export interface PinnedGroup { name: string, gid: number }
export interface Ids { users: PinnedUser[], groups: PinnedGroup[] }

// System IDs created by maintainer scripts, fixed at the values shipped roots use.
export function ids(): Ids {
  const record = readJson(IDS)
  const list = (key: string, keys: string[]): Record<string, unknown>[] => {
    const value = record[key]
    if (!Array.isArray(value))
      fail(`${IDS}: ${key} must be an array`)
    return value.map((entry: unknown) => {
      if (!entry || typeof entry !== 'object' || Object.keys(entry).sort().join() !== [...keys].sort().join())
        fail(`${IDS}: ${key} entries have exactly ${keys.join(', ')}`)
      return entry as Record<string, unknown>
    })
  }
  const users = list('users', ['name', 'uid', 'gid', 'gecos', 'home', 'shell']).map(entry => entry as unknown as PinnedUser)
  const groups = list('groups', ['name', 'gid']).map(entry => entry as unknown as PinnedGroup)
  for (const entry of [...users, ...groups]) {
    if (!/^[a-z_][\w-]*$/.test(entry.name))
      fail(`${IDS}: invalid name ${entry.name}`)
  }
  return { users, groups }
}

export function requireBun(): void {
  const expected = bunVersion()
  if (Bun.version !== expected)
    fail(`this code runs under Bun ${expected} from the environment image; this is Bun ${Bun.version}`)
}
