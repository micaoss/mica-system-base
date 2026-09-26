// Fixture repositories: a copy of src/ over a tiny lock of real deb archives.
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const REPO = resolve(import.meta.dir, '..')
export const SNAPSHOT_URL = 'https://snapshot.debian.org/archive/debian/20260905T000000Z/pool'

export interface Result { code: number, output: string }

export function workdir(label: string): string {
  return mkdtempSync(join(tmpdir(), `${label}.`))
}

export function run(command: string[], env: Record<string, string | undefined> = {}): Result {
  const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } })
  return { code: result.exitCode ?? 1, output: result.stdout.toString() + result.stderr.toString() }
}

export function cli(repo: string, args: string[], env: Record<string, string | undefined> = {}): Result {
  return run([process.execPath, join(repo, 'src/cli.ts'), ...args], env)
}

export async function sha256(path: string): Promise<string> {
  return new Bun.CryptoHasher('sha256').update(await Bun.file(path).arrayBuffer()).digest('hex')
}

// A real .deb, so verification reads control fields as well as bytes.
export async function makeDeb(work: string, name: string, version: string): Promise<{ path: string, sha: string }> {
  const tree = join(work, `pkg-${name}-${version}`)
  mkdirSync(join(tree, 'DEBIAN'), { recursive: true })
  writeFileSync(join(tree, 'DEBIAN/control'), `Package: ${name}\nVersion: ${version}\nArchitecture: all\nMaintainer: Test <test@example.invalid>\nDescription: Cache fixture\n`)
  const path = join(work, `${name}_${version}.deb`)
  const built = run(['dpkg-deb', '--build', tree, path])
  if (built.code !== 0)
    throw new Error(built.output)
  return { path, sha: await sha256(path) }
}

export interface Pin { name: string, version: string, sha: string, arch?: string, url?: string, consumers?: string[] }

// locks/upstream.lock and packages.tsv of a fixture repository pinning `pins`: a
// Debian package is selected by its consumers (base unless given); an input.,
// build. or source. row by nothing.
export function writePins(repo: string, pins: Pin[]): void {
  const bytes = (value: string): Buffer => Buffer.from(value)
  const rows = pins.map(pin => ['source', pin.name, pin.arch ?? 'all', pin.version, pin.sha, pin.url ?? `${SNAPSHOT_URL}/${pin.name}.deb`])
    .sort((a, b) => Buffer.compare(bytes(a[1]!), bytes(b[1]!)) || Buffer.compare(bytes(a[2]!), bytes(b[2]!)))
  writeFileSync(join(repo, 'locks/upstream.lock'), ['# mica-lock v1', ...rows.map(row => row.join('\t')), ''].join('\n'))
  const selected = [...new Map(pins.filter(pin => !/^(?:input|build|source)\./.test(pin.name)).map(pin => [pin.name, pin.consumers ?? ['base']]))]
    .sort(([a], [b]) => Buffer.compare(bytes(a), bytes(b)))
  writeFileSync(join(repo, 'packages.tsv'), ['# fixture selections', ...selected.map(([name, consumers]) => `${name}\t${consumers.join(',')}`), ''].join('\n'))
}

export function fixtureRepo(work: string): string {
  const repo = join(work, 'repo')
  cpSync(join(REPO, 'src'), join(repo, 'src'), { recursive: true })
  cpSync(join(REPO, 'locks'), join(repo, 'locks'), { recursive: true })
  cpSync(join(REPO, 'repos/mica-build-tools/src'), join(repo, 'repos/mica-build-tools/src'), { recursive: true })
  for (const file of ['environment.json', 'sources.json', 'ids.json', 'tsconfig.json'])
    cpSync(join(REPO, file), join(repo, file))
  mkdirSync(join(repo, 'debs'))
  writeFileSync(join(repo, 'debs/consumers.pkgs'), 'mica-system\n')
  writePins(repo, [])
  return repo
}
