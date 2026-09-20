// The base-root invariants, against a minimal root that satisfies them and the
// one change that breaks each.
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterAll, expect, test } from 'bun:test'
import { issue } from '../src/release.ts'
import { assertBase } from '../src/rootfs.ts'
import { workdir } from './fixture.ts'

const work = workdir('rootfs')
afterAll(() => rmSync(work, { recursive: true, force: true }))

function root(name: string): string {
  const path = join(work, name)
  const put = (file: string, content = ''): void => {
    mkdirSync(dirname(join(path, file)), { recursive: true })
    writeFileSync(join(path, file), content)
  }
  put('etc/hostname', 'mica\n')
  put('etc/issue', issue('20260914-0130', 'c'.repeat(40), '2026-09-14T01:40:00Z'))
  put('etc/machine-id')
  put('etc/shadow', 'root:*:18262:0:99999:7:::\nsystemd-network:*:18262:0:99999:7:::\nmica:!:18262:0:99999:7:::\n')
  put('etc/gshadow', 'root:*::\nnetdev:*::\nmica:!::\n')
  put('etc/systemd/system/dropbear.service', '[Unit]\nRequires=mica-shadow-reconcile.service\nAfter=network.target mica-shadow-reconcile.service\n')
  put('usr/lib/systemd/system/nftables.service', '[Unit]\n')
  put('usr/lib/systemd/system-preset/50-mica-dropbear.preset', 'disable dropbear.service\n')
  put('usr/lib/systemd/system-preset/50-mica-nftables.preset', 'disable nftables.service\n')
  for (const tool of ['usr/bin/busybox', 'usr/sbin/nft', 'usr/sbin/dmsetup'])
    put(tool)
  // dropbear reaches an account through crypt(3), not through PAM: neither its
  // Depends nor its binary may name libpam.
  put('usr/sbin/dropbear', 'ELF\0libtomcrypt.so.1\0libc.so.6\0')
  put('var/lib/dpkg/status', 'Package: busybox\nStatus: install ok installed\n\nPackage: dropbear-bin\nStatus: install ok installed\nDepends: libc6, libcrypt1, libtomcrypt1, libtommath1, zlib1g\n\n')
  mkdirSync(join(path, 'etc/systemd/system/multi-user.target.wants'), { recursive: true })
  // A base root has a login console on tty1; systemd's preset enables it.
  mkdirSync(join(path, 'etc/systemd/system/getty.target.wants'), { recursive: true })
  symlinkSync('/usr/lib/systemd/system/getty@.service', join(path, 'etc/systemd/system/getty.target.wants/getty@tty1.service'))
  mkdirSync(join(path, 'mica'))
  return path
}

test('a root that keeps every promise passes', () => {
  expect(() => assertBase(root('good'))).not.toThrow()
})

test('each broken promise is refused by name', () => {
  const linked = root('wants-link')
  symlinkSync('/etc/systemd/system/dropbear.service', join(linked, 'etc/systemd/system/multi-user.target.wants/dropbear.service'))
  expect(() => assertBase(linked)).toThrow('enables or aliases a governed unit')

  const alias = root('alias')
  symlinkSync('/usr/lib/systemd/system/nftables.service', join(alias, 'etc/systemd/system/firewall.service'))
  expect(() => assertBase(alias)).toThrow('enables or aliases a governed unit')

  const preset = root('no-preset')
  rmSync(join(preset, 'usr/lib/systemd/system-preset/50-mica-nftables.preset'))
  expect(() => assertBase(preset)).toThrow('50-mica-nftables.preset')

  const key = root('host-key')
  mkdirSync(join(key, 'etc/dropbear'))
  writeFileSync(join(key, 'etc/dropbear/dropbear_ed25519_host_key'), 'key')
  expect(() => assertBase(key)).toThrow('host keys')

  const hostname = root('build-hostname')
  writeFileSync(join(hostname, 'etc/hostname'), '9e5fa5a15eeb\n')
  expect(() => assertBase(hostname)).toThrow('/etc/hostname')

  const machine = root('machine-id')
  writeFileSync(join(machine, 'etc/machine-id'), '0123456789abcdef0123456789abcdef\n')
  expect(() => assertBase(machine)).toThrow('machine-id')

  const state = root('state')
  mkdirSync(join(state, 'mnt/data/state/ssh'), { recursive: true })
  writeFileSync(join(state, 'mnt/data/state/ssh/x'), '')
  expect(() => assertBase(state)).toThrow('/mnt/data/state')

  const unmounted = root('no-mica-mountpoint')
  rmSync(join(unmounted, 'mica'), { recursive: true })
  expect(() => assertBase(unmounted)).toThrow('/mica')

  const motd = root('motd')
  writeFileSync(join(motd, 'etc/motd'), 'The programs included with the Debian GNU/Linux system are free software;\n')
  expect(() => assertBase(motd)).toThrow('/etc/motd')

  const debianIssue = root('debian-issue')
  writeFileSync(join(debianIssue, 'etc/issue'), 'Debian GNU/Linux 13 \\n \\l\n\n')
  expect(() => assertBase(debianIssue)).toThrow('/etc/issue')

  for (const field of ['x', '', '$y$j9T$salt$hash']) {
    const shadow = root(`shadow-${field.length}`)
    writeFileSync(join(shadow, 'etc/shadow'), `root:*:18262:0:99999:7:::\nsystemd-network:${field}:18262:0:99999:7:::\n`)
    expect(() => assertBase(shadow)).toThrow(`/etc/shadow has unlocked entries: systemd-network:${field}`)
  }
  const gshadow = root('gshadow')
  writeFileSync(join(gshadow, 'etc/gshadow'), 'root:*::\nnetdev:x::\n')
  expect(() => assertBase(gshadow)).toThrow('/etc/gshadow has unlocked entries: netdev:x')
  const backup = root('gshadow-backup')
  writeFileSync(join(backup, 'etc/gshadow-'), 'root:*::\nnetdev:x::\n')
  expect(() => assertBase(backup)).toThrow('/etc/gshadow- has unlocked entries: netdev:x')

  // The build day, an empty day and a day in a backup are each refused.
  for (const [file, day] of [['etc/shadow', '20710'], ['etc/shadow', ''], ['etc/shadow-', '20711']] as const) {
    const dated = root(`shadow-day-${file.length}-${day}`)
    writeFileSync(join(dated, file), `root:*:18262:0:99999:7:::\nsystemd-network:*:${day}:0:99999:7:::\n`)
    expect(() => assertBase(dated)).toThrow(`/${file} has last-change days other than 18262: systemd-network:${day}`)
  }

  const pamDepends = root('dropbear-pam-depends')
  writeFileSync(join(pamDepends, 'var/lib/dpkg/status'), 'Package: dropbear-bin\nStatus: install ok installed\nDepends: libc6, libpam0g (>= 0.99.7.1)\n\n')
  expect(() => assertBase(pamDepends)).toThrow('dropbear-bin depends on PAM')

  const pamLinked = root('dropbear-pam-linked')
  writeFileSync(join(pamLinked, 'usr/sbin/dropbear'), 'ELF\0libpam.so.0\0libc.so.6\0')
  expect(() => assertBase(pamLinked)).toThrow('/usr/sbin/dropbear names libpam')

  const noDropbear = root('no-dropbear-status')
  writeFileSync(join(noDropbear, 'var/lib/dpkg/status'), 'Package: busybox\nStatus: install ok installed\n\n')
  expect(() => assertBase(noDropbear)).toThrow('no installed dropbear-bin')

  const noTty1 = root('no-tty1')
  rmSync(join(noTty1, 'etc/systemd/system/getty.target.wants/getty@tty1.service'))
  expect(() => assertBase(noTty1)).toThrow('no getty.target.wants/getty@tty1.service')

  const openssh = root('openssh')
  mkdirSync(join(openssh, 'usr/sbin'), { recursive: true })
  writeFileSync(join(openssh, 'usr/sbin/sshd'), '')
  expect(() => assertBase(openssh)).toThrow('/usr/sbin/sshd')
})
