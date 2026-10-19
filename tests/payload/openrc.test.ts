// mica-openrc's helpers: mica-init against a fake OpenRC state directory and fake
// rc-service, rc-status and openrc-shutdown; mica-udhcpc against a fake ip; mica-ntpd's
// servers.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { exec, fake, sandbox, SYSTEM_PATH } from './harness.ts'

const OPENRC = resolve(import.meta.dir, '../../debs/mica-openrc/payload/usr/lib/mica')
const box = sandbox('openrc')
afterAll(box.done)

describe('mica-init for OpenRC', () => {
  const bin = join(box.dir, 'init-bin')
  const svcdir = join(box.dir, 'openrc')
  const calls = join(box.dir, 'init-calls')
  fake(bin, 'rc-service', 'echo "rc-service $*" >> "$CALLS"\n[ "$2" = "$ACTIVE" ]')
  fake(bin, 'rc-status', 'echo "rc-status $*" >> "$CALLS"\nprintf "%s" "${CRASHED:-}"')
  fake(bin, 'openrc-shutdown', 'echo "openrc-shutdown $*" >> "$CALLS"')
  const init = (args: string[], env: Record<string, string> = {}): { code: number, out: string } =>
    exec(['sh', join(OPENRC, 'mica-init'), ...args], { PATH: `${bin}:${SYSTEM_PATH}`, MICA_RC_SVCDIR: svcdir, CALLS: calls, ACTIVE: 'mica-data-layout', ...env })
  // The services in each of OpenRC's state directories.
  const states = (listing: Record<string, string[]>, softlevel = 'default'): void => {
    rmSync(svcdir, { recursive: true, force: true })
    for (const directory of ['started', 'starting', 'stopping', 'failed']) {
      mkdirSync(join(svcdir, directory), { recursive: true })
      for (const service of listing[directory] ?? [])
        writeFileSync(join(svcdir, directory, service), '')
    }
    writeFileSync(join(svcdir, 'softlevel'), softlevel)
  }

  test('reboots and powers off through openrc-shutdown, and asks rc-service what is active', () => {
    writeFileSync(calls, '')
    init(['reboot'])
    init(['poweroff'])
    expect(init(['is-active', 'mica-data-layout']).code).toBe(0)
    expect(init(['is-active', 'micad']).code).not.toBe(0)
    expect(readFileSync(calls, 'utf8').split('\n')).toEqual(expect.arrayContaining([
      'openrc-shutdown --reboot now',
      'openrc-shutdown --poweroff now',
      'rc-service --quiet mica-data-layout status',
    ]))
  })

  test('the boot is starting while a service starts, degraded with a failed or crashed one, running otherwise', () => {
    states({ started: ['mica-mounts'], starting: ['mica-health', 'micad'] })
    expect(init(['state']).out.trim()).toBe('starting')
    expect(init(['jobs']).out.trim().split('\n')).toEqual(['mica-health', 'micad'])
    states({ started: ['mica-mounts'], failed: ['mica-ntpd'] })
    expect(init(['state']).out.trim()).toBe('degraded')
    expect(init(['failed']).out.trim()).toBe('mica-ntpd')
    states({ started: ['mica-mounts'] })
    expect(init(['state'], { CRASHED: 'micad\n' }).out.trim()).toBe('degraded')
    expect(init(['failed'], { CRASHED: 'micad\n' }).out.trim()).toBe('micad')
    expect(init(['state']).out.trim()).toBe('running')
    expect(init(['jobs']).out.trim()).toBe('')
    states({ stopping: ['micad'] }, 'reboot')
    expect(init(['state']).out.trim()).toBe('stopping')
  })

  test('an unknown request is a usage error', () => {
    expect(init(['restart']).code).toBe(2)
  })
})

describe('mica-udhcpc', () => {
  const bin = join(box.dir, 'udhcpc-bin')
  const calls = join(box.dir, 'ip-calls')
  const run = join(box.dir, 'run')
  // mica-udhcpc calls busybox's ip applet.
  fake(bin, 'busybox', 'echo "$*" >> "$CALLS"')
  // The script writes under /run/mica; the sandbox's run directory stands in for it.
  const script = join(box.dir, 'mica-udhcpc')
  writeFileSync(script, readFileSync(join(OPENRC, 'mica-udhcpc'), 'utf8').replaceAll('/run/mica', run))
  const event = (name: string, lease: Record<string, string>): number =>
    exec(['sh', script, name], { PATH: `${bin}:${SYSTEM_PATH}`, CALLS: calls, ...lease }).code

  test('a lease configures the interface and each interface\'s servers make up resolv.conf', () => {
    writeFileSync(calls, '')
    expect(event('bound', { interface: 'eth0', ip: '10.0.0.5', mask: '24', router: '10.0.0.1 10.0.0.2', dns: '10.0.0.53', domain: 'lab' })).toBe(0)
    expect(event('bound', { interface: 'eth1', ip: '10.1.0.5', dns: '10.1.0.53 10.1.0.54' })).toBe(0)
    expect(readFileSync(join(run, 'resolv.conf'), 'utf8')).toBe('search lab\nnameserver 10.0.0.53\nnameserver 10.1.0.53\nnameserver 10.1.0.54\n')
    expect(readFileSync(calls, 'utf8').split('\n')).toEqual(expect.arrayContaining([
      'ip -4 addr add 10.0.0.5/24 dev eth0',
      'ip -4 route replace default via 10.0.0.1 dev eth0',
    ]))
    // One router is the default route; the second is not.
    expect(readFileSync(calls, 'utf8')).not.toContain('via 10.0.0.2')
    // Losing a lease takes that interface's servers away.
    expect(event('deconfig', { interface: 'eth0' })).toBe(0)
    expect(readFileSync(join(run, 'resolv.conf'), 'utf8')).toBe('nameserver 10.1.0.53\nnameserver 10.1.0.54\n')
  })
})

describe('mica-ntpd', () => {
  const run = join(box.dir, 'ntpd-run')
  // The service reads /run/mica/ntpd.conf; the sandbox's directory stands in for it.
  const script = join(box.dir, 'mica-ntpd')
  writeFileSync(script, readFileSync(resolve(OPENRC, '../../../etc/init.d/mica-ntpd'), 'utf8').replaceAll('/run/mica', run))
  const args = (): string => exec(['sh', '-c', `. ${script}; start_pre; echo "$command_args"`], { PATH: SYSTEM_PATH }).out.trim()

  test('runs on the servers micad renders, or on Debian\'s pool when it has rendered none', () => {
    rmSync(run, { recursive: true, force: true })
    expect(args()).toBe('ntpd -n -p 0.debian.pool.ntp.org -p 1.debian.pool.ntp.org -p 2.debian.pool.ntp.org -p 3.debian.pool.ntp.org')
    mkdirSync(run, { recursive: true })
    writeFileSync(join(run, 'ntpd.conf'), 'ntp_servers="time.example ntp.example"\n')
    expect(args()).toBe('ntpd -n -p time.example -p ntp.example')
  })
})

// Runlevel membership is payload: the postinst removes the links no package owns --
// what openrc's and update-rc.d's scripts imported -- and keeps every owned one,
// whichever package owns it.
describe('mica-openrc postinst', () => {
  const runlevels = join(box.dir, 'runlevels')
  const bin = join(box.dir, 'postinst-bin')
  const script = join(box.dir, 'postinst')
  writeFileSync(script, readFileSync(resolve(OPENRC, '../../../../postinst'), 'utf8').replaceAll('/etc/runlevels', runlevels))
  // dpkg-query -S: owned when the path is listed in $OWNED.
  fake(bin, 'dpkg-query', '[ "$1" = -S ] && grep -qxF "$2" "$OWNED"')

  test('removes unowned links and keeps owned ones and cgroups', () => {
    const owned = join(box.dir, 'owned')
    const links: Record<string, string[]> = { sysinit: ['mica-kernfs', 'cgroups'], boot: ['mica-dbus', 'dbus'], default: ['micad', 'bluetooth', 'mica-stale'] }
    for (const [runlevel, names] of Object.entries(links)) {
      mkdirSync(join(runlevels, runlevel), { recursive: true })
      for (const name of names)
        writeFileSync(join(runlevels, runlevel, name), '')
    }
    writeFileSync(owned, ['sysinit/mica-kernfs', 'boot/mica-dbus', 'default/micad'].map(link => join(runlevels, link)).join('\n') + '\n')
    expect(exec(['sh', script, 'configure'], { PATH: `${bin}:${SYSTEM_PATH}`, OWNED: owned }).code).toBe(0)
    const left = (runlevel: string): string[] => readdirSync(join(runlevels, runlevel)).sort()
    expect(left('sysinit')).toEqual(['cgroups', 'mica-kernfs'])
    expect(left('boot')).toEqual(['mica-dbus'])
    expect(left('default')).toEqual(['micad'])
  })
})

// mica-kernfs and mica-data-layout's start, sourced with OpenRC's helpers and the
// commands they run stubbed: what they mount and check.
describe('the boot services of mica-openrc', () => {
  const INIT_D = resolve(OPENRC, '../../../etc/init.d')
  const calls = join(box.dir, 'boot-calls')
  const start = (service: string, stubs: string, text = readFileSync(join(INIT_D, service), 'utf8')): string => {
    const script = join(box.dir, service)
    writeFileSync(script, text)
    writeFileSync(calls, '')
    const code = exec(['sh', '-c', `. ${script}; ebegin() { :; }; eend() { return \${1:-0}; }; einfo() { :; }; ${stubs}; start`], { PATH: SYSTEM_PATH, CALLS: calls }).code
    expect(code).toBe(0)
    return readFileSync(calls, 'utf8')
  }

  test('mica-kernfs mounts securityfs only where the kernel has it', () => {
    const filesystems = join(box.dir, 'filesystems')
    const text = readFileSync(join(INIT_D, 'mica-kernfs'), 'utf8').replaceAll('/proc/filesystems', filesystems)
    const stubs = 'mount_if() { echo "$1" >> "$CALLS"; }; hostname() { :; }'
    writeFileSync(filesystems, 'nodev\tsysfs\nnodev\tdevtmpfs\nnodev\tmqueue\n')
    expect(start('mica-kernfs', stubs, text)).not.toContain('securityfs')
    writeFileSync(filesystems, 'nodev\tsysfs\nnodev\tsecurityfs\n')
    expect(start('mica-kernfs', stubs, text)).toContain('securityfs')
  })

  // mica-core's runkit has mounted DATA before the init runs: the check skips it.
  test('mica-data-layout checks only the file systems not yet mounted', () => {
    const text = readFileSync(join(INIT_D, 'mica-data-layout'), 'utf8').replaceAll('/usr/lib/mica/mica-data-layout', 'true')
    expect(start('mica-data-layout', 'fsck() { echo "fsck $*" >> "$CALLS"; }; mount() { :; }', text)).toContain('fsck -A -M -T -R -a')
  })
})
