// What pin-inputs reads out of `apt-get --print-uris`.
import { expect, test } from 'bun:test'
import { addedNames, printedUri, runtimeNames, tagPinnedRoots } from '../src/pin-inputs.ts'

test('a --print-uris line gives its URL and file name, with or without the index hash', () => {
  const main = '\'https://snapshot.debian.org/archive/debian/20260905T000000Z/pool/main/p/pkgconf/pkg-config_1.8.1-4_amd64.deb\' pkg-config_1.8.1-4_amd64.deb 13768 SHA256:0a1b'
  expect(printedUri(main)).toEqual({ url: 'https://snapshot.debian.org/archive/debian/20260905T000000Z/pool/main/p/pkgconf/pkg-config_1.8.1-4_amd64.deb', file: 'pkg-config_1.8.1-4_amd64.deb' })
  // The security archive's lines carry no hash; the archive is checked against the signed index after download either way.
  const security = '\'https://snapshot.debian.org/archive/debian-security/20260905T000000Z/pool/updates/main/o/openssl/libssl-dev_3.5.7-1%7edeb13u2_amd64.deb\' libssl-dev_3.5.7-1~deb13u2_amd64.deb 2964784 '
  expect(printedUri(security)).toEqual({ url: 'https://snapshot.debian.org/archive/debian-security/20260905T000000Z/pool/updates/main/o/openssl/libssl-dev_3.5.7-1%7edeb13u2_amd64.deb', file: 'libssl-dev_3.5.7-1~deb13u2_amd64.deb' })
})

test('a line that is not a --print-uris line is refused', () => {
  expect(() => printedUri('Reading package lists...')).toThrow('unexpected apt-get --print-uris line')
  expect(() => printedUri('\'https://example.invalid/x.deb\' x.deb size')).toThrow('unexpected apt-get --print-uris line')
})

test('a root of upstream.pkgs the base lock pins is tagged for later stages, and only while it is a root', () => {
  const selected = new Map([
    ['bash', 'base'],
    ['coreutils', 'base,mica-system'],
    ['iw', 'upstream-iw'],
    ['sed', 'base,upstream-sed'],
    ['systemd', 'base,mica-system'],
  ])
  expect(tagPinnedRoots(selected, ['bash', 'coreutils', 'iw'])).toEqual(new Map([
    ['bash', 'base,upstream-bash'],
    ['coreutils', 'base,mica-system,upstream-coreutils'],
    ['iw', 'upstream-iw'],
    ['sed', 'base'],
    ['systemd', 'base,mica-system'],
  ]))
})

test('the runtime rows are the ones pinned for the root, the purged GNU set included', () => {
  const row = (name: string, consumers: string[]) => ({ name, version: '1', architecture: 'amd64', sha256: '', url: '', consumers })
  expect(runtimeNames([
    row('systemd', ['base', 'mica-system']),
    row('coreutils', ['base', 'upstream-coreutils']),
    row('iw', ['upstream-iw']),
    row('libc6', ['base']),
  ])).toEqual(['coreutils', 'libc6', 'systemd'])
})

test('a dependency the versions of a snapshot add to the root is named', () => {
  expect(addedNames(['a', 'b', 'c'], ['c', 'b', 'a'])).toEqual([])
  expect(addedNames(['a', 'b'], ['libnew', 'a', 'b'])).toEqual(['libnew'])
})
