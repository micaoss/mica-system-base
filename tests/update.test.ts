// The upstream update's parts that read upstreams and rewrite pins, against
// recorded shapes of each upstream's answer.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, expect, test } from 'bun:test'
import { keepUrls } from '../src/lock.ts'
import { anchorsDigest, bumped, debianBinary, debianSource, latestListed, nextVersion, stanza, substantive, upstreamOf, withSource, withValue, withVersion } from '../src/update.ts'
import { run, workdir } from './fixture.ts'

const work = workdir('update')
afterAll(() => rmSync(work, { recursive: true, force: true }))

const MIRROR = 'https://snapshot.debian.org/archive/debian/20261001T000000Z'

test('a version is its upstream\'s with a mica revision', () => {
  // A new upstream restarts at mica1; the same upstream moves the revision.
  expect(nextVersion('2.12-mica3', '2.13')).toBe('2.13-mica1')
  expect(nextVersion('2.12-mica3', '2.12')).toBe('2.12-mica4')
  expect(nextVersion('2026c-mica2', '2026d')).toBe('2026d-mica1')
  // A version of its own takes the upstream's.
  expect(nextVersion('1.0.0-3', '257.13')).toBe('257.13-mica1')
  expect(() => nextVersion('1.0.0', '1.0.0')).toThrow('is not <upstream>-[mica]<revision>')
  expect(upstreamOf('2026c-0+deb13u1')).toBe('2026c')
  expect(upstreamOf('13.8+deb13u7')).toBe('13.8+deb13u7')
  // A package's version carries no epoch: the upstream's is dropped.
  expect(upstreamOf('1:10.0p1-7+deb13u4')).toBe('10.0p1')
})

// An update of the environment, the tools or the snapshot alone: every row keeps its
// version, sha256 and URL, no package is bumped, and there is nothing to release.
const ROW = (name: string, version: string, sha: string, day: string): string[] =>
  ['source', name, 'amd64', version, sha.repeat(64), `https://snapshot.debian.org/archive/debian/${day}T000000Z/pool/main/${name[0]}/${name}/${name}_${version}_amd64.deb`]
const lockOf = (rows: string[][]): string => `# mica-lock v1\n${rows.map(row => row.join('\t')).join('\n')}\n`

test('an environment, tools or snapshot move alone bumps nothing and releases nothing', () => {
  const before = [ROW('input.tzdata', '2026c-0+deb13u1', 'a', '20261101'), ROW('libc6', '2.41-12', 'b', '20261101')]
  const after = keepUrls([ROW('input.tzdata', '2026c-0+deb13u1', 'a', '20261107'), ROW('libc6', '2.41-12', 'b', '20261107')], before)
  expect(after).toEqual(before)
  const unchanged = { version: '2026c-mica3', upstream: '2026c', published: '2026c-mica3', inputsMoved: false, named: false }
  expect(bumped(unchanged)).toBe(false)
  expect(substantive(lockOf(before), lockOf(after), 0)).toBe(false)
  // A URL alone moving is no substance either.
  expect(substantive(lockOf(before), lockOf([before[0]!, ROW('libc6', '2.41-12', 'b', '20261107')]), 0)).toBe(false)
})

test('a package whose bytes moved is bumped when named, and only it', () => {
  const at = (version: string, named: boolean) => ({ version, upstream: upstreamOf(version), published: version, inputsMoved: false, named })
  expect(bumped(at('1.38.0-mica3', true))).toBe(true)
  expect(bumped(at('257.13-mica3', false))).toBe(false)
  // A version the latest release does not carry yet is new already.
  expect(bumped({ ...at('1.38.0-mica4', true), published: '1.38.0-mica3' })).toBe(false)
  expect(substantive(lockOf([]), lockOf([]), 1)).toBe(true)
})

test('an upstream row move bumps the package that takes it, and only it', () => {
  const before = [ROW('input.tzdata', '2026c-0+deb13u1', 'a', '20261101'), ROW('input.ca-certificates', '20250419', 'c', '20261101')]
  const after = keepUrls([ROW('input.tzdata', '2026d-0+deb13u1', 'd', '20261107'), ROW('input.ca-certificates', '20250419', 'c', '20261107')], before)
  // The moved row takes the new snapshot's URL; the other keeps its own.
  expect(after[0]![5]).toContain('20261107T000000Z')
  expect(after[1]).toEqual(before[1]!)
  expect(substantive(lockOf(before), lockOf(after), 0)).toBe(true)
  // tzdata's upstream moved; ca-trust's inputs hash, which takes the unchanged row, did not.
  expect(bumped({ version: '2026c-mica3', upstream: '2026d', published: '2026c-mica3', inputsMoved: true, named: false })).toBe(true)
  expect(bumped({ version: '20250419-mica3', upstream: '20250419', published: '20250419-mica3', inputsMoved: false, named: false })).toBe(false)
  // A package that carries a version of its own takes the upstream's.
  expect(bumped({ version: '1.0.0-3', upstream: '257.13', published: '1.0.0-3', inputsMoved: false, named: false })).toBe(true)
})

test('the latest release in a download listing is the highest version, not the last listed', () => {
  const busybox = '<a href="busybox-1.36.1.tar.bz2">x</a> <a href="busybox-1.38.0.tar.bz2">x</a> <a href="busybox-1.37.0.tar.bz2">x</a> <a href="busybox-1.38.0.tar.bz2.sig">x</a> busybox-snapshot.tar.bz2'
  expect(latestListed(busybox, 'busybox-', '.tar.bz2')).toBe('1.38.0')
  const w1 = 'hostapd-2.9.tar.gz hostapd-2.10.tar.gz wpa_supplicant-2.13.tar.gz hostapd-2.12.tar.gz'
  expect(latestListed(w1, 'hostapd-', '.tar.gz')).toBe('2.12')
  expect(latestListed(w1, 'wpa_supplicant-', '.tar.gz')).toBe('2.13')
  expect(() => latestListed(w1, 'busybox-', '.tar.bz2')).toThrow('no busybox-<version>.tar.bz2')
})

const SOURCES = `Package: systemd-cron
Version: 2.5.1-1

Package: systemd
Binary: systemd, udev
Version: 257.14-1~deb13u1
Checksums-Sha256:
 ${'a'.repeat(64)} 16543653 systemd_257.14.orig.tar.gz
 ${'b'.repeat(64)} 200000 systemd_257.14-1~deb13u1.debian.tar.xz
Directory: pool/main/s/systemd

`

const PACKAGES = `Package: linux-image-cloud-amd64
Source: linux-signed-amd64 (6.12.110+1)
Version: 6.12.110-1
Depends: linux-image-6.12.110+deb13-cloud-amd64 (= 6.12.110-1)

Package: linux-image-6.12.110+deb13-cloud-amd64
Version: 6.12.110-1
Filename: pool/main/l/linux-signed-amd64/linux-image-6.12.110+deb13-cloud-amd64_6.12.110-1_amd64.deb
SHA256: ${'c'.repeat(64)}
`

test('systemd\'s orig tarball and the cloud kernel are read from the snapshot\'s indexes', () => {
  expect(stanza(SOURCES, 'systemd').get('Binary')).toBe('systemd, udev')
  expect(debianSource(SOURCES, 'systemd', MIRROR)).toEqual({ version: '257.14', sha256: 'a'.repeat(64), url: `${MIRROR}/pool/main/s/systemd/systemd_257.14.orig.tar.gz` })
  expect(debianBinary(PACKAGES, 'linux-image-cloud-amd64', MIRROR)).toEqual({
    version: '6.12.110-1',
    sha256: 'c'.repeat(64),
    url: `${MIRROR}/pool/main/l/linux-signed-amd64/linux-image-6.12.110+deb13-cloud-amd64_6.12.110-1_amd64.deb`,
  })
  expect(() => stanza(SOURCES, 'udev')).toThrow('the index has no udev')
})

test('a source row, a recorded value and a control template are rewritten in place', () => {
  const lock = `# header\nsource\tinput.tzdata\tall\t2026c-0+deb13u1\t${'d'.repeat(64)}\thttps://x/tz.deb\nsource\tsource.busybox\tall\t1.38.0\t${'e'.repeat(64)}\thttps://busybox.net/downloads/busybox-1.38.0.tar.bz2\n`
  const pin = { version: '1.38.1', sha256: 'f'.repeat(64), url: 'https://busybox.net/downloads/busybox-1.38.1.tar.bz2' }
  expect(withSource(lock, 'source.busybox', pin)).toBe(lock.replace(/source\.busybox.*\n/, `source.busybox\tall\t1.38.1\t${'f'.repeat(64)}\t${pin.url}\n`))
  expect(() => withSource(lock, 'source.hostapd', pin)).toThrow('has no source.hostapd row')
  expect(withValue('# c\nA=1\nB=2\n', 'B', '3')).toBe('# c\nA=1\nB=3\n')
  expect(() => withValue('A=1\n', 'B', '3')).toThrow('no B= line')
  expect(withVersion('Package: p\nVersion: 1.0.0-1\nSource-Date-Epoch: 1\nArchitecture: @ARCH@\n', '1.0.0-2', 2)).toBe('Package: p\nVersion: 1.0.0-2\nSource-Date-Epoch: 2\nArchitecture: @ARCH@\n')
})

// The digest is the one mica-ca-trust's packer computes with find, sort and sha256sum.
test('the trust-anchor digest is the packer\'s', () => {
  const root = join(work, 'ca')
  for (const [path, content] of [['mozilla/B_Root.crt', 'b'], ['mozilla/A_Root.crt', 'a'], ['mozilla/a_lower.crt', 'c'], ['other/Z.crt', 'z']] as const) {
    mkdirSync(join(root, 'usr/share/ca-certificates', path, '..'), { recursive: true })
    writeFileSync(join(root, 'usr/share/ca-certificates', path), content)
  }
  const packer = run(['sh', '-c', `cd "${root}" && find ./usr/share/ca-certificates -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum | sed 's#  \\./#  /#' | sha256sum | cut -d' ' -f1`]).output.trim()
  expect(anchorsDigest(root)).toBe(packer)
})
