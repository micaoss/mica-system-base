// The binds of DATA into the root and their options: mica-systemd's mount units and
// mica-openrc's mica-mounts make the same binds with the same options.
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { exec, fake, sandbox, SYSTEM_PATH, SYSTEMD_PAYLOAD } from './harness.ts'

const OPENRC_PAYLOAD = resolve(import.meta.dir, '../../debs/mica-openrc/payload')
const box = sandbox('mounts')
afterAll(box.done)

// Where each bind goes and the options it carries beyond bind. /mica, /srv and /var
// are private, so a mount beneath them stays out of DATA's tree.
const BINDS: [unit: string, where: string, options: string][] = [
  ['mica.mount', '/mica', 'bind,private,nosuid,nodev'],
  ['srv.mount', '/srv', 'bind,private,nosuid,nodev'],
  ['var.mount', '/var', 'bind,private,nosuid,nodev'],
  ['var-lib-mica.mount', '/var/lib/mica', 'bind,nosuid,nodev'],
  ['root.mount', '/root', 'bind,nosuid,nodev'],
  ['home.mount', '/home', 'bind,nosuid,nodev'],
]

describe('systemd', () => {
  for (const [unit, where, options] of BINDS) {
    test(`${unit} binds ${where} ${options}`, () => {
      const text = readFileSync(join(SYSTEMD_PAYLOAD, 'etc/systemd/system', unit), 'utf8')
      expect(text).toMatch(new RegExp(`^Where=${where}$`, 'm'))
      expect(text).toMatch(new RegExp(`^Options=${options}$`, 'm'))
    })
  }
})

describe('OpenRC', () => {
  test('mica-mounts makes the same binds with the same options', () => {
    const script = join(box.dir, 'mica-mounts')
    const text = readFileSync(join(OPENRC_PAYLOAD, 'etc/init.d/mica-mounts'), 'utf8')
    writeFileSync(script, text.replaceAll('/usr/lib/mica/mica-hosts', ':').replaceAll('/usr/lib/mica/mica-accounts', ':'))
    const calls = join(box.dir, 'calls')
    writeFileSync(calls, '')
    // mount(8) as the bind helper calls it: a bind, then a remount with the options.
    const stubs = [
      'mountinfo() { return 1; }',
      'mount() { echo "mount $*" >> "$CALLS"; }',
      'mkdir() { :; }',
      'seed() { :; }',
      'hostname() { :; }',
      'tmpfiles() { :; }',
      'ebegin() { :; }',
      'eend() { return ${1:-0}; }',
    ].join('; ')
    const ran = exec(['sh', '-c', `. ${script}; ${stubs}; start`], { PATH: SYSTEM_PATH, CALLS: calls })
    expect(ran).toEqual({ code: 0, out: '' })
    const lines = readFileSync(calls, 'utf8').split('\n')
    for (const [, where, options] of BINDS) {
      const extra = options.split(',').filter(option => option !== 'bind' && option !== 'private')
      expect([where, lines.filter(line => line.endsWith(` ${where}`) && line.includes('remount')).at(-1)])
        .toEqual([where, `mount -n -o remount,bind,${extra.join(',')} ${where}`])
      if (options.includes('private'))
        expect([where, lines.includes(`mount --make-private ${where}`)]).toEqual([where, true])
    }
  })
})

// Where a user may mount their own disks and swap (/usr/lib/mica/mica-mountpoint),
// for mica-unit, the systemd generator and OpenRC's mica-fstab alike.
const MOUNTPOINT = join(resolve(import.meta.dir, '../../payload'), 'usr/lib/mica/mica-mountpoint')
const mountpoint = (...args: string[]): { code: number, out: string } => exec(['sh', MOUNTPOINT, ...args], { PATH: SYSTEM_PATH })
const file = (name: string, text: string): string => {
  const path = join(box.dir, 'files', name)
  mkdirSync(join(box.dir, 'files'), { recursive: true })
  writeFileSync(path, text)
  return path
}

describe('mica-mountpoint', () => {
  test('allows /srv, /var/mnt/<name>, /home/<user> and the two engine roots, and nothing else', () => {
    const allowed = ['/srv', '/srv/data', '/srv/data/deep', '/var/mnt/disk', '/var/mnt/disk/a', '/home/mica', '/home/mica/media', '/mica/containers/storage', '/mica/containers/docker']
    const refused = ['/', '/usr', '/usr/local', '/etc/x', '/boot', '/proc', '/sys', '/dev', '/run/x', '/mnt', '/mnt/x', '/mnt/data', '/mnt/data/srv', '/mica', '/mica/config', '/mica/containers', '/mica/containers/storage/x', '/mica/containers/networks', '/var', '/var/mnt', '/var/lib/mica', '/var/lib/mica/x', '/var/log/x', '/var/lib/podman', '/root', '/tmp', '/var/tmp', '/home', 'srv/data']
    // Taken only as written: never rewritten into an allowed path.
    const unnormal = ['/srv/', '/srv//data', '/srv/./data', '/srv/../etc', '/srv/data/..', '/var/mnt/disk/.', '/srv/a b', '/srv/a\tb', '/srv/a\\b']
    for (const path of allowed)
      expect([path, mountpoint('where', path).code]).toEqual([path, 0])
    for (const path of [...refused, ...unnormal])
      expect([path, mountpoint('where', path).code]).toEqual([path, 1])
  })

  test('allows swap on a stable device name or a file in the user\'s trees', () => {
    const allowed = ['/dev/disk/by-uuid/1b2c-3d4e', '/dev/disk/by-label/swap', '/dev/disk/by-partuuid/0a-01', '/dev/disk/by-partlabel/swap', '/dev/disk/by-id/ata-DISK_1-part2', 'UUID=1b2c', 'LABEL=swap', 'PARTUUID=0a-01', 'PARTLABEL=swap', '/srv/swapfile', '/var/mnt/disk/swapfile', '/home/mica/swapfile']
    const refused = ['/dev/sda2', '/dev/mmcblk0p3', '/dev/nvme0n1p2', '/dev/disk/by-uuid', '/dev/disk/by-uuid/', '/dev/disk/by-uuid/a/b', '/dev/disk/by-path/pci-0', 'UUID=', 'UUID=a/b', '/srv', '/var/swapfile', '/mnt/data/swapfile', '/var/mnt', '/home', '/mica/containers/storage', '/srv/../swapfile', 'swapfile']
    for (const source of allowed)
      expect([source, mountpoint('swap', source).code]).toEqual([source, 0])
    for (const source of refused)
      expect([source, mountpoint('swap', source).code]).toEqual([source, 1])
  })

  test('escapes a path as systemd-escape --path does', () => {
    const cases: [string, string][] = [['/srv', 'srv'], ['/srv/my-data', 'srv-my\\x2ddata'], ['/var/mnt/disk', 'var-mnt-disk'], ['/mica/containers/storage', 'mica-containers-storage'], ['/srv/.hidden/x', 'srv-.hidden-x'], ['/home/a_b:c', 'home-a_b:c'], ['/dev/disk/by-uuid/1b2c-3d4e', 'dev-disk-by\\x2duuid-1b2c\\x2d3d4e'], ['/srv/a+b', 'srv-a\\x2bb']]
    for (const [path, name] of cases)
      expect(mountpoint('escape', path)).toEqual({ code: 0, out: `${name}\n` })
  })

  test('checks a unit\'s Where= or What=, and that its name is that path\'s', () => {
    const mount = (where: string): string => `[Unit]\nDescription=x\n[Mount]\nWhat=/dev/disk/by-label/data\nWhere=${where}\nType=ext4\n[Install]\nWantedBy=local-fs.target\n`
    expect(mountpoint('unit', file('srv.mount', mount('/srv')))).toEqual({ code: 0, out: '' })
    expect(mountpoint('unit', file('var-mnt-disk.mount', mount('/var/mnt/disk')))).toEqual({ code: 0, out: '' })
    expect(mountpoint('unit', file('var-mnt-disk.automount', '[Automount]\nWhere = /var/mnt/disk \n'))).toEqual({ code: 0, out: '' })
    expect(mountpoint('unit', file('dev-disk-by\\x2dlabel-swap.swap', '[Swap]\nWhat=/dev/disk/by-label/swap\n'))).toEqual({ code: 0, out: '' })
    expect(mountpoint('unit', file('srv-swapfile.swap', '[Swap]\nWhat=/srv/swapfile\n'))).toEqual({ code: 0, out: '' })
    expect(mountpoint('unit', file('mnt-x.mount', mount('/mnt/x')))).toEqual({ code: 1, out: 'refused mountpoint /mnt/x\n' })
    expect(mountpoint('unit', file('etc.mount', mount('/etc')))).toEqual({ code: 1, out: 'refused mountpoint /etc\n' })
    expect(mountpoint('unit', file('dev-sda2.swap', '[Swap]\nWhat=/dev/sda2\n'))).toEqual({ code: 1, out: 'refused mountpoint /dev/sda2\n' })
    expect(mountpoint('unit', file('data.mount', mount('/srv/data')))).toEqual({ code: 1, out: 'data.mount is not a unit name for /srv/data\n' })
    expect(mountpoint('unit', file('srv-x.mount', '[Unit]\nWhere=/srv/x\n'))).toEqual({ code: 1, out: 'srv-x.mount has no Where= in [Mount]\n' })
    // The last Where= of [Mount] counts, as systemd reads it.
    expect(mountpoint('unit', file('srv.mount', `${mount('/srv/x')}[Mount]\nWhere=/srv\n`))).toEqual({ code: 0, out: '' })
  })

  test('checks every line of an fstab, and refuses the file for any one', () => {
    const good = file('fstab.good', '# the user\'s disks\n\nUUID=1b2c /srv ext4 nosuid,nodev,noatime 0 2\nLABEL=media /var/mnt/media ext4 nofail\n/dev/disk/by-label/swap none swap sw 0 0\nUUID=3f /mica/containers/storage xfs defaults\ntmpfs /home/mica/scratch tmpfs\n')
    expect(mountpoint('fstab', good)).toEqual({ code: 0, out: '' })
    const bad = file('fstab.bad', 'UUID=1b2c /srv ext4 defaults\n/dev/sdb1 /mnt/usb ext4 defaults\n/dev/sda2 none swap sw\nonly-two fields\nUUID=1 /srv/x ext4 defaults 0 2 extra\n/dev/sdb2 /var/lib/mica ext4 defaults\n')
    expect(mountpoint('fstab', bad)).toEqual({ code: 1, out: 'line 2: refused mountpoint /mnt/usb\nline 3: refused mountpoint /dev/sda2\nline 4 is not an fstab line: only-two fields\nline 5 is not an fstab line: UUID=1 /srv/x ext4 defaults 0 2 extra\nline 6: refused mountpoint /var/lib/mica\n' })
  })
})

interface UnitCase { units: string, shipped: string, bin: string, calls: string, src: string }
function unitCase(name: string, tool: string): UnitCase {
  const dir = join(box.dir, name)
  rmSync(dir, { recursive: true, force: true })
  const c = { units: join(dir, 'units'), shipped: join(dir, 'shipped'), bin: join(dir, 'bin'), calls: join(dir, 'calls'), src: join(dir, 'src') }
  for (const path of [c.units, c.shipped, c.src])
    mkdirSync(path, { recursive: true })
  writeFileSync(c.calls, '')
  fake(c.bin, tool, `echo "${tool} $*" >> "$CALLS"`)
  return c
}

const SRV = '[Unit]\nDescription=/srv on my data disk\n[Mount]\nWhat=/dev/disk/by-uuid/1b2c\nWhere=/srv\nType=ext4\nOptions=nosuid,nodev,noatime\n[Install]\nWantedBy=local-fs.target\n'

describe('mica-unit for systemd', () => {
  const script = join(SYSTEMD_PAYLOAD, 'usr/lib/mica/mica-unit')
  const unit = (c: UnitCase, ...args: string[]): { code: number, out: string } =>
    exec(['sh', script, ...args], { PATH: `${c.bin}:${SYSTEM_PATH}`, CALLS: c.calls, MICA_UNIT_DIR: c.units, MICA_UNIT_SHIPPED: c.shipped, MICA_MOUNTPOINT: MOUNTPOINT })
  const source = (c: UnitCase, name: string, text: string): string => {
    writeFileSync(join(c.src, name), text)
    return join(c.src, name)
  }

  test('installs and enables a mount, an automount and a swap where a user may mount', () => {
    const c = unitCase('systemd-mounts', 'systemctl')
    // srv.mount is the root's default bind, which the user's replaces.
    writeFileSync(join(c.shipped, 'srv.mount'), '')
    expect(unit(c, 'install', source(c, 'srv.mount', SRV))).toEqual({ code: 0, out: '' })
    expect(unit(c, 'enable', 'srv.mount')).toEqual({ code: 0, out: '' })
    expect(readlinkSync(join(c.units, 'local-fs.target.wants/srv.mount'))).toBe('../srv.mount')
    expect(unit(c, 'install', source(c, 'var-mnt-media.automount', '[Automount]\nWhere=/var/mnt/media\n[Install]\nWantedBy=local-fs.target\n')).code).toBe(0)
    expect(unit(c, 'install', source(c, 'dev-disk-by\\x2dlabel-swap.swap', '[Swap]\nWhat=/dev/disk/by-label/swap\n[Install]\nWantedBy=swap.target\n')).code).toBe(0)
    expect(unit(c, 'enable', 'dev-disk-by\\x2dlabel-swap.swap')).toEqual({ code: 0, out: '' })
    expect(readlinkSync(join(c.units, 'swap.target.wants/dev-disk-by\\x2dlabel-swap.swap'))).toBe('../dev-disk-by\\x2dlabel-swap.swap')
    expect(unit(c, 'list').out).toBe('dev-disk-by\\x2dlabel-swap.swap\tenabled\nsrv.mount\tenabled\nvar-mnt-media.automount\tdisabled\n')
  })

  test('refuses a mountpoint outside the user\'s, and a name that is not its path\'s', () => {
    const c = unitCase('systemd-refused', 'systemctl')
    writeFileSync(join(c.shipped, 'home.mount'), '')
    expect(unit(c, 'install', source(c, 'mnt-usb.mount', SRV.replace('Where=/srv', 'Where=/mnt/usb')))).toEqual({ code: 1, out: 'mica-unit: refused mountpoint /mnt/usb\n' })
    expect(unit(c, 'install', source(c, 'dev-sda2.swap', '[Swap]\nWhat=/dev/sda2\n'))).toEqual({ code: 1, out: 'mica-unit: refused mountpoint /dev/sda2\n' })
    expect(unit(c, 'install', source(c, 'data.mount', SRV.replace('Where=/srv', 'Where=/srv/data')))).toEqual({ code: 1, out: 'mica-unit: data.mount is not a unit name for /srv/data\n' })
    // A shipped name other than srv.mount stays the root's.
    expect(unit(c, 'install', source(c, 'home.mount', SRV.replace('Where=/srv', 'Where=/home'))).out).toContain('home.mount is shipped by the root')
    expect(readdirSync(c.units)).toEqual([])
    // A unit put on DATA by hand is checked when it is enabled.
    writeFileSync(join(c.units, 'mnt-usb.mount'), SRV.replace('Where=/srv', 'Where=/mnt/usb'))
    expect(unit(c, 'enable', 'mnt-usb.mount')).toEqual({ code: 1, out: 'mica-unit: refused mountpoint /mnt/usb\n' })
    expect(existsSync(join(c.units, 'local-fs.target.wants'))).toBe(false)
    expect(readFileSync(c.calls, 'utf8')).toBe('')
  })
})

describe('mica-user-mounts-generator', () => {
  const generator = join(SYSTEMD_PAYLOAD, 'usr/lib/systemd/system-generators/mica-user-mounts-generator')

  test('copies the allowed units with their links, srv.mount early, and masks and logs the rest', () => {
    const dir = join(box.dir, 'generator')
    rmSync(dir, { recursive: true, force: true })
    const [units, normal, early, late, kmsg] = ['units', 'normal', 'early', 'late', 'kmsg'].map(leaf => join(dir, leaf)) as [string, string, string, string, string]
    for (const path of [units, normal, early, late])
      mkdirSync(path, { recursive: true })
    const media = SRV.replace('Where=/srv', 'Where=/var/mnt/media')
    writeFileSync(join(units, 'srv.mount'), SRV)
    writeFileSync(join(units, 'var-mnt-media.mount'), media)
    writeFileSync(join(units, 'mnt-usb.mount'), SRV.replace('Where=/srv', 'Where=/mnt/usb'))
    writeFileSync(join(units, 'tailscaled.service'), '[Service]\nExecStart=/srv/tailscaled\n')
    mkdirSync(join(units, 'local-fs.target.wants'))
    mkdirSync(join(units, 'multi-user.target.wants'))
    for (const name of ['srv.mount', 'var-mnt-media.mount', 'mnt-usb.mount'])
      symlinkSync(`../${name}`, join(units, 'local-fs.target.wants', name))
    symlinkSync('../tailscaled.service', join(units, 'multi-user.target.wants/tailscaled.service'))

    const ran = exec(['sh', generator, normal, early, late], { PATH: SYSTEM_PATH, MICA_USER_UNITS: units, MICA_MOUNTPOINT: MOUNTPOINT, MICA_KMSG: kmsg })
    expect(ran).toEqual({ code: 0, out: '' })
    expect(readFileSync(join(early, 'srv.mount'), 'utf8')).toBe(SRV)
    expect(readlinkSync(join(early, 'local-fs.target.wants/srv.mount'))).toBe(join(early, 'srv.mount'))
    expect(readFileSync(join(normal, 'var-mnt-media.mount'), 'utf8')).toBe(media)
    expect(readlinkSync(join(normal, 'local-fs.target.wants/var-mnt-media.mount'))).toBe(join(normal, 'var-mnt-media.mount'))
    expect(readlinkSync(join(normal, 'mnt-usb.mount'))).toBe('/dev/null')
    expect(readdirSync(normal).sort()).toEqual(['local-fs.target.wants', 'mnt-usb.mount', 'var-mnt-media.mount'])
    expect(readdirSync(join(normal, 'local-fs.target.wants'))).toEqual(['var-mnt-media.mount'])
    expect(readdirSync(late)).toEqual([])
    expect(readFileSync(kmsg, 'utf8')).toBe('<4>mica-user-mounts-generator: refused mountpoint /mnt/usb\n')
  })

  test('does nothing without the directory on DATA', () => {
    const dir = join(box.dir, 'generator-none')
    mkdirSync(join(dir, 'normal'), { recursive: true })
    const ran = exec(['sh', generator, join(dir, 'normal'), join(dir, 'early'), join(dir, 'late')], { PATH: SYSTEM_PATH, MICA_USER_UNITS: join(dir, 'absent'), MICA_MOUNTPOINT: MOUNTPOINT })
    expect(ran).toEqual({ code: 0, out: '' })
    expect(readdirSync(join(dir, 'normal'))).toEqual([])
  })
})

describe('mica-unit fstab check', () => {
  const script = join(OPENRC_PAYLOAD, 'usr/lib/mica/mica-unit')

  test('checks /usr/local/etc/fstab, or the file given, with the same rule', () => {
    const c = unitCase('openrc-fstab', 'rc-service')
    const env = { PATH: `${c.bin}:${SYSTEM_PATH}`, CALLS: c.calls, MICA_UNIT_DIR: c.units, MICA_UNIT_SHIPPED: c.shipped, MICA_MOUNTPOINT: MOUNTPOINT }
    writeFileSync(join(c.units, 'fstab'), 'UUID=1b2c /srv ext4 nosuid,nodev 0 2\n')
    expect(exec(['sh', script, 'fstab', 'check'], env)).toEqual({ code: 0, out: '' })
    const other = join(c.src, 'fstab')
    writeFileSync(other, 'UUID=1b2c /srv ext4 defaults\n/dev/sdb1 /mnt/usb ext4 defaults\n/dev/sda2 none swap sw\n')
    expect(exec(['sh', script, 'fstab', 'check', other], env)).toEqual({ code: 1, out: 'mica-unit: line 2: refused mountpoint /mnt/usb\nmica-unit: line 3: refused mountpoint /dev/sda2\n' })
    expect(exec(['sh', script, 'fstab'], env).code).toBe(2)
  })
})

describe('mica-fstab', () => {
  const service = join(OPENRC_PAYLOAD, 'etc/init.d/mica-fstab')

  // openrc-run's functions and the mount tools, logged; a mount of <source> named
  // "fail" fails.
  const run = (dir: string, fstab: string, action: 'start' | 'stop', mounted: string[] = []): { code: number, out: string, calls: string[] } => {
    const calls = join(dir, 'calls')
    writeFileSync(calls, '')
    writeFileSync(join(dir, 'fstab'), fstab)
    const stubs = [
      'ebegin() { echo "ebegin $*" >> "$CALLS"; }',
      'eend() { [ "${1:-0}" = 0 ] || echo "eend $*" >> "$CALLS"; return ${1:-0}; }',
      'ewarn() { echo "ewarn $*" >> "$CALLS"; }',
      `mountinfo() { case " ${mounted.join(' ')} " in *" $2 "*) return 0 ;; esac; return 1; }`,
      'mkdir() { echo "mkdir $*" >> "$CALLS"; }',
      'mount() { echo "mount $*" >> "$CALLS"; case "$5" in fail*) return 32 ;; esac; }',
      'umount() { echo "umount $*" >> "$CALLS"; }',
      'swapon() { echo "swapon $*" >> "$CALLS"; }',
      'swapoff() { echo "swapoff $*" >> "$CALLS"; }',
    ].join('; ')
    const ran = exec(['sh', '-c', `. ${service}; ${stubs}; ${action}`], { PATH: SYSTEM_PATH, CALLS: calls, MICA_FSTAB: join(dir, 'fstab'), MICA_FSTAB_LINES: join(dir, 'lines'), MICA_MOUNTPOINT: MOUNTPOINT })
    return { ...ran, calls: readFileSync(calls, 'utf8').split('\n').filter(Boolean) }
  }

  test('mounts in file order, skips noauto, and unmounts in reverse at stop', () => {
    const dir = join(box.dir, 'fstab-order')
    mkdirSync(dir, { recursive: true })
    const fstab = '# disks\nUUID=1b2c /srv ext4 nosuid,nodev 0 2\nLABEL=media /var/mnt/media ext4 noauto\nUUID=3f /srv/backup xfs\n/dev/disk/by-label/swap none swap sw\n'
    const started = run(dir, fstab, 'start')
    expect(started.code).toBe(0)
    expect(started.calls.filter(line => !line.startsWith('ebegin'))).toEqual([
      'mkdir -p /srv', 'mount -t ext4 -o nosuid,nodev UUID=1b2c /srv',
      'mkdir -p /srv/backup', 'mount -t xfs -o defaults UUID=3f /srv/backup',
      'swapon /dev/disk/by-label/swap',
    ])
    const stopped = run(dir, fstab, 'stop', ['/srv', '/srv/backup'])
    expect(stopped.code).toBe(0)
    expect(stopped.calls.filter(line => !line.startsWith('ebegin'))).toEqual(['swapoff /dev/disk/by-label/swap', 'umount -n /srv/backup', 'umount -n /srv'])
    expect(existsSync(join(dir, 'lines'))).toBe(false)
  })

  test('a failed line fails the start unless it says nofail; the others are still mounted', () => {
    const dir = join(box.dir, 'fstab-fail')
    mkdirSync(dir, { recursive: true })
    const nofail = run(dir, 'fail-a /var/mnt/a ext4 nofail\nUUID=b /var/mnt/b ext4\n', 'start')
    expect(nofail.code).toBe(0)
    expect(nofail.calls).toContain('ewarn fail-a: not mounted, and nofail')
    expect(nofail.calls).toContain('mount -t ext4 -o defaults UUID=b /var/mnt/b')
    const fatal = run(dir, 'fail-a /var/mnt/a ext4 defaults\nUUID=b /var/mnt/b ext4\n', 'start')
    expect(fatal.code).toBe(1)
    expect(fatal.calls).toContain('mount -t ext4 -o defaults UUID=b /var/mnt/b')
  })

  test('one refused line refuses the whole file: nothing is mounted', () => {
    const dir = join(box.dir, 'fstab-refused')
    mkdirSync(dir, { recursive: true })
    const refused = run(dir, 'UUID=a /srv ext4\n/dev/sdb1 /mnt/usb ext4\n', 'start')
    expect(refused.code).toBe(1)
    expect(refused.calls.filter(line => line.startsWith('mount') || line.startsWith('mkdir'))).toEqual([])
    expect(refused.calls).toContain('eend 1 line 2: refused mountpoint /mnt/usb')
  })

  test('runs after mica-mounts and before the user\'s services, in the boot runlevel', () => {
    const text = readFileSync(service, 'utf8')
    expect(/depend\(\) \{([^}]*)\}/.exec(text)?.[1]).toBe('\n    need mica-mounts\n    before mica-local mica-units\n')
    expect(readlinkSync(join(OPENRC_PAYLOAD, 'etc/runlevels/boot/mica-fstab'))).toBe('/etc/init.d/mica-fstab')
  })

  test('mica-mounts leaves /srv to it when the fstab on DATA has a line for /srv', () => {
    const dir = join(box.dir, 'fstab-srv')
    mkdirSync(dir, { recursive: true })
    const text = readFileSync(join(OPENRC_PAYLOAD, 'etc/init.d/mica-mounts'), 'utf8').replaceAll('/mnt/data/state/openrc-local/fstab', join(dir, 'fstab'))
    const script = join(dir, 'mica-mounts')
    writeFileSync(script, text.replaceAll('/usr/lib/mica/mica-hosts', ':').replaceAll('/usr/lib/mica/mica-accounts', ':'))
    const binds = (fstab: string): string[] => {
      writeFileSync(join(dir, 'fstab'), fstab)
      const calls = join(dir, 'calls')
      writeFileSync(calls, '')
      const stubs = 'bind() { echo "$2" >> "$CALLS"; }; mount() { :; }; mkdir() { :; }; seed() { :; }; hostname() { :; }; tmpfiles() { :; }; ebegin() { :; }; einfo() { :; }; eend() { return ${1:-0}; }'
      expect(exec(['sh', '-c', `. ${script}; ${stubs}; start`], { PATH: SYSTEM_PATH, CALLS: calls }).code).toBe(0)
      return readFileSync(calls, 'utf8').split('\n').filter(Boolean)
    }
    expect(binds('UUID=1b2c /srv ext4 defaults\n')).not.toContain('/srv')
    expect(binds('# UUID=1b2c /srv ext4 defaults\nUUID=3f /srv/x ext4\n')).toContain('/srv')
  })
})

describe('mica-require-mount', () => {
  const helper = join(OPENRC_PAYLOAD, 'usr/lib/mica/mica-require-mount')

  test('refuses an engine root the fstab names but nothing mounted, nofail or not', () => {
    const dir = join(box.dir, 'require')
    mkdirSync(dir, { recursive: true })
    const fstab = join(dir, 'fstab')
    const mountinfo = join(dir, 'mountinfo')
    const env = { PATH: SYSTEM_PATH, MICA_FSTAB: fstab, MICA_MOUNTINFO: mountinfo }
    writeFileSync(mountinfo, '30 25 0:27 / /mica/containers rw,nosuid,nodev - ext4 /dev/vdb rw\n')
    // No fstab, or one without the path: nothing to wait for.
    expect(exec(['sh', helper, '/mica/containers/storage'], env)).toEqual({ code: 0, out: '' })
    writeFileSync(fstab, 'UUID=1b2c /srv ext4 defaults\n')
    expect(exec(['sh', helper, '/mica/containers/storage'], env)).toEqual({ code: 0, out: '' })
    writeFileSync(fstab, 'UUID=1b2c /srv ext4 defaults\nUUID=3f /mica/containers/storage xfs nofail\n')
    expect(exec(['sh', helper, '/mica/containers/storage'], env)).toEqual({ code: 1, out: `mica-require-mount: /mica/containers/storage is not mounted; ${fstab} line 2: UUID=3f /mica/containers/storage xfs nofail\n` })
    writeFileSync(mountinfo, '30 25 0:27 / /mica/containers rw - ext4 /dev/vdb rw\n41 30 8:17 / /mica/containers/storage rw - xfs /dev/sdb1 rw\n')
    expect(exec(['sh', helper, '/mica/containers/storage'], env)).toEqual({ code: 0, out: '' })
    expect(exec(['sh', helper], env).code).toBe(2)
  })
})
