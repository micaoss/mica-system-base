// The packer contract and the mica-system payload it packs.
import type { PackRequest } from '../src/debs/pack.ts'
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { buildPlan, declared, inputsHash } from '../src/debs/docker.ts'
import { selectBuild, selectRuntime, selectSource } from '../src/lock.ts'
import { controlFields, declaration, pack, renderControl } from '../src/debs/pack.ts'
import { REPO, run, sha256, workdir } from './fixture.ts'

const work = workdir('debs')
afterAll(() => rmSync(work, { recursive: true, force: true }))

const TEMPLATE = `Package: fixture
Version: 1.2.3-mica1
Source-Date-Epoch: 1789000000
Architecture: @ARCH@
Maintainer: Test <test@example.invalid>
Section: admin
Priority: optional
Depends: \${shlibs:Depends}
Description: packer fixture
 Prose may quote \${shlibs:Depends} without it being substituted.
`
function request(overrides: Partial<PackRequest> = {}): PackRequest {
  return { stage: '', control: 'control', arch: 'all', out: work, repository: 'mica-system-base', substitutions: { 'shlibs:Depends': 'libc6 (>= 2.38)' }, ...overrides }
}

function refusal(action: () => unknown): string {
  try {
    action()
  }
  catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return '(accepted)'
}

describe('the control file', () => {
  test('carries the declared version, the substitution, the computed size and the repository, and no epoch or commit', () => {
    const fields = controlFields(renderControl(TEMPLATE, request(), 12))
    expect(fields.get('Version')).toBe('1.2.3-mica1')
    expect(fields.get('Architecture')).toBe('all')
    expect(fields.get('Depends')).toBe('libc6 (>= 2.38)')
    expect(fields.get('Installed-Size')).toBe('12')
    expect(fields.get('Mica-Source-Repo')).toBe('mica-system-base')
    expect(fields.has('Mica-Source-Commit')).toBe(false)
    expect(fields.has('Source-Date-Epoch')).toBe(false)
    expect(declaration(TEMPLATE, 'control')).toEqual({ version: '1.2.3-mica1', epoch: 1789000000 })
  })

  test('refuses what the packer owns and what it cannot fill', () => {
    expect(refusal(() => renderControl(`${TEMPLATE}Installed-Size: 1\n`, request(), 1))).toContain('Installed-Size')
    expect(refusal(() => renderControl(`${TEMPLATE}Mica-Source-Commit: ${'a'.repeat(40)}\n`, request(), 1))).toContain('Mica-Source-Commit')
    // A version is the package's own: no release placeholder, snapshot or dirty stamp.
    for (const version of ['@VERSION@', '20260914-0130~git0123456789ab-1', '1.0+git0123456789ab-1', '1.0.dirty-1'])
      expect(refusal(() => renderControl(TEMPLATE.replace('1.2.3-mica1', version), request(), 1))).toContain('not a Debian version of its own')
    expect(refusal(() => renderControl(TEMPLATE.replace('Source-Date-Epoch: 1789000000\n', ''), request(), 1))).toContain('Source-Date-Epoch')
    expect(refusal(() => renderControl(TEMPLATE.replace('1789000000', 'now'), request(), 1))).toContain('Source-Date-Epoch')
    expect(refusal(() => renderControl(TEMPLATE, request({ substitutions: { 'shlibs:Depends': '' } }), 1))).toContain('empty')
    expect(refusal(() => renderControl(TEMPLATE, request({ substitutions: {} }), 1))).toContain('unexpanded substitution in Depends')
  })
})

describe('an archive', () => {
  const stage = join(work, 'stage')
  mkdirSync(join(stage, 'usr/bin'), { recursive: true })
  writeFileSync(join(stage, 'usr/bin/tool'), '#!/bin/sh\n')
  chmodSync(join(stage, 'usr/bin/tool'), 0o755)
  writeFileSync(join(stage, 'usr/bin/data'), 'data\n')
  chmodSync(join(stage, 'usr/bin/data'), 0o644)
  symlinkSync('/dev/null', join(stage, 'usr/bin/masked'))
  mkdirSync(join(stage, 'root'), { mode: 0o700 })
  chmodSync(join(stage, 'root'), 0o700)
  const control = join(work, 'control')
  writeFileSync(control, TEMPLATE)
  const postinst = join(work, 'postinst')
  writeFileSync(postinst, '#!/bin/sh\nexit 0\n')

  test('is root-owned, dated at the epoch, and exactly the staged tree', async () => {
    const deb = await pack(request({ stage, control, out: join(work, 'one'), scripts: { postinst } }))
    const listing = run(['sh', '-c', 'dpkg-deb --fsys-tarfile "$1" | tar --full-time -tvf -', 'list', deb]).output
    for (const line of listing.split('\n').filter(Boolean)) {
      expect(line.split(/\s+/)[1]).toBe('root/root')
      expect(line).toContain('2026-09-10')
    }
    expect(listing).toMatch(/-rwxr-xr-x .*\.\/usr\/bin\/tool/)
    expect(listing).toMatch(/drwx------ .*\.\/root\//)
    expect(listing).toContain('./usr/bin/masked -> /dev/null')
    const md5sums = run(['sh', '-c', 'dpkg-deb --ctrl-tarfile "$1" | tar -xOf - ./md5sums', 'sums', deb]).output
    expect(md5sums.trim().split('\n').map(line => line.split('  ')[1])).toEqual(['usr/bin/data', 'usr/bin/tool'])
    expect(run(['dpkg-deb', '--info', deb]).output).toContain('postinst')
  })

  test('is byte-identical when packed twice', async () => {
    const first = await pack(request({ stage, control, out: join(work, 'first') }))
    const second = await pack(request({ stage, control, out: join(work, 'second') }))
    expect(await sha256(first)).toBe(await sha256(second))
  })

  test('refuses a staged DEBIAN and an unknown maintainer script', async () => {
    const debian = join(work, 'with-debian')
    mkdirSync(join(debian, 'DEBIAN'), { recursive: true })
    await expect(pack(request({ stage: debian, control }))).rejects.toThrow('DEBIAN')
    await expect(pack(request({ stage, control, out: join(work, 'bad'), scripts: { config: postinst } }))).rejects.toThrow('maintainer script')
  })
})

test('a build for one architecture takes its own and the all packages, filed into its pool only', () => {
  const packages = [{ name: 'data', arches: ['all' as const] }, { name: 'tool', arches: ['amd64' as const, 'arm64' as const] }]
  expect(buildPlan(packages)).toEqual([
    { name: 'data', arch: 'all', pools: ['amd64', 'arm64'] },
    { name: 'tool', arch: 'amd64', pools: ['amd64'] },
    { name: 'tool', arch: 'arm64', pools: ['arm64'] },
  ])
  expect(buildPlan(packages, 'arm64')).toEqual([
    { name: 'data', arch: 'all', pools: ['arm64'] },
    { name: 'tool', arch: 'arm64', pools: ['arm64'] },
  ])
})

describe('the package definitions', () => {
  test('every debs/<package> declares its architectures and has a control template named after it', () => {
    const packages = declared(REPO)
    expect(packages.map(entry => entry.name)).toEqual(['mica-busybox', 'mica-ca-trust', 'mica-system', 'mica-systemd-boot'])
    for (const entry of packages)
      expect(readFileSync(join(REPO, 'debs', entry.name, 'control'), 'utf8')).toStartWith(`Package: ${entry.name}\n`)
    expect(packages.find(entry => entry.name === 'mica-busybox')).toEqual({ name: 'mica-busybox', arches: ['amd64', 'arm64'], inputs: [], build: [], sources: ['busybox'], version: '1.38.0-mica1', epoch: 1789430400 })
    expect(Object.fromEntries(packages.map(entry => [entry.name, entry.version]))).toEqual({ 'mica-busybox': '1.38.0-mica1', 'mica-ca-trust': '20250419-mica1', 'mica-system': '1.0.0-1', 'mica-systemd-boot': '257.13-mica1' })
  })

  // systemd-boot is compiled from the source of the systemd the lock pins, with the patch that
  // refuses exhausted or unrecorded boot attempts, on build tools pinned for both architectures.
  test('mica-systemd-boot builds the locked systemd release with the attempt patch and pinned build tools', () => {
    const dockerfile = readFileSync(join(REPO, 'debs/mica-systemd-boot/Dockerfile'), 'utf8')
    const { version, url } = selectSource(REPO, 'systemd')
    for (const arch of ['amd64', 'arm64'] as const)
      expect(selectRuntime(REPO, arch, { kind: 'package', name: 'systemd' })[0]!.version.replace(/-[^-]+$/, '')).toBe(version)
    expect(url).toMatch(new RegExp(`^https://snapshot\\.debian\\.org/archive/debian/\\d{8}T\\d{6}Z/pool/main/s/systemd/systemd_${version.replaceAll('.', '\\.')}\\.orig\\.tar\\.gz$`))
    expect(dockerfile).toContain('curl -fsSL --retry 3 -o /systemd.tar.gz "${MICA_SOURCE_SYSTEMD_URL}"')
    expect(dockerfile).toContain('echo "${MICA_SOURCE_SYSTEMD_SHA256}  /systemd.tar.gz" | sha256sum -c -')
    expect(dockerfile).toContain('FROM --platform=linux/${MICA_DEB_ARCH} ${MICA_BUILD_C_IMAGE} AS build')
    expect(dockerfile).toContain('\'Mica OS: deployment attempts exhausted\'')
    const patch = readFileSync(join(REPO, 'debs/mica-systemd-boot/persistence.patch'), 'utf8')
    expect(patch).toContain('+                if (entry->tries_left == 0)')
    expect(patch).toContain('Mica OS: attempt state was not persisted; refusing boot')
    const entry = declared(REPO).find(candidate => candidate.name === 'mica-systemd-boot')!
    for (const arch of ['amd64', 'arm64'] as const) {
      const pinned = selectBuild(REPO, arch, 'mica-systemd-boot').map(row => row.name)
      expect(pinned).toEqual(expect.arrayContaining(entry.build))
    }
    expect(readFileSync(join(REPO, 'debs/consumers.pkgs'), 'utf8')).toMatch(/^mica-systemd-boot$/m)
  })

  // BusyBox is compiled from the upstream release, statically, so it needs nothing of the root.
  test('mica-busybox builds the pinned upstream source statically and depends on nothing', () => {
    const dockerfile = readFileSync(join(REPO, 'debs/mica-busybox/Dockerfile'), 'utf8')
    const { version, url } = selectSource(REPO, 'busybox')
    expect(version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(url).toBe(`https://busybox.net/downloads/busybox-${version}.tar.bz2`)
    expect(dockerfile).toContain('echo "${MICA_SOURCE_BUSYBOX_SHA256}  /busybox.tar.bz2" | sha256sum -c -')
    expect(dockerfile).toContain('FROM --platform=linux/${MICA_DEB_ARCH} ${MICA_BUILD_C_IMAGE} AS build')
    expect(readFileSync(join(REPO, 'debs/mica-busybox/config'), 'utf8')).toMatch(/^CONFIG_STATIC=y$/m)
    expect(readFileSync(join(REPO, 'debs/mica-busybox/control'), 'utf8')).not.toMatch(/^Depends:/m)
    expect(existsSync(join(REPO, 'debs/mica-busybox/inputs'))).toBe(false)
  })
})

// mica.inputs covers what determines a package's bytes and nothing else.
test('the inputs hash follows a package\'s own files, the packer, its lock rows and the architecture', () => {
  const copy = join(work, 'inputs')
  const git = run(['git', '-c', 'safe.directory=*', '-C', REPO, 'ls-files'])
  for (const path of git.output.split('\n').filter(Boolean)) {
    mkdirSync(join(copy, path, '..'), { recursive: true })
    const source = join(REPO, path)
    if (lstatSync(source).isSymbolicLink())
      symlinkSync(readlinkSync(source), join(copy, path))
    else
      writeFileSync(join(copy, path), readFileSync(source), { mode: lstatSync(source).mode })
  }
  const hash = (name: string, arch: 'amd64' | 'arm64' | 'all'): string => inputsHash(copy, declared(copy).find(entry => entry.name === name)!, arch)
  const before = { system: hash('mica-system', 'all'), boot: hash('mica-systemd-boot', 'amd64'), bootArm: hash('mica-systemd-boot', 'arm64'), busybox: hash('mica-busybox', 'amd64'), trust: hash('mica-ca-trust', 'all') }
  expect(before.boot).not.toBe(before.bootArm)
  const append = (path: string, text: string): void => writeFileSync(join(copy, path), readFileSync(join(copy, path), 'utf8') + text)
  // Another package's files, the build-env lock and repository metadata are not inputs.
  append('debs/mica-busybox/config', '# changed\n')
  append('locks/mica-build-env.lock', '# changed\n')
  append('README.md', 'changed\n')
  expect([hash('mica-system', 'all'), hash('mica-systemd-boot', 'amd64'), hash('mica-ca-trust', 'all')]).toEqual([before.system, before.boot, before.trust])
  expect(hash('mica-busybox', 'amd64')).not.toBe(before.busybox)
  // The payload, the packer, a pinned row and the declared version are.
  append('payload/usr/lib/mica/mica-shadow-reconcile', '# changed\n')
  expect(hash('mica-system', 'all')).not.toBe(before.system)
  expect(hash('mica-systemd-boot', 'amd64')).toBe(before.boot)
  append('src/debs/pack.ts', '// changed\n')
  expect(hash('mica-ca-trust', 'all')).not.toBe(before.trust)
  const packed = hash('mica-systemd-boot', 'arm64')
  writeFileSync(join(copy, 'locks/upstream.lock'), readFileSync(join(copy, 'locks/upstream.lock'), 'utf8').replace(/^(source\tsource\.systemd\tall\t\S+\t)[0-9a-f]{64}/m, `$1${'0'.repeat(64)}`))
  const boot = hash('mica-systemd-boot', 'arm64')
  expect(boot).not.toBe(packed)
  writeFileSync(join(copy, 'debs/mica-systemd-boot/control'), readFileSync(join(copy, 'debs/mica-systemd-boot/control'), 'utf8').replace('257.13-mica1', '257.13-mica2'))
  expect(hash('mica-systemd-boot', 'arm64')).not.toBe(boot)
})

describe('the Mica names', () => {
  // Mica OS is the only name: no tracked file names the retired project, in its
  // path or its text. The retired name is spelled from its letters so this file
  // does not carry it either.
  test('the retired project name appears in no tracked file or path', () => {
    const retired = ['m', 'o', 's'].join('')
    const word = new RegExp(`(^|[^a-z0-9])${retired}([^a-z0-9]|$)`, 'i')
    const git = (...args: string[]): { code: number, output: string } => run(['git', '-c', 'safe.directory=*', '-C', REPO, ...args])
    const files = git('ls-files')
    expect(files.code).toBe(0)
    expect(files.output.split('\n').filter(path => word.test(path))).toEqual([])
    const text = git('grep', '-nIiE', String.raw`(^|[^a-z0-9])${retired}([^a-z0-9]|$)`)
    expect(text.output.trim()).toBe('')
    expect(existsSync(join(REPO, 'payload/etc/systemd/system/mica.mount'))).toBe(true)
  })

  test('every package is maintained by Mica OS', () => {
    for (const entry of declared(REPO))
      expect(readFileSync(join(REPO, 'debs', entry.name, 'control'), 'utf8')).toContain('\nMaintainer: Mica OS <hi@micaos.dev>\n')
  })
})

describe('the mica-system payload', () => {
  const payload = join(REPO, 'payload')
  const entries = (directory: string): string[] => readdirSync(join(payload, directory), { recursive: true }).map(String)

  test('carries no DEBIAN', () => {
    expect(existsSync(join(payload, 'DEBIAN'))).toBe(false)
  })

  test('enables every linked unit from a path that exists, and never dropbear or nftables', () => {
    const system = join(payload, 'etc/systemd/system')
    for (const entry of entries('etc/systemd/system')) {
      const path = join(system, entry)
      if (!lstatSync(path).isSymbolicLink())
        continue
      expect(entry).not.toMatch(/(?:dropbear|nftables)\.service$/)
      const target = readlinkSync(path)
      if (target === '/dev/null' || target.startsWith('/lib/systemd/system/') || target.startsWith('/usr/lib/systemd/system/systemd-'))
        continue
      expect(existsSync(join(payload, target))).toBe(true)
    }
  })

  test('disables dropbear.service and nftables.service by preset', () => {
    const presets = join(payload, 'usr/lib/systemd/system-preset')
    expect(readFileSync(join(presets, '50-mica-dropbear.preset'), 'utf8')).toBe('disable dropbear.service\n')
    expect(readFileSync(join(presets, '50-mica-nftables.preset'), 'utf8')).toBe('disable nftables.service\n')
  })
})

// Under `set -o pipefail`, an early-exiting reader on the right of a pipe (head,
// grep -q/-m, sed -n Nq, read) fails the pipeline when the producer dies of
// SIGPIPE, so the test passes or fails by where the match sits. No script here
// enables pipefail, and the three latent sites are recorded in
// docs/task/20260915-1145-pipefail-shapes.md to be hardened with the next bump of
// their package. This guard keeps the two facts together: a script that enables
// pipefail may not pipe into such a reader.
test('no shell script pipes into an early-exiting reader under pipefail', () => {
  const early = /\|[ \t]*(?:head\b|grep\b[^|]*(?:-[A-Za-z]*[qm]|--quiet|--max-count)|sed\b[^|]*\b\d*q\b|read\b)/
  const scripts = run(['git', '-c', 'safe.directory=*', '-C', REPO, 'ls-files', '--', 'payload', 'debs', '*.sh']).output.split('\n').filter(Boolean)
  const offending: string[] = []
  for (const path of scripts) {
    if (!lstatSync(join(REPO, path)).isFile())
      continue
    const text = readFileSync(join(REPO, path), 'utf8')
    if (!/^#!.*\b(?:ba)?sh\b/.test(text) && !path.endsWith('Dockerfile') && !path.endsWith('.sh'))
      continue
    for (const [index, line] of text.split('\n').entries()) {
      if (/set -o pipefail|set -[a-z]*o pipefail/.test(text) && early.test(line))
        offending.push(`${path}:${index + 1}`)
    }
  }
  expect(offending).toEqual([])
  // The guard sees the shape: a script with pipefail and such a pipe is refused.
  expect(early.test('printf \'%s\\n\' "$x" | grep -qx y')).toBe(true)
  expect(early.test('sed -n "s/^a=//p" "$f" | head -n1')).toBe(true)
  expect(early.test('dpkg-deb --fsys-tarfile "$1" | tar -tf -')).toBe(false)
})
