// The floor's invariants and the systemd root's, each against a minimal root that
// satisfies them and the one change that breaks each.
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterAll, expect, test } from 'bun:test'
import { issue } from '../src/release.ts'
import { assertApplets, assertFloor, assertOpenrc, assertSystemd } from '../src/rootfs.ts'
import { unneeded } from '../src/bootstrap.ts'
import { workdir } from './fixture.ts'

const work = workdir('rootfs')
afterAll(() => rmSync(work, { recursive: true, force: true }))

// The commands the lifecycle helpers call: busybox applets, except the one a
// floor package provides.
const APPLETS = ['awk', 'basename', 'cat', 'chmod', 'chown', 'cp', 'df', 'dirname', 'grep', 'head', 'mkdir', 'mount', 'mv', 'printf', 'readlink', 'rm', 'sed', 'sleep', 'stat', 'sync', 'test', 'tr', 'umount']
const PROVIDED = ['usr/bin/findmnt']

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
  // busybox is the command set: /usr/bin/sh and every applet the helpers call link to it.
  put('usr/bin/busybox')
  symlinkSync('busybox', join(path, 'usr/bin/sh'))
  for (const applet of APPLETS)
    symlinkSync('/usr/bin/busybox', join(path, 'usr/bin', applet))
  for (const tool of PROVIDED)
    put(tool)
  put('var/lib/dpkg/status', 'Package: mica-busybox\nStatus: install ok installed\n\n')
  mkdirSync(join(path, 'mica'))
  return path
}

// The floor composed with mica-systemd: systemd the init, the preset, the getty
// drop-ins, mica-init and the tools it calls.
function systemdRoot(name: string): string {
  const path = root(name)
  const put = (file: string, content = ''): void => {
    mkdirSync(dirname(join(path, file)), { recursive: true })
    writeFileSync(join(path, file), content)
  }
  for (const tool of ['usr/lib/systemd/systemd', 'usr/lib/mica/mica-init', 'usr/bin/systemctl', 'usr/bin/systemd-repart'])
    put(tool)
  mkdirSync(join(path, 'usr/sbin'), { recursive: true })
  symlinkSync('../lib/systemd/systemd', join(path, 'usr/sbin/init'))
  put('usr/lib/systemd/system-preset/50-mica-nftables.preset', 'disable nftables.service\n')
  // No getty starts without the console option's login.
  for (const unit of ['getty@', 'serial-getty@'])
    put(`etc/systemd/system/${unit}.service.d/10-mica-console.conf`, '[Unit]\nConditionPathExists=/usr/bin/login\n')
  mkdirSync(join(path, 'etc/systemd/system/multi-user.target.wants'), { recursive: true })
  // Nothing waits for a link.
  symlinkSync('/dev/null', join(path, 'etc/systemd/system/systemd-networkd-wait-online.service'))
  put('var/lib/dpkg/status', 'Package: systemd\nStatus: install ok installed\n\nPackage: mica-systemd\nStatus: install ok installed\n\nPackage: mica-busybox\nStatus: install ok installed\n\n')
  return path
}

// The floor composed with mica-openrc and mica-mdev: openrc-init, the services in
// their runlevels, the resolver and capability policy, nothing of systemd.
const RUNLEVELS: Record<string, string[]> = {
  sysinit: ['cgroups', 'mica-kernfs', 'mica-mdev'],
  boot: ['mica-data-layout', 'mica-klogd', 'mica-mounts', 'mica-syslogd', 'mica-watchdog'],
  default: ['mica-dbus', 'mica-health', 'mica-local', 'mica-network', 'mica-ntpd', 'mica-provisioning-import', 'mica-shadow-reconcile'],
}
function openrcRoot(name: string): string {
  const path = root(name)
  const put = (file: string, content = ''): void => {
    mkdirSync(dirname(join(path, file)), { recursive: true })
    writeFileSync(join(path, file), content)
  }
  for (const tool of ['usr/sbin/openrc-init', 'usr/lib/mica/mica-init', 'usr/lib/mica/mica-grow-data', 'usr/sbin/sfdisk', 'etc/mdev.conf', 'usr/sbin/ifup', 'usr/sbin/ip', 'usr/sbin/udhcpc', 'usr/bin/logread', 'etc/mtab'])
    put(tool)
  symlinkSync('openrc-init', join(path, 'usr/sbin/init'))
  mkdirSync(join(path, 'etc/network'), { recursive: true })
  symlinkSync('../../var/lib/mica/network/interfaces', join(path, 'etc/network/interfaces'))
  for (const [runlevel, services] of Object.entries(RUNLEVELS)) {
    mkdirSync(join(path, 'etc/runlevels', runlevel), { recursive: true })
    for (const service of services) {
      put(`etc/init.d/${service}`, '#!/sbin/openrc-run\n')
      symlinkSync(`/etc/init.d/${service}`, join(path, 'etc/runlevels', runlevel, service))
    }
  }
  symlinkSync('../run/mica/resolv.conf', join(path, 'etc/resolv.conf'))
  put('etc/rc.conf.d/mica.conf', 'capabilities="!cap_sys_resource"\n')
  put('var/lib/dpkg/status', 'Package: openrc\nStatus: install ok installed\n\nPackage: mica-openrc\nStatus: install ok installed\n\nPackage: mica-busybox\nStatus: install ok installed\n\n')
  return path
}

test('a floor, a systemd root and an OpenRC root that keep every promise pass', () => {
  expect(() => assertFloor(root('good'), 'amd64')).not.toThrow()
  expect(() => assertSystemd(systemdRoot('good-systemd'), 'amd64')).not.toThrow()
  expect(() => assertOpenrc(openrcRoot('good-openrc'), 'amd64')).not.toThrow()
})

// An armhf root stores DATA in UBI: mica-storage-ubi stands in for e2fsprogs and
// fdisk, and neither they nor sfdisk are in it.
test('an armhf root carries mica-storage-ubi in place of e2fsprogs and fdisk', () => {
  const ubi = (path: string): string => {
    writeFileSync(join(path, 'var/lib/dpkg/status'), `${readFileSync(join(path, 'var/lib/dpkg/status'), 'utf8')}Package: mica-storage-ubi\nStatus: install ok installed\n\n`)
    return path
  }
  expect(() => assertFloor(root('armhf-no-stand-in'), 'armhf')).toThrow('the armhf root has no mica-storage-ubi')
  expect(() => assertFloor(ubi(root('armhf')), 'armhf')).not.toThrow()
  const openrc = ubi(openrcRoot('armhf-openrc'))
  rmSync(join(openrc, 'usr/sbin/sfdisk'))
  expect(() => assertOpenrc(openrc, 'armhf')).not.toThrow()
  expect(() => assertOpenrc(openrc, 'amd64')).toThrow('the OpenRC root has no /usr/sbin/sfdisk')
  const e2fsprogs = ubi(root('armhf-e2fsprogs'))
  writeFileSync(join(e2fsprogs, 'var/lib/dpkg/status'), `${readFileSync(join(e2fsprogs, 'var/lib/dpkg/status'), 'utf8')}Package: e2fsprogs\nStatus: install ok installed\n\n`)
  expect(() => assertFloor(e2fsprogs, 'armhf')).toThrow('the armhf root has e2fsprogs installed')
})

test('each broken promise of the OpenRC root is refused by name', () => {
  const systemd = openrcRoot('openrc-with-udev')
  writeFileSync(join(systemd, 'var/lib/dpkg/status'), 'Package: udev\nStatus: install ok installed\n\n')
  expect(() => assertOpenrc(systemd, 'amd64')).toThrow('the OpenRC root has udev installed')

  const init = openrcRoot('openrc-init-link')
  rmSync(join(init, 'usr/sbin/init'))
  symlinkSync('../lib/systemd/systemd', join(init, 'usr/sbin/init'))
  expect(() => assertOpenrc(init, 'amd64')).toThrow('/usr/sbin/init is not openrc-init')

  const missing = openrcRoot('openrc-no-mdev-conf')
  rmSync(join(missing, 'etc/mdev.conf'))
  expect(() => assertOpenrc(missing, 'amd64')).toThrow('no /etc/mdev.conf')

  const unlinked = openrcRoot('openrc-no-health')
  rmSync(join(unlinked, 'etc/runlevels/default/mica-health'))
  expect(() => assertOpenrc(unlinked, 'amd64')).toThrow('the default runlevel holds')

  const resolver = openrcRoot('openrc-resolver')
  rmSync(join(resolver, 'etc/resolv.conf'))
  symlinkSync('../run/systemd/resolve/stub-resolv.conf', join(resolver, 'etc/resolv.conf'))
  expect(() => assertOpenrc(resolver, 'amd64')).toThrow('/etc/resolv.conf does not link to /run/mica/resolv.conf')

  const network = openrcRoot('openrc-network')
  rmSync(join(network, 'etc/network/interfaces'))
  writeFileSync(join(network, 'etc/network/interfaces'), 'auto lo\n')
  expect(() => assertOpenrc(network, 'amd64')).toThrow('/etc/network/interfaces does not link')

  const capability = openrcRoot('openrc-capability')
  writeFileSync(join(capability, 'etc/rc.conf.d/mica.conf'), '')
  expect(() => assertOpenrc(capability, 'amd64')).toThrow('CAP_SYS_RESOURCE')
})

test('the floor carries no init', () => {
  for (const init of ['systemd-sysv', 'udev', 'mica-systemd']) {
    const installed = root(`init-${init}`)
    writeFileSync(join(installed, 'var/lib/dpkg/status'), `Package: ${init}\nStatus: install ok installed\n\n`)
    expect(() => assertFloor(installed, 'amd64')).toThrow(`the floor has an init installed: ${init}`)
  }
  const linked = root('init-link')
  mkdirSync(join(linked, 'usr/sbin'), { recursive: true })
  symlinkSync('../lib/systemd/systemd', join(linked, 'usr/sbin/init'))
  expect(() => assertFloor(linked, 'amd64')).toThrow('the floor carries /usr/sbin/init')
  // A systemd root is not a floor.
  expect(() => assertFloor(systemdRoot('systemd-as-floor'), 'amd64')).toThrow('the floor has an init installed')
})

test('each broken promise of the systemd root is refused by name', () => {
  const linked = systemdRoot('wants-link')
  symlinkSync('/usr/lib/systemd/system/nftables.service', join(linked, 'etc/systemd/system/multi-user.target.wants/nftables.service'))
  expect(() => assertSystemd(linked, 'amd64')).toThrow('enables or aliases a governed unit')

  const alias = systemdRoot('alias')
  symlinkSync('/usr/lib/systemd/system/nftables.service', join(alias, 'etc/systemd/system/firewall.service'))
  expect(() => assertSystemd(alias, 'amd64')).toThrow('enables or aliases a governed unit')

  const preset = systemdRoot('no-preset')
  rmSync(join(preset, 'usr/lib/systemd/system-preset/50-mica-nftables.preset'))
  expect(() => assertSystemd(preset, 'amd64')).toThrow('50-mica-nftables.preset')

  const waits = systemdRoot('wait-online-unmasked')
  rmSync(join(waits, 'etc/systemd/system/systemd-networkd-wait-online.service'))
  expect(() => assertSystemd(waits, 'amd64')).toThrow('systemd-networkd-wait-online.service is not masked')

  const pulled = systemdRoot('network-online-wants')
  mkdirSync(join(pulled, 'etc/systemd/system/network-online.target.wants'))
  symlinkSync('/usr/lib/systemd/system/systemd-networkd-wait-online.service', join(pulled, 'etc/systemd/system/network-online.target.wants/systemd-networkd-wait-online.service'))
  expect(() => assertSystemd(pulled, 'amd64')).toThrow('network-online.target pulls in')

  const getty = systemdRoot('getty-unconditioned')
  rmSync(join(getty, 'etc/systemd/system/serial-getty@.service.d/10-mica-console.conf'))
  expect(() => assertSystemd(getty, 'amd64')).toThrow('serial-getty@.service')

  const noInit = systemdRoot('no-mica-init')
  rmSync(join(noInit, 'usr/lib/mica/mica-init'))
  expect(() => assertSystemd(noInit, 'amd64')).toThrow('no /usr/lib/mica/mica-init')

  const notSystemd = systemdRoot('init-not-systemd')
  rmSync(join(notSystemd, 'usr/sbin/init'))
  symlinkSync('openrc-init', join(notSystemd, 'usr/sbin/init'))
  expect(() => assertSystemd(notSystemd, 'amd64')).toThrow('/usr/sbin/init is not systemd')
})

test('each broken promise of the floor is refused by name', () => {
  const key = root('host-key')
  mkdirSync(join(key, 'etc/dropbear'))
  writeFileSync(join(key, 'etc/dropbear/dropbear_ed25519_host_key'), 'key')
  expect(() => assertFloor(key, 'amd64')).toThrow('host keys')

  const hostname = root('build-hostname')
  writeFileSync(join(hostname, 'etc/hostname'), '9e5fa5a15eeb\n')
  expect(() => assertFloor(hostname, 'amd64')).toThrow('/etc/hostname')

  // The build host's resolver, copied in by mmdebstrap, is not the device's.
  const resolver = root('build-resolv-conf')
  writeFileSync(join(resolver, 'etc/resolv.conf'), 'nameserver 10.0.0.1\n')
  expect(() => assertFloor(resolver, 'amd64')).toThrow('/etc/resolv.conf')

  const machine = root('machine-id')
  writeFileSync(join(machine, 'etc/machine-id'), '0123456789abcdef0123456789abcdef\n')
  expect(() => assertFloor(machine, 'amd64')).toThrow('machine-id')

  const state = root('state')
  mkdirSync(join(state, 'mnt/data/state/ssh'), { recursive: true })
  writeFileSync(join(state, 'mnt/data/state/ssh/x'), '')
  expect(() => assertFloor(state, 'amd64')).toThrow('/mnt/data/state')

  const unmounted = root('no-mica-mountpoint')
  rmSync(join(unmounted, 'mica'), { recursive: true })
  expect(() => assertFloor(unmounted, 'amd64')).toThrow('/mica')

  const motd = root('motd')
  writeFileSync(join(motd, 'etc/motd'), 'The programs included with the Debian GNU/Linux system are free software;\n')
  expect(() => assertFloor(motd, 'amd64')).toThrow('/etc/motd')

  const debianIssue = root('debian-issue')
  writeFileSync(join(debianIssue, 'etc/issue'), 'Debian GNU/Linux 13 \\n \\l\n\n')
  expect(() => assertFloor(debianIssue, 'amd64')).toThrow('/etc/issue')

  for (const field of ['x', '', '$y$j9T$salt$hash']) {
    const shadow = root(`shadow-${field.length}`)
    writeFileSync(join(shadow, 'etc/shadow'), `root:*:18262:0:99999:7:::\nsystemd-network:${field}:18262:0:99999:7:::\n`)
    expect(() => assertFloor(shadow, 'amd64')).toThrow(`/etc/shadow has unlocked entries: systemd-network:${field}`)
  }
  const gshadow = root('gshadow')
  writeFileSync(join(gshadow, 'etc/gshadow'), 'root:*::\nnetdev:x::\n')
  expect(() => assertFloor(gshadow, 'amd64')).toThrow('/etc/gshadow has unlocked entries: netdev:x')
  const backup = root('gshadow-backup')
  writeFileSync(join(backup, 'etc/gshadow-'), 'root:*::\nnetdev:x::\n')
  expect(() => assertFloor(backup, 'amd64')).toThrow('/etc/gshadow- has unlocked entries: netdev:x')

  // The build day, an empty day and a day in a backup are each refused.
  for (const [file, day] of [['etc/shadow', '20710'], ['etc/shadow', ''], ['etc/shadow-', '20711']] as const) {
    const dated = root(`shadow-day-${file.length}-${day}`)
    writeFileSync(join(dated, file), `root:*:18262:0:99999:7:::\nsystemd-network:*:${day}:0:99999:7:::\n`)
    expect(() => assertFloor(dated, 'amd64')).toThrow(`/${file} has last-change days other than 18262: systemd-network:${day}`)
  }

  // The options are not in the floor.
  for (const option of ['dropbear-bin', 'nftables', 'procps', 'dmsetup', 'kmod', 'login', 'tzdata']) {
    const installed = root(`option-${option}`)
    writeFileSync(join(installed, 'var/lib/dpkg/status'), `Package: ${option}\nStatus: install ok installed\n\n`)
    expect(() => assertFloor(installed, 'amd64')).toThrow(`the floor has the option ${option} installed`)
  }
  // Nor the command set busybox replaces.
  for (const gnu of ['bash', 'coreutils', 'dash', 'diffutils', 'findutils', 'grep', 'gzip', 'sed']) {
    const installed = root(`gnu-${gnu}`)
    writeFileSync(join(installed, 'var/lib/dpkg/status'), `Package: ${gnu}\nStatus: install ok installed\n\n`)
    expect(() => assertFloor(installed, 'amd64')).toThrow(`the floor has ${gnu} installed`)
  }
  const bash = root('bash-binary')
  writeFileSync(join(bash, 'usr/bin/bash'), '')
  expect(() => assertFloor(bash, 'amd64')).toThrow('/usr/bin/bash')

  const dashSh = root('sh-not-busybox')
  rmSync(join(dashSh, 'usr/bin/sh'))
  symlinkSync('dash', join(dashSh, 'usr/bin/sh'))
  expect(() => assertFloor(dashSh, 'amd64')).toThrow('/usr/bin/sh is not busybox')

  const noStat = root('no-stat')
  rmSync(join(noStat, 'usr/bin/stat'))
  expect(() => assertFloor(noStat, 'amd64')).toThrow('no stat for the lifecycle helpers')
  const noFindmnt = root('no-findmnt')
  rmSync(join(noFindmnt, 'usr/bin/findmnt'))
  expect(() => assertFloor(noFindmnt, 'amd64')).toThrow('no findmnt for the lifecycle helpers')

  for (const account of ['root', 'mica']) {
    const shell = root(`shell-${account}`)
    writeFileSync(join(shell, 'etc/passwd'), `root:x:0:0:root:/root:${account === 'root' ? '/bin/bash' : '/bin/sh'}\nmica:x:1000:1000:mica operator:/home/mica:${account === 'mica' ? '/bin/bash' : '/bin/sh'}\n`)
    expect(() => assertFloor(shell, 'amd64')).toThrow(`${account} logs in with /bin/bash, not /bin/sh`)
  }

  const gconv = root('gconv')
  writeFileSync(join(gconv, 'usr/bin/placeholder'), '')
  mkdirSync(join(gconv, 'usr/lib/x86_64-linux-gnu/gconv'), { recursive: true })
  writeFileSync(join(gconv, 'usr/lib/x86_64-linux-gnu/gconv/UTF-16.so'), '')
  expect(() => assertFloor(gconv, 'amd64')).toThrow('gconv')

  const openssh = root('openssh')
  mkdirSync(join(openssh, 'usr/sbin'), { recursive: true })
  writeFileSync(join(openssh, 'usr/sbin/sshd'), '')
  expect(() => assertFloor(openssh, 'amd64')).toThrow('/usr/sbin/sshd')
})

// The libraries only the GNU command set loads go with it, together when they depend
// on each other, and stay while a package the root keeps depends on them.
test('an orphaned library is purged unless a kept package depends on it', () => {
  const status = (packages: [string, string][]): string => {
    const path = join(work, `status-${packages.length}`)
    mkdirSync(join(path, 'var/lib/dpkg'), { recursive: true })
    writeFileSync(join(path, 'var/lib/dpkg/status'), packages.map(([name, depends]) => `Package: ${name}\nStatus: install ok installed\n${depends ? `Depends: ${depends}\n` : ''}`).join('\n'))
    return path
  }
  const floor: [string, string][] = [
    ['libc6', ''],
    ['libssl3t64', 'libc6 (>= 2.38), openssl-provider-legacy'],
    ['openssl-provider-legacy', 'libc6 (>= 2.14), libssl3t64 (>= 3.0.3)'],
    ['libgmp10', 'libc6'],
  ]
  expect(unneeded(status(floor), ['libgmp10', 'libssl3t64', 'openssl-provider-legacy', 'absent'])).toEqual(['libgmp10', 'libssl3t64', 'openssl-provider-legacy'])
  const systemd = status([...floor, ['libsystemd-shared', 'libc6, libssl3t64 (>= 3.0.0) | libfoo']])
  expect(unneeded(systemd, ['libgmp10', 'libssl3t64', 'openssl-provider-legacy'])).toEqual(['libgmp10'])
})

// Every applet is linked under /usr/libexec/busybox, and a login shell finds the root's own
// command first: here ip (a full product's iproute2) at /usr/sbin, ping only as
// the applet, and cat at /usr/bin, where the floor links it to busybox.
test('the applet links follow busybox --list and come after every command of the root', () => {
  const applets = ['cat', 'ip', 'ping']
  const linked = (name: string): string => {
    const path = join(work, name)
    mkdirSync(join(path, 'usr/libexec/busybox'), { recursive: true })
    mkdirSync(join(path, 'usr/sbin'), { recursive: true })
    mkdirSync(join(path, 'usr/bin'), { recursive: true })
    for (const applet of applets)
      symlinkSync('/usr/bin/busybox', join(path, 'usr/libexec/busybox', applet))
    writeFileSync(join(path, 'usr/sbin/ip'), '')
    symlinkSync('/usr/bin/busybox', join(path, 'usr/bin/cat'))
    return path
  }
  const found = new Map([['cat', '/usr/bin/cat'], ['ip', '/usr/sbin/ip'], ['ping', '/usr/libexec/busybox/ping']])
  expect(() => assertApplets(linked('applets'), applets, found)).not.toThrow()

  expect(() => assertApplets(linked('applets-missing'), [...applets, 'vi'], found)).toThrow('missing vi')
  const extra = linked('applets-extra')
  symlinkSync('/usr/bin/busybox', join(extra, 'usr/libexec/busybox/telnetd'))
  expect(() => assertApplets(extra, applets, found)).toThrow('extra telnetd')
  const wrong = linked('applets-wrong-target')
  rmSync(join(wrong, 'usr/libexec/busybox/ping'))
  symlinkSync('/bin/false', join(wrong, 'usr/libexec/busybox/ping'))
  expect(() => assertApplets(wrong, applets, found)).toThrow('/usr/libexec/busybox/ping links to /bin/false')
  expect(() => assertApplets(linked('applets-ahead'), applets, new Map([...found, ['ip', '/usr/libexec/busybox/ip']]))).toThrow('finds ip at /usr/libexec/busybox/ip, not /usr/sbin/ip')
})
