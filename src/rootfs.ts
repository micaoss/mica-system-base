// The base root: the lock and this repository's own packages, installed by one
// mmdebstrap run, then held to the invariants the base promises every product.
import type { Row } from './lock.ts'
import type { PinnedGroup, PinnedUser } from './pins.ts'
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fail } from './errors.ts'
import { output } from './exec.ts'
import { ISSUE, issue } from './release.ts'
import { sha256File } from './verify.ts'

// This repository's archives that belong in the base root; mica-systemd-boot is
// the EFI loader the product signs, not part of a root.
export const BASE_PACKAGES = ['mica-system', 'mica-busybox', 'mica-ca-trust']

// The inits a product chooses between; the floor carries neither. Each is this
// repository's packages and the roots of locks/upstream.pkgs whose closure it needs.
export const INITS = {
  systemd: {
    packages: ['mica-systemd'],
    roots: ['systemd', 'systemd-sysv', 'udev', 'systemd-resolved', 'systemd-timesyncd', 'systemd-repart'],
  },
  openrc: {
    packages: ['mica-openrc', 'mica-mdev'],
    roots: ['openrc', 'fdisk'],
  },
} as const
export type Init = keyof typeof INITS
// Installed, any of these is an init in the root.
const INIT_PACKAGES = ['systemd-sysv', 'udev', ...Object.values(INITS).flatMap(init => [...init.packages, ...init.roots])]

// The floor's command set is busybox: these packages are installed with the rest,
// so that maintainer scripts run with the tools they were written for, and purged
// once the root is in place (src/bootstrap.ts strip). A product that wants them
// back selects them; the release pins them for it.
export const STRIPPED = ['bash', 'coreutils', 'dash', 'diffutils', 'findutils', 'grep', 'gzip', 'sed']

// The libraries only STRIPPED loads (coreutils): purged after it unless a package the
// root keeps still depends on them, as systemd does on libssl3t64.
export const ORPHANED = ['libgmp10', 'libssl3t64', 'openssl-provider-legacy']

// Debian packages a product may add to the floor, none of which the floor carries.
const OPTIONS = ['dmsetup', 'dropbear-bin', 'kmod', 'login', 'nftables', 'procps', 'tzdata']

// What the lifecycle helpers under /usr/lib/mica call: busybox applets, and the
// few a floor package provides (util-linux).
const HELPER_COMMANDS = ['awk', 'basename', 'cat', 'chmod', 'chown', 'cp', 'df', 'dirname', 'findmnt', 'grep', 'head', 'mkdir', 'mount', 'mv', 'printf', 'readlink', 'rm', 'sed', 'sleep', 'stat', 'sync', 'test', 'tr', 'umount']

// The build identity the host passes into the bootstrap for /etc/issue.
export const ISSUE_ENV = ['MICA_BASE_LABEL', 'MICA_BASE_COMMIT', 'MICA_BUILD_TIME']

// /etc/issue carries the release, build time and commit; /etc/motd is removed.
export function writeRelease(root: string): void {
  const [label = '', commit = '', built = ''] = ISSUE_ENV.map(name => process.env[name] ?? '')
  const text = issue(label, commit, built)
  if (!ISSUE.test(text))
    fail(`the base root's identity is incomplete: MICA_BASE_LABEL='${label}' MICA_BASE_COMMIT='${commit}' MICA_BUILD_TIME='${built}'`)
  writeFileSync(join(root, 'etc/issue'), text)
  rmSync(join(root, 'etc/motd'), { force: true })
}

// The default hostname every root carries; mica-seed-state copies it to STATE on
// the first boot and the operator's value replaces it from then on.
export const HOSTNAME = 'mica'

// Accounts a package of this repository creates itself: mica-system's postinst
// pins the operator account at uid and gid 1000, whose home outlives every root.
export const OPERATOR_ACCOUNTS: { users: PinnedUser[], groups: PinnedGroup[] } = {
  users: [{ name: 'mica', uid: 1000, gid: 1000, gecos: 'mica operator', home: '/home/mica', shell: '/bin/sh' }],
  groups: [{ name: 'mica', gid: 1000 }],
}

// The last-change day of every /etc/shadow entry, in days since 1970: 2020-01-01,
// the day mica-system's postinst gives the operator account. pwconv and useradd
// write the build day, which differs between build days and runners.
export const SHADOW_LAST_CHANGE = '18262'

// The shadow files and their backups; a backup is checked where it exists.
export const SHADOW_FILES = ['etc/shadow', 'etc/shadow-']

// This repository's archives to install: every one in `directory`, the base
// packages among them, each once.
export async function localRows(directory: string, arch: string): Promise<{ row: Row, path: string }[]> {
  const found: { row: Row, path: string }[] = []
  for (const name of readdirSync(directory).filter(file => file.endsWith('.deb')).sort()) {
    const path = join(directory, name)
    const [pkg = '', version = '', architecture = ''] = output(['dpkg-deb', '-W', '--showformat=${Package}\t${Version}\t${Architecture}', path], `reading ${name}`).split('\t')
    if (architecture !== arch && architecture !== 'all')
      fail(`${name} is ${architecture}, not ${arch}`)
    found.push({ row: { name: pkg, version, architecture, sha256: await sha256File(path), url: `file://${path}`, consumers: [] }, path })
  }
  const missing = BASE_PACKAGES.filter(name => !found.some(entry => entry.row.name === name))
  if (missing.length)
    fail(`${directory} holds no ${missing.join(', ')}; build the pool first (bun src/container.ts debs)`)
  if (new Set(found.map(entry => entry.row.name)).size !== found.length)
    fail(`${directory} holds more than one archive of a package`)
  return found
}

// The target of a symbolic link, or undefined for anything else or nothing.
function linkTarget(path: string): string | undefined {
  return lstatExists(path) && lstatSync(path).isSymbolicLink() ? readlinkSync(path) : undefined
}

export function lstatExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  }
  catch {
    return false
  }
}

function walk(root: string, directory: string): string[] {
  const full = join(root, directory)
  if (!existsSync(full))
    return []
  return readdirSync(full, { recursive: true }).map(entry => join(directory, String(entry)))
}

// The packages dpkg records as installed in a root.
export function installedPackages(root: string): string[] {
  return readFileSync(join(root, 'var/lib/dpkg/status'), 'utf8').split('\n\n')
    .filter(stanza => /^Status: \S+ ok installed$/m.test(stanza))
    .map(stanza => /^Package: (\S+)$/m.exec(stanza)?.[1] ?? '')
}
// What every root of this repository keeps, whatever its init.
function assertCommon(root: string): void {
  // Keys are made on the device, on STATE; a key in a signed root is one the fleet shares.
  const keys = [...walk(root, 'etc'), ...walk(root, 'usr')].filter(path => /(?:^|\/)(?:dropbear_\w+_host_key|ssh_host_\w+_key)(?:\.pub)?$/.test(path))
  if (keys.length)
    fail(`the base root carries host keys: ${keys.join(', ')}`)
  for (const directory of ['etc/dropbear', 'mnt/data/state', 'run/mica']) {
    if (walk(root, directory).length)
      fail(`the base root carries content under /${directory}`)
  }
  // Its own identity in /etc/issue, named as the Base, and no message of the day.
  if (!ISSUE.test(readFileSync(join(root, 'etc/issue'), 'utf8')))
    fail('the base root\'s /etc/issue does not name the Base, its release, build time and commit')
  if (lstatExists(join(root, 'etc/motd')))
    fail('the base root carries /etc/motd')
  // No identity of the machine that built it.
  const resolver = join(root, 'etc/resolv.conf')
  if (lstatExists(resolver) && !lstatSync(resolver).isSymbolicLink())
    fail('the base root carries a /etc/resolv.conf of its own, the build host\'s; the init links it to the resolver it runs')
  if (readFileSync(join(root, 'etc/hostname'), 'utf8') !== `${HOSTNAME}\n`)
    fail(`the base root's /etc/hostname is not '${HOSTNAME}'`)
  if (existsSync(join(root, 'etc/machine-id')) && readFileSync(join(root, 'etc/machine-id'), 'utf8').trim())
    fail('the base root carries a machine-id; systemd generates it on the device')
  // Every account and group is locked: a root is identical on every device, so
  // any other field ('x', empty, a hash) is not a lock.
  for (const file of [...SHADOW_FILES, 'etc/gshadow', 'etc/gshadow-']) {
    if (file.endsWith('-') && !existsSync(join(root, file)))
      continue
    const lines = readFileSync(join(root, file), 'utf8').split('\n').filter(Boolean)
    const open = lines.filter(line => !/^[^:]*:[!*]/.test(line))
    if (open.length)
      fail(`the base root's /${file} has unlocked entries: ${open.map(line => `${line.split(':')[0]}:${line.split(':')[1]}`).join(', ')}`)
    // No day from the build clock: every entry changed last on the one pinned day.
    const dated = SHADOW_FILES.includes(file) ? lines.filter(line => line.split(':')[2] !== SHADOW_LAST_CHANGE) : []
    if (dated.length)
      fail(`the base root's /${file} has last-change days other than ${SHADOW_LAST_CHANGE}: ${dated.map(line => `${line.split(':')[0]}:${line.split(':')[2]}`).join(', ')}`)
  }
  // The system namespace is mounted at /mica.
  if (!existsSync(join(root, 'mica')))
    fail('the base root has no /mica mountpoint')
  // The options are not in the floor, and neither is the command set busybox replaces.
  const installed = installedPackages(root)
  for (const option of OPTIONS.filter(name => installed.includes(name)))
    fail(`the floor has the option ${option} installed`)
  for (const gnu of STRIPPED.filter(name => installed.includes(name)))
    fail(`the floor has ${gnu} installed; busybox is its command set`)
  if (lstatExists(join(root, 'usr/bin/bash')))
    fail('the floor carries /usr/bin/bash')
  const sh = join(root, 'usr/bin/sh')
  if (!lstatExists(sh) || !lstatSync(sh).isSymbolicLink() || !/(?:^|\/)busybox$/.test(readlinkSync(sh)))
    fail(`/usr/bin/sh is not busybox${lstatExists(sh) && lstatSync(sh).isSymbolicLink() ? `: it links to ${readlinkSync(sh)}` : ''}`)
  if (!existsSync(join(root, 'usr/bin/busybox')))
    fail('the base root has no /usr/bin/busybox')
  for (const command of HELPER_COMMANDS) {
    if (!['usr/bin', 'usr/sbin'].some(directory => lstatExists(join(root, directory, command))))
      fail(`the floor has no ${command} for the lifecycle helpers`)
  }
  // Nobody logs in with a shell the floor does not have.
  for (const line of readFileSync(join(root, 'etc/passwd'), 'utf8').split('\n')) {
    const [name = '', , , , , , shell = ''] = line.split(':')
    if ((name === 'root' || name === 'mica') && shell !== '/bin/sh')
      fail(`${name} logs in with ${shell}, not /bin/sh`)
  }
  // Nothing in the root converts character sets.
  const gconv = walk(root, 'usr/lib').filter(path => /(?:^|\/)gconv\/[^/]+$/.test(path))
  if (gconv.length)
    fail(`the floor carries gconv modules: /${gconv.slice(0, 3).join(', /')}`)
  for (const absent of ['usr/sbin/sshd', 'usr/bin/ssh', 'usr/lib/openssh', 'usr/bin/curl', 'usr/sbin/iptables']) {
    if (existsSync(join(root, absent)))
      fail(`the base root carries /${absent}`)
  }
}

// What every product inherits and none may have to repair: the floor, which
// carries no init -- a product installs mica-systemd or mica-openrc.
export function assertFloor(root: string): void {
  assertCommon(root)
  const installed = installedPackages(root)
  const inits = installed.filter(name => INIT_PACKAGES.includes(name))
  if (inits.length)
    fail(`the floor has an init installed: ${inits.join(', ')}; a product chooses mica-systemd or mica-openrc`)
  const orphans = ORPHANED.filter(name => installed.includes(name))
  if (orphans.length)
    fail(`the floor keeps ${orphans.join(', ')}, which only the GNU command set loads`)
  for (const init of ['usr/sbin/init', 'sbin/init']) {
    if (lstatExists(join(root, init)))
      fail(`the floor carries /${init}`)
  }
  console.log('rootfs: the floor -- no init, busybox the command set and not its GNU libraries, no option installed, no host keys or state, every account locked and on /bin/sh, no gconv, no OpenSSH, curl or iptables')
}

// A root composed from the floor with mica-systemd: the floor's promises, systemd
// as its init, and the units it governs.
export function assertSystemd(root: string): void {
  assertCommon(root)
  if (!/(?:^|\/)systemd$/.test(linkTarget(join(root, 'usr/sbin/init')) ?? ''))
    fail('/usr/sbin/init is not systemd')
  for (const tool of ['usr/lib/mica/mica-init', 'usr/bin/systemctl', 'usr/bin/systemd-repart']) {
    if (!lstatExists(join(root, tool)))
      fail(`the systemd root has no /${tool}`)
  }
  // The firewall is an option; if a product adds it, nothing enables it at boot.
  // Read from the tree, not from a systemctl run: a foreign-architecture root cannot
  // run its own systemctl here. A unit is enabled by a link -- under any *.wants/ or
  // *.requires/, or an alias -- that names it.
  for (const directory of ['etc/systemd/system', 'usr/lib/systemd/system']) {
    for (const path of walk(root, directory)) {
      const full = join(root, path)
      if (!lstatSync(full).isSymbolicLink())
        continue
      if (/(?:^|\/)nftables\.service$/.test(path) || /(?:^|\/)nftables\.service$/.test(readlinkSync(full)))
        fail(`the base root enables or aliases a governed unit: /${path} -> ${readlinkSync(full)}`)
    }
  }
  const preset = join(root, 'usr/lib/systemd/system-preset/50-mica-nftables.preset')
  if (!existsSync(preset) || readFileSync(preset, 'utf8') !== 'disable nftables.service\n')
    fail('the base root has no 50-mica-nftables.preset disabling nftables.service')
  // A getty starts only where the console option put login.
  for (const unit of ['getty@', 'serial-getty@']) {
    const dropIn = join(root, `etc/systemd/system/${unit}.service.d/10-mica-console.conf`)
    if (!existsSync(dropIn) || !/^ConditionPathExists=\/usr\/bin\/login$/m.test(readFileSync(dropIn, 'utf8')))
      fail(`${unit}.service in the floor does not wait for /usr/bin/login`)
  }
  console.log('rootfs: the systemd root -- systemd the init, nftables never enabled, no getty without login')
}

// mica-openrc's services, by runlevel, as its payload links them, and OpenRC's cgroups.
const OPENRC_RUNLEVELS: Record<string, string[]> = {
  sysinit: ['cgroups', 'mica-kernfs', 'mica-mdev'],
  boot: ['mica-data-layout', 'mica-klogd', 'mica-mounts', 'mica-syslogd', 'mica-watchdog'],
  default: ['mica-dbus', 'mica-health', 'mica-network', 'mica-ntpd', 'mica-provisioning-import', 'mica-shadow-reconcile'],
}

// A root composed from the floor with mica-openrc: the floor's promises, OpenRC
// as its init with mdev for devices, and nothing of systemd or udev left.
export function assertOpenrc(root: string): void {
  assertCommon(root)
  if (linkTarget(join(root, 'usr/sbin/init')) !== 'openrc-init')
    fail('/usr/sbin/init is not openrc-init')
  const installed = installedPackages(root)
  const systemd = ['systemd', 'systemd-sysv', 'udev', 'libsystemd-shared', 'mica-systemd'].filter(name => installed.includes(name))
  if (systemd.length)
    fail(`the OpenRC root has ${systemd.join(', ')} installed`)
  for (const tool of ['usr/lib/mica/mica-init', 'usr/lib/mica/mica-grow-data', 'usr/sbin/openrc-init', 'usr/sbin/sfdisk', 'etc/mdev.conf', 'usr/sbin/ifup', 'usr/sbin/ip', 'usr/sbin/udhcpc', 'usr/bin/logread', 'etc/mtab']) {
    if (!lstatExists(join(root, tool)))
      fail(`the OpenRC root has no /${tool}`)
  }
  for (const [runlevel, services] of Object.entries(OPENRC_RUNLEVELS)) {
    const linked = existsSync(join(root, 'etc/runlevels', runlevel)) ? readdirSync(join(root, 'etc/runlevels', runlevel)).sort() : []
    if (linked.join() !== services.join())
      fail(`the ${runlevel} runlevel holds ${linked.join(', ') || 'nothing'}, not ${services.join(', ')}`)
    for (const service of services) {
      if (!existsSync(join(root, 'etc/init.d', service)))
        fail(`the ${runlevel} runlevel names ${service}, which /etc/init.d does not ship`)
    }
  }
  if (linkTarget(join(root, 'etc/resolv.conf')) !== '../run/mica/resolv.conf')
    fail('/etc/resolv.conf does not link to /run/mica/resolv.conf')
  if (linkTarget(join(root, 'etc/network/interfaces')) !== '../../var/lib/mica/network/interfaces')
    fail('/etc/network/interfaces does not link to /var/lib/mica/network/interfaces, where micad writes it')
  if (!/^capabilities="!cap_sys_resource"$/m.test(readFileSync(join(root, 'etc/rc.conf.d/mica.conf'), 'utf8')))
    fail('the OpenRC root does not drop CAP_SYS_RESOURCE from its daemons')
  console.log('rootfs: the OpenRC root -- openrc-init the init, mdev for devices, no systemd or udev, every Mica service in its runlevel')
}
