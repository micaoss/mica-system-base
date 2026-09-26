// The floor's invariants, against a minimal root that satisfies them and the one
// change that breaks each.
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterAll, expect, test } from 'bun:test'
import { issue } from '../src/release.ts'
import { assertBase } from '../src/rootfs.ts'
import { workdir } from './fixture.ts'

const work = workdir('rootfs')
afterAll(() => rmSync(work, { recursive: true, force: true }))

// The commands the lifecycle helpers call: busybox applets, except the four a
// floor package provides.
const APPLETS = ['awk', 'basename', 'cat', 'chmod', 'chown', 'cp', 'df', 'dirname', 'grep', 'head', 'mkdir', 'mount', 'mv', 'printf', 'readlink', 'rm', 'sed', 'sleep', 'stat', 'sync', 'test', 'tr', 'umount']
const PROVIDED = ['usr/bin/findmnt', 'usr/sbin/setquota', 'usr/bin/systemctl', 'usr/bin/systemd-repart']

function root(name: string): string {
  const path = join(work, name)
  const put = (file: string, content = ''): void => {
    mkdirSync(dirname(join(path, file)), { recursive: true })
    writeFileSync(join(path, file), content)
  }
  put('etc/hostname', 'mica\n')
  put('etc/issue', issue('20260914-0130', 'c'.repeat(40), '2026-09-14T01:40:00Z'))
  put('etc/machine-id')
  put('etc/passwd', 'root:x:0:0:root:/root:/bin/sh\nsystemd-network:x:998:998::/:/usr/sbin/nologin\nmica:x:1000:1000:mica operator:/home/mica:/bin/sh\n')
  put('etc/shadow', 'root:*:18262:0:99999:7:::\nsystemd-network:*:18262:0:99999:7:::\nmica:!:18262:0:99999:7:::\n')
  put('etc/gshadow', 'root:*::\nnetdev:*::\nmica:!::\n')
  put('usr/lib/systemd/system-preset/50-mica-nftables.preset', 'disable nftables.service\n')
  // No getty starts without the console option's login.
  for (const unit of ['getty@', 'serial-getty@'])
    put(`etc/systemd/system/${unit}.service.d/10-mica-console.conf`, '[Unit]\nConditionPathExists=/usr/bin/login\n')
  // busybox is the command set: /usr/bin/sh and every applet the helpers call link to it.
  put('usr/bin/busybox')
  symlinkSync('busybox', join(path, 'usr/bin/sh'))
  for (const applet of APPLETS)
    symlinkSync('/usr/bin/busybox', join(path, 'usr/bin', applet))
  for (const tool of PROVIDED)
    put(tool)
  put('var/lib/dpkg/status', 'Package: systemd\nStatus: install ok installed\n\nPackage: mica-busybox\nStatus: install ok installed\n\n')
  mkdirSync(join(path, 'etc/systemd/system/multi-user.target.wants'), { recursive: true })
  mkdirSync(join(path, 'mica'))
  return path
}

test('a root that keeps every promise passes', () => {
  expect(() => assertBase(root('good'))).not.toThrow()
})

test('each broken promise is refused by name', () => {
  const linked = root('wants-link')
  symlinkSync('/usr/lib/systemd/system/nftables.service', join(linked, 'etc/systemd/system/multi-user.target.wants/nftables.service'))
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

  // The options are not in the floor.
  for (const option of ['dropbear-bin', 'nftables', 'procps', 'dmsetup', 'kmod', 'login', 'tzdata']) {
    const installed = root(`option-${option}`)
    writeFileSync(join(installed, 'var/lib/dpkg/status'), `Package: ${option}\nStatus: install ok installed\n\n`)
    expect(() => assertBase(installed)).toThrow(`the floor has the option ${option} installed`)
  }
  // Nor the command set busybox replaces.
  for (const gnu of ['bash', 'coreutils', 'dash', 'diffutils', 'findutils', 'grep', 'gzip', 'sed']) {
    const installed = root(`gnu-${gnu}`)
    writeFileSync(join(installed, 'var/lib/dpkg/status'), `Package: ${gnu}\nStatus: install ok installed\n\n`)
    expect(() => assertBase(installed)).toThrow(`the floor has ${gnu} installed`)
  }
  const bash = root('bash-binary')
  writeFileSync(join(bash, 'usr/bin/bash'), '')
  expect(() => assertBase(bash)).toThrow('/usr/bin/bash')

  const dashSh = root('sh-not-busybox')
  rmSync(join(dashSh, 'usr/bin/sh'))
  symlinkSync('dash', join(dashSh, 'usr/bin/sh'))
  expect(() => assertBase(dashSh)).toThrow('/usr/bin/sh is not busybox')

  const noStat = root('no-stat')
  rmSync(join(noStat, 'usr/bin/stat'))
  expect(() => assertBase(noStat)).toThrow('no stat for the lifecycle helpers')
  const noFindmnt = root('no-findmnt')
  rmSync(join(noFindmnt, 'usr/bin/findmnt'))
  expect(() => assertBase(noFindmnt)).toThrow('no findmnt for the lifecycle helpers')

  for (const account of ['root', 'mica']) {
    const shell = root(`shell-${account}`)
    writeFileSync(join(shell, 'etc/passwd'), `root:x:0:0:root:/root:${account === 'root' ? '/bin/bash' : '/bin/sh'}\nmica:x:1000:1000:mica operator:/home/mica:${account === 'mica' ? '/bin/bash' : '/bin/sh'}\n`)
    expect(() => assertBase(shell)).toThrow(`${account} logs in with /bin/bash, not /bin/sh`)
  }

  const gconv = root('gconv')
  writeFileSync(join(gconv, 'usr/bin/placeholder'), '')
  mkdirSync(join(gconv, 'usr/lib/x86_64-linux-gnu/gconv'), { recursive: true })
  writeFileSync(join(gconv, 'usr/lib/x86_64-linux-gnu/gconv/UTF-16.so'), '')
  expect(() => assertBase(gconv)).toThrow('gconv')

  const getty = root('getty-unconditioned')
  rmSync(join(getty, 'etc/systemd/system/serial-getty@.service.d/10-mica-console.conf'))
  expect(() => assertBase(getty)).toThrow('serial-getty@.service')

  const openssh = root('openssh')
  mkdirSync(join(openssh, 'usr/sbin'), { recursive: true })
  writeFileSync(join(openssh, 'usr/sbin/sshd'), '')
  expect(() => assertBase(openssh)).toThrow('/usr/sbin/sshd')
})
