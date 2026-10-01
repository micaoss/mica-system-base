// The monthly update's parts that read upstreams and rewrite pins, against
// recorded shapes of each upstream's answer.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, expect, test } from 'bun:test'
import { anchorsDigest, debianBinary, debianSource, latestListed, nextVersion, stanza, upstreamOf, withSource, withValue, withVersion } from '../src/update.ts'
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
