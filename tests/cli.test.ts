// The cache boundary without network access or host package changes.

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { nonDirectories } from '../src/bootstrap.ts'
import { Refusal } from '../src/errors.ts'
import { verifyRows } from '../src/verify.ts'
import type { Pin } from './fixture.ts'
import { cli, fixtureRepo, makeDeb, REPO, SNAPSHOT_URL, workdir, writePins } from './fixture.ts'

const SLOW = 90_000

function refused(result: { code: number, output: string }, expected: string): void {
  if (result.code === 0 || !result.output.includes(expected))
    throw new Error(`expected a refusal containing "${expected}", got exit ${result.code}:\n${result.output}`)
}

function succeeded(result: { code: number, output: string }, expected: string): void {
  if (result.code !== 0 || !result.output.includes(expected))
    throw new Error(`expected success containing "${expected}", got exit ${result.code}:\n${result.output}`)
}

describe('arguments', () => {
  const work = workdir('debian-cli-args')
  afterAll(() => rmSync(work, { recursive: true, force: true }))
  const own = (args: string[]): { code: number, output: string } => cli(REPO, args)

  test('help names the commands and the single-package selection', () => {
    succeeded(own(['--help']), 'cache|verify|select|bootstrap')
    succeeded(own(['--help']), '--package NAME')
  })

  test('refuses malformed invocations', () => {
    refused(own(['unknown']), 'unknown command')
    refused(own(['install', '--arch', 'amd64']), 'unknown command: install')
    refused(own(['cache']), '--arch is required')
    refused(own(['cache', '--arch', 'riscv64']), 'unsupported architecture')
    refused(own(['cache', '--arch', 'amd64', '--missing']), 'unknown option')
    refused(own(['cache', '--arch']), '--arch requires a value')
    refused(own(['select', '--arch', 'amd64', '--root', join(work, 'r')]), '--root is only valid with bootstrap')
  })

  test('refuses unsafe bootstrap destinations without touching them', () => {
    refused(own(['bootstrap', '--arch', 'amd64']), 'requires --root')
    refused(own(['bootstrap', '--arch', 'amd64', '--root', '/']), 'host root')
    symlinkSync('/', join(work, 'root-link'))
    refused(own(['bootstrap', '--arch', 'amd64', '--root', join(work, 'root-link')]), 'host root')
    refused(own(['bootstrap', '--arch', 'amd64', '--root', join(work, 'parent'), '--cache-dir', join(work, 'parent/cache')]), 'cannot contain the cache')
    refused(own(['bootstrap', '--arch', 'amd64', '--root', join(work, 'cache/child'), '--cache-dir', join(work, 'cache')]), 'cannot be inside the cache')
    mkdirSync(join(work, 'root'))
    writeFileSync(join(work, 'root/sentinel'), 'preserve\n')
    refused(own(['bootstrap', '--arch', 'amd64', '--root', join(work, 'root')]), 'must be empty')
    expect(readFileSync(join(work, 'root/sentinel'), 'utf8')).toBe('preserve\n')
  })

  test('a missing cache is refused and not created', () => {
    refused(own(['verify', '--arch', 'amd64', '--cache-dir', join(work, 'cache')]), 'cache is missing')
    expect(existsSync(join(work, 'cache'))).toBe(false)
    refused(own(['bootstrap', '--arch', 'amd64', '--root', join(work, 'new-root'), '--cache-dir', join(work, 'cache')]), 'cache is missing')
    expect(existsSync(join(work, 'new-root'))).toBe(false)
  })

  test('rendered rows are checked before any archive is read', async () => {
    const rejects = async (rows: Parameters<typeof verifyRows>[1], message: string): Promise<void> => {
      const error = await verifyRows(join(work, 'cache'), rows).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(Refusal)
      expect((error as Error).message).toContain(message)
    }
    await rejects([], 'rendered package selection is empty')
    await rejects([{ name: 'bad', version: '1', architecture: 'all', sha256: 'bad row', url: '', consumers: [] }], 'invalid rendered archive checksum')
  })
})

describe('fixture lock', () => {
  const work = workdir('debian-cli-lock')
  const repo = fixtureRepo(work)
  const cache = join(work, 'cache')
  const args = ['--arch', 'amd64', '--cache-dir', cache]
  const debs = {} as Record<string, { path: string, sha: string }>
  let pins: Pin[] = []
  const lockFile = join(repo, 'locks/upstream.lock')
  const selectionFile = join(repo, 'packages.tsv')
  const set = (next: Pin[]): void => {
    pins = next
    writePins(repo, pins)
  }
  const good = (): Pin => ({ name: 'libc6', version: '2.41', sha: debs.libc6!.sha })
  const restore = (): void => set([good()])
  const edit = (file: string, from: string | RegExp, to: string): void =>
    writeFileSync(file, readFileSync(file, 'utf8').replace(from, to))

  beforeAll(async () => {
    mkdirSync(join(cache, 'sha256'), { recursive: true })
    for (const [key, name, version] of [['libc6', 'libc6', '2.41'], ['other', 'libother', '1.0'], ['mirror', 'libmirror', '1.0']] as const)
      debs[key] = await makeDeb(work, name, version)
    copyFileSync(debs.libc6!.path, join(cache, 'sha256', debs.libc6!.sha))
    restore()
  })
  afterAll(() => rmSync(work, { recursive: true, force: true }))

  test('verify and cache accept a complete cache without downloading', () => {
    succeeded(cli(repo, ['verify', ...args]), 'verified 1 packages')
    succeeded(cli(repo, ['cache', ...args]), 'downloaded 0 archives')
  })

  test('damaged archives and mismatched pins are refused', () => {
    const archive = join(cache, 'sha256', debs.libc6!.sha)
    appendFileSync(archive, 'damage')
    refused(cli(repo, ['verify', ...args]), 'SHA256 mismatch')
    refused(cli(repo, ['bootstrap', ...args, '--root', join(work, 'corrupt-root')]), 'SHA256 mismatch')
    expect(existsSync(join(work, 'corrupt-root'))).toBe(false)
    copyFileSync(debs.libc6!.path, archive)

    set([{ ...good(), version: '2.42' }])
    refused(cli(repo, ['verify', ...args]), 'package metadata mismatch')
    set([{ ...good(), arch: 'amd64' }])
    refused(cli(repo, ['verify', ...args]), 'package metadata mismatch')
    set([{ ...good(), name: 'apt' }])
    refused(cli(repo, ['verify', ...args]), 'invalid package lock: packages.tsv: invalid package name apt')
    set([{ ...good(), url: `${SNAPSHOT_URL.replace('https://', 'http://')}/libc6.deb` }])
    refused(cli(repo, ['verify', ...args]), 'refused field-value')
    set([{ ...good(), url: 'https://example.invalid/libc6.deb' }])
    refused(cli(repo, ['verify', ...args]), 'is not a Debian snapshot archive')
    restore()
  })

  test('selection rules and lock validation', () => {
    const selection = join(work, 'selection')
    const select = (extra: string[]): { code: number, output: string } => cli(repo, ['select', ...args, ...extra])
    writeFileSync(selection, 'mica-unknown\n')
    refused(select(['--packages', selection]), 'unknown package consumer')

    // A consumer family covers every member without an entry of its own.
    writeFileSync(join(repo, 'debs/consumers.pkgs'), 'mica-system\nmica-board-*\n')
    set([good(), { name: 'familypkg', version: '1.0', sha: debs.libc6!.sha, consumers: ['mica-board-*'] }])
    writeFileSync(selection, 'mica-board-newboard\n')
    expect(select(['--packages', selection]).output).toMatch(/^familypkg\t/m)
    writeFileSync(selection, 'mica-system\n')
    expect(select(['--packages', selection]).output).not.toMatch(/^familypkg\t/m)
    writeFileSync(selection, 'mica-boardless\n')
    refused(select(['--packages', selection]), 'unknown package consumer')
    writeFileSync(selection, 'mica-board-\n')
    refused(select(['--packages', selection]), 'unknown package consumer')
    writeFileSync(join(repo, 'debs/consumers.pkgs'), 'mica-system\n')
    restore()

    // A pin and its selection come together.
    set([good(), { name: 'libother', version: '1.0', sha: debs.other!.sha }])
    edit(selectionFile, /^libother\t.*\n/m, '')
    refused(select([]), 'libother is pinned in locks/upstream.lock and selected by nothing in packages.tsv')
    restore()
    edit(selectionFile, /$/, 'libgone\tbase\n')
    refused(select([]), 'packages.tsv selects libgone, which locks/upstream.lock does not pin')
    restore()

    writeFileSync(selection, '# Empty selection\n')
    refused(select(['--packages', selection]), 'package selection is empty')
    refused(select(['--packages', selection, '--all']), 'mutually exclusive')
    refused(cli(repo, ['bootstrap', ...args, '--package', 'libc6', '--root', join(work, 'single-root')]), 'cannot be used with bootstrap')
    expect(existsSync(join(work, 'single-root'))).toBe(false)
    refused(cli(repo, ['cache', ...args, '--package', 'libc6', '--all']), 'mutually exclusive')
    refused(select(['--package', '../libc6']), 'invalid package lock')
    refused(select(['--package', 'missing']), 'invalid package lock')
    set([{ ...good(), arch: 'amd64' }])
    refused(cli(repo, ['select', '--arch', 'arm64', '--package', 'libc6']), 'no arm64 variant')
    restore()
    edit(lockFile, '# mica-lock v1', '# mica-lock v2')
    refused(select([]), 'refused header')
    restore()
    edit(lockFile, /\tall\t/, '\tall\t\t')
    refused(select([]), 'refused column-count')
    restore()
    edit(selectionFile, 'libc6\tbase', 'libc6\tbase,base')
    refused(select([]), 'invalid consumers of libc6')
    restore()
    edit(selectionFile, 'libc6\tbase', 'libc6\tmica-unknown')
    refused(select([]), 'unknown package consumer mica-unknown')
    restore()
  })

  // A loopback HTTPS mirror serving /debian/pool/<file>, and a download it never
  // answers under /stall; `served` lists what it was asked for.
  function mirror(files: Record<string, string>): { base: string, served: string[], stop: () => void } {
    const served: string[] = []
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      idleTimeout: 0,
      tls: { cert: Bun.file(join(REPO, 'tests/fixtures/loopback.crt')), key: Bun.file(join(REPO, 'tests/fixtures/loopback.key')) },
      fetch(request) {
        const path = new URL(request.url).pathname
        served.push(path)
        const file = path.startsWith('/debian/pool/') ? files[path.slice('/debian/pool/'.length)] : undefined
        if (file)
          return new Response(Bun.file(file))
        if (path.startsWith('/stall'))
          return new Promise<Response>(() => {})
        return new Response('not on this mirror', { status: 404 })
      },
    })
    return { base: `https://127.0.0.1:${server.port}`, served, stop: () => server.stop(true) }
  }
  // Async: the mirror shares this event loop.
  const cacheAsync = async (extra: string[], env: Record<string, string>): Promise<{ code: number, output: string }> => {
    const child = Bun.spawn([process.execPath, join(repo, 'src/cli.ts'), 'cache', ...args, ...extra], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0', ...env },
    })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    return { code, output: stdout + stderr }
  }

  test('updating one pin downloads only that archive', async () => {
    set([good(), { name: 'libother', version: '1.0', sha: debs.other!.sha }])
    copyFileSync(debs.other!.path, join(cache, 'sha256', debs.other!.sha))
    const listing = (skip?: string): string[] => readdirSync(join(cache, 'sha256')).filter(file => file !== skip).map((file) => {
      const stat = statSync(join(cache, 'sha256', file))
      return `${file} ${stat.size} ${stat.mtimeMs}`
    }).sort()
    const before = listing()
    const updated = await makeDeb(work, 'libc6', '2.42')
    set([{ name: 'libc6', version: '2.42', sha: updated.sha, url: `${SNAPSHOT_URL.replace('20260905', '20260906')}/libc6.deb` }, { name: 'libother', version: '1.0', sha: debs.other!.sha }])
    const server = mirror({ 'libc6.deb': updated.path })
    try {
      const env = { MICA_MIRROR: `pool:${server.base}/debian` }
      succeeded(await cacheAsync(['--package', 'libc6'], env), 'verified 1 packages; downloaded 1 archives (1 from the mirror, 0 from the pinned URL)')
      expect(server.served).toEqual(['/debian/pool/libc6.deb'])
      expect(listing(updated.sha)).toEqual(before)
      succeeded(await cacheAsync([], env), 'verified 2 packages; downloaded 0 archives')
      expect(server.served).toHaveLength(1)
    }
    finally {
      server.stop()
    }
    set([...pins.filter(pin => pin.name !== 'libother')])
  })

  test('a mirror serves, falls back on 404, and a stalled one is stopped at the ceiling', async () => {
    set([...pins, { name: 'libmirror', version: '1.0', sha: debs.mirror!.sha }])
    const server = mirror({ 'libmirror.deb': debs.mirror!.path })
    try {
      const mirrored = join(cache, 'sha256', debs.mirror!.sha)
      succeeded(await cacheAsync(['--package', 'libmirror'], { MICA_MIRROR: `${server.base}/debian/` }), 'downloaded 1 archives (1 from the mirror, 0 from the pinned URL)')
      expect(readFileSync(mirrored)).toEqual(readFileSync(debs.mirror!.path))
      rmSync(mirrored)
      // The fallback URL is unreachable here.
      refused(await cacheAsync(['--package', 'libmirror'], { MICA_MIRROR: `${server.base}/absent` }), `${SNAPSHOT_URL}/libmirror.deb`)
      const started = Date.now()
      refused(await cacheAsync(['--package', 'libmirror'], { MICA_MIRROR: `snapshot:${server.base}/stall`, MICA_FETCH_DEADLINE: '3' }), SNAPSHOT_URL)
      expect(Date.now() - started).toBeLessThan(30_000)
      expect(server.served.some(path => path.startsWith('/stall/archive/debian/'))).toBe(true)
      expect(existsSync(mirrored)).toBe(false)
    }
    finally {
      server.stop()
    }
    set(pins.filter(pin => pin.name !== 'libmirror'))
  }, SLOW)

  test('targeted operations do not read unrelated archives', () => {
    restore()
    set([...pins, { name: 'libother', version: '1.0', sha: debs.other!.sha }])
    appendFileSync(join(cache, 'sha256', debs.other!.sha), 'damage')
    succeeded(cli(repo, ['verify', ...args, '--package', 'libc6']), 'verified 1 packages')
    refused(cli(repo, ['verify', ...args]), 'SHA256 mismatch')
  })
})

test('walking a root never follows a symlink out of it', () => {
  const work = workdir('debian-walk')
  try {
    mkdirSync(join(work, 'outside'))
    writeFileSync(join(work, 'outside/precious'), 'host file\n')
    mkdirSync(join(work, 'root/usr/share/doc/pkg'), { recursive: true })
    writeFileSync(join(work, 'root/usr/share/doc/pkg/copyright'), 'terms\n')
    symlinkSync(join(work, 'outside'), join(work, 'root/usr/share/doc/linked'))
    const found = nonDirectories(join(work, 'root/usr/share/doc')).map(entry => [entry.name, entry.depth])
    expect(found.sort()).toEqual([['copyright', 2], ['linked', 1]])
    expect(existsSync(join(work, 'outside/precious'))).toBe(true)
  }
  finally {
    rmSync(work, { recursive: true, force: true })
  }
})
