// The real lock: a minimal base, and additive selections on both architectures.

import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { ARCHES, lines, selectRuntime } from '../src/lock.ts'
import { BASE_PACKAGES } from '../src/rootfs.ts'
import { REPO, workdir } from './fixture.ts'

const work = workdir('debian-lock')
afterAll(() => rmSync(work, { recursive: true, force: true }))

function names(arch: (typeof ARCHES)[number], consumers?: string[]): string[] {
  if (!consumers)
    return selectRuntime(REPO, arch, { kind: 'base' }).map(row => row.name)
  const file = join(work, `${consumers.join('+')}.pkgs`)
  writeFileSync(file, `${consumers.join('\n')}\n`)
  return selectRuntime(REPO, arch, { kind: 'consumers', file }).map(row => row.name)
}

describe.each(ARCHES)('%s', (arch) => {
  test('the base stays minimal', () => {
    const base = names(arch)
    expect(base.length).toBeGreaterThan(0)
    expect(base.length).toBeLessThan(100)
    for (const optional of ['apt', 'dropbear-bin', 'bluez', 'systemd', 'curl'])
      expect(base).not.toContain(optional)
  })

  test('mica-system adds the system services to the base', () => {
    const system = names(arch, ['mica-system'])
    expect(system.length).toBeGreaterThan(names(arch).length)
    expect(system).toEqual(expect.arrayContaining(['systemd', 'dropbear-bin', 'nftables', 'procps', 'dmsetup']))
  })

  test('the static mica-busybox consumes no row of the lock', () => {
    expect(selectRuntime(REPO, arch, { kind: 'all' }).filter(row => row.consumers.includes('mica-busybox'))).toEqual([])
  })

  test('upstream certificates never reach a root that carries mica-ca-trust', () => {
    expect(names(arch, ['mica-system', 'mica-ca-trust'])).not.toContain('ca-certificates')
  })
})

// Every row names a registered family. The base root is board-independent: the
// board and radio packages the lock pins for later stages never reach it.
test.each(ARCHES)('%s: only registered families consume the lock, and no board feature is in the base root', (arch) => {
  const families = new Set(['base', ...lines(join(REPO, 'debs/consumers.pkgs'))])
  const all = selectRuntime(REPO, arch, { kind: 'all' })
  const registered = (consumer: string): boolean => families.has(consumer) || [...families].some(family => family.endsWith('-*') && consumer.startsWith(family.slice(0, -1)))
  for (const row of all)
    expect(row.consumers.filter(consumer => !registered(consumer))).toEqual([])
  const root = names(arch, BASE_PACKAGES)
  for (const feature of ['bluez', 'wpasupplicant', 'hostapd', 'iw', 'rfkill', 'alsa-utils'])
    expect(root).not.toContain(feature)
})

// upstream.pkgs names the Debian packages later stages install on the base root;
// their closure beyond the root is pinned here, each row selected as
// upstream-<root> for every root it is pinned for, never installed into the
// root, and published as the upstream rows of mica-system-base.lock.
test.each(ARCHES)('%s: every upstream package is pinned for the roots that need it and stays out of the base root', (arch) => {
  const roots = lines(join(REPO, 'upstream.pkgs'))
  expect(roots.length).toBeGreaterThan(0)
  const upstream = selectRuntime(REPO, arch, { kind: 'all' }).filter(row => row.consumers.some(consumer => consumer.startsWith('upstream-')))
  for (const name of roots)
    expect(upstream.find(row => row.name === name)?.consumers).toContain(`upstream-${name}`)
  for (const row of upstream) {
    expect(row.consumers.length).toBeGreaterThan(0)
    for (const consumer of row.consumers)
      expect(roots).toContain(consumer.replace(/^upstream-/, ''))
  }
  const root = new Set(names(arch, BASE_PACKAGES))
  expect(upstream.filter(row => root.has(row.name))).toEqual([])
})

// The base floor: no curl, iproute2 or iptables.
test.each(ARCHES)('%s: curl, iproute2 and iptables stay out of the lock', (arch) => {
  const all = selectRuntime(REPO, arch, { kind: 'all' }).map(row => row.name)
  for (const removed of ['curl', 'libcurl4t64', 'iproute2', 'iptables', 'libip4tc2', 'libip6tc2'])
    expect(all).not.toContain(removed)
})

// The SSH server is dropbear; OpenSSH is not in the lock.
test.each(ARCHES)('%s: mica-system gets dropbear, never OpenSSH', (arch) => {
  const all = selectRuntime(REPO, arch, { kind: 'all' }).map(row => row.name)
  for (const removed of ['openssh-server', 'openssh-client', 'openssh-sftp-server', 'libfido2-1'])
    expect(all).not.toContain(removed)
  expect(names(arch, ['mica-system'])).toEqual(expect.arrayContaining(['dropbear-bin', 'libtomcrypt1', 'libtommath1']))
})

// Registration is not installation: a registered package that tags no row is
// selectable and adds nothing; a name the registry does not know is refused.
test.each(ARCHES)('%s: mica-systemd-boot is selectable and adds no upstream row; an unknown name is refused', (arch) => {
  expect(names(arch, ['mica-systemd-boot'])).toEqual(names(arch))
  expect(() => names(arch, ['mica-unknown-package'])).toThrow('unknown package consumer')
})
