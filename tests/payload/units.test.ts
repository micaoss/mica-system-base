// The services micad turned on, started at boot from DATA with or without micad:
// mica-units against a fake mica-init and a fixture list, each init's mica-init
// start, and the boot units that run it.
import { readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { exec, fake, MICA, sandbox, SYSTEM_PATH, SYSTEMD_INIT, SYSTEMD_PAYLOAD } from './harness.ts'

const OPENRC_PAYLOAD = resolve(import.meta.dir, '../../debs/mica-openrc/payload')
const box = sandbox('units')
afterAll(box.done)

describe('mica-units', () => {
  const bin = join(box.dir, 'bin')
  const calls = join(box.dir, 'calls')
  const list = join(box.dir, 'enabled')
  fake(bin, 'mica-init', 'echo "$*" >> "$CALLS"\n[ "$2" != broken ]')
  const run = () => exec(['sh', join(MICA, 'mica-units')], { PATH: SYSTEM_PATH, CALLS: calls, MICA_UNITS_ENABLED: list, MICA_INIT: join(bin, 'mica-init') })

  test('starts each listed service, and skips a line that names none', () => {
    writeFileSync(calls, '')
    writeFileSync(list, 'mica-mqtt-broker.service\nwpa_supplicant@wlan0.service\n\n-x.service\nfoo.timer\na b.service\n$(reboot).service\n')
    const ran = run()
    expect(ran.code, ran.out).toBe(0)
    expect(readFileSync(calls, 'utf8')).toBe('start mica-mqtt-broker\nstart wpa_supplicant@wlan0\n')
  })

  test('one service that does not start keeps no other from starting', () => {
    writeFileSync(calls, '')
    writeFileSync(list, 'broken.service\nmica-mqttd.service\n')
    const ran = run()
    expect(ran.code).toBe(1)
    expect(readFileSync(calls, 'utf8')).toBe('start broken\nstart mica-mqttd\n')
    expect(ran.out).toContain('broken did not start')
  })

  test('without a list it starts nothing', () => {
    writeFileSync(calls, '')
    expect(exec(['sh', join(MICA, 'mica-units')], { PATH: SYSTEM_PATH, CALLS: calls, MICA_UNITS_ENABLED: join(box.dir, 'absent'), MICA_INIT: join(bin, 'mica-init') }).code).toBe(0)
    expect(readFileSync(calls, 'utf8')).toBe('')
  })
})

describe('mica-units enable, disable and list', () => {
  const bin = join(box.dir, 'cli-bin')
  const calls = join(box.dir, 'cli-calls')
  const list = join(box.dir, 'cli/units/enabled')
  fake(bin, 'mica-init', 'echo "$*" >> "$CALLS"')
  const units = (...args: string[]) => exec(['sh', join(MICA, 'mica-units'), ...args], { PATH: SYSTEM_PATH, CALLS: calls, MICA_UNITS_ENABLED: list, MICA_INIT: join(bin, 'mica-init') })

  test('enable lists a service once and starts it; disable takes it off and stops it', () => {
    writeFileSync(calls, '')
    expect(units('enable', 'mica-containerd').code).toBe(0)
    expect(units('enable', 'mica-containerd.service').code).toBe(0)
    expect(units('enable', 'wpa_supplicant@wlan0').code).toBe(0)
    expect(readFileSync(list, 'utf8')).toBe('mica-containerd.service\nwpa_supplicant@wlan0.service\n')
    expect(units('list').out).toBe('mica-containerd.service\nwpa_supplicant@wlan0.service\n')
    expect(units('disable', 'mica-containerd').code).toBe(0)
    expect(readFileSync(list, 'utf8')).toBe('wpa_supplicant@wlan0.service\n')
    expect(readFileSync(calls, 'utf8')).toBe('start mica-containerd\nstart mica-containerd\nstart wpa_supplicant@wlan0\nstop mica-containerd\n')
  })

  test('refuses what names no service, and changes nothing', () => {
    writeFileSync(calls, '')
    for (const name of ['', '-x', 'a b', '$(reboot)', 'x/y']) {
      const ran = units('enable', name)
      expect(ran.code).toBe(2)
    }
    expect(readFileSync(list, 'utf8')).toBe('wpa_supplicant@wlan0.service\n')
    expect(readFileSync(calls, 'utf8')).toBe('')
    expect(units('frob').code).toBe(2)
  })
})

describe('mica-init start', () => {
  test('systemd queues the unit\'s start', () => {
    const fakes = join(box.dir, 'systemctl-bin')
    const calls = join(box.dir, 'systemctl-calls')
    fake(fakes, 'systemctl', 'echo "$*" > "$CALLS"')
    expect(exec(['sh', SYSTEMD_INIT, 'start', 'wpa_supplicant@wlan0'], { PATH: `${fakes}:${SYSTEM_PATH}`, CALLS: calls }).code).toBe(0)
    expect(readFileSync(calls, 'utf8')).toBe('--no-block start wpa_supplicant@wlan0.service\n')
    expect(exec(['sh', SYSTEMD_INIT, 'stop', 'mica-containerd'], { PATH: `${fakes}:${SYSTEM_PATH}`, CALLS: calls }).code).toBe(0)
    expect(readFileSync(calls, 'utf8')).toBe('stop mica-containerd.service\n')
  })

  test('OpenRC starts the service, a template instance as the multiplexed one', () => {
    const fakes = join(box.dir, 'rc-bin')
    const calls = join(box.dir, 'rc-calls')
    fake(fakes, 'rc-service', 'echo "$*" > "$CALLS"')
    const init = join(OPENRC_PAYLOAD, 'usr/lib/mica/mica-init')
    expect(exec(['sh', init, 'start', 'a@wlan0'], { PATH: `${fakes}:${SYSTEM_PATH}`, CALLS: calls }).code).toBe(0)
    expect(readFileSync(calls, 'utf8')).toBe('a.wlan0 start\n')
    expect(exec(['sh', init, 'stop', 'a@wlan0'], { PATH: `${fakes}:${SYSTEM_PATH}`, CALLS: calls }).code).toBe(0)
    expect(readFileSync(calls, 'utf8')).toBe('a.wlan0 stop\n')
  })
})

describe('the boot units', () => {
  test('systemd runs mica-units once /var/lib/mica is mounted, enabled in the image', () => {
    const system = join(SYSTEMD_PAYLOAD, 'etc/systemd/system')
    const unit = readFileSync(join(system, 'mica-units.service'), 'utf8')
    expect(unit).toMatch(/^ExecStart=\/usr\/lib\/mica\/mica-units$/m)
    expect(unit).toMatch(/^After=.*\bvar-lib-mica\.mount\b/m)
    expect(readlinkSync(join(system, 'multi-user.target.wants/mica-units.service'))).toBe('/etc/systemd/system/mica-units.service')
  })

  test('OpenRC runs it from the default runlevel, after the mounts', () => {
    const script = readFileSync(join(OPENRC_PAYLOAD, 'etc/init.d/mica-units'), 'utf8')
    expect(script).toContain('need mica-mounts')
    expect(script).toContain('/usr/lib/mica/mica-units')
    expect(readlinkSync(join(OPENRC_PAYLOAD, 'etc/runlevels/default/mica-units'))).toBe('/etc/init.d/mica-units')
  })
})

// OpenRC has no timers: mica-update runs mica-update-daily under supervise-daemon.
describe('the daily update under OpenRC', () => {
  test('mica-update-daily runs update --auto after a delay and then daily, and survives a failure', () => {
    const bin = join(box.dir, 'update-bin')
    const calls = join(box.dir, 'update-calls')
    writeFileSync(calls, '')
    fake(bin, 'sleep', 'echo "sleep $1" >> "$CALLS"\n[ "$(grep -c sleep "$CALLS")" -lt 3 ] || exit 9')
    fake(bin, 'deploy', 'echo "deploy $*" >> "$CALLS"\nexit 1')
    const script = 'sleep() { command sleep "$@" || exit 0; }; . ' + join(OPENRC_PAYLOAD, 'usr/lib/mica/mica-update-daily')
    const ran = exec(['sh', '-c', script], { PATH: `${bin}:${SYSTEM_PATH}`, CALLS: calls, MICA_DEPLOY: join(bin, 'deploy') })
    expect(ran.out).toContain('update --auto failed')
    const lines = readFileSync(calls, 'utf8').trim().split('\n')
    expect(lines.map(l => l.split(' ')[0])).toEqual(['sleep', 'deploy', 'sleep', 'deploy', 'sleep'])
    expect(lines[1]).toBe('deploy update --auto')
    const first = Number(lines[0]!.split(' ')[1])
    const daily = Number(lines[2]!.split(' ')[1])
    expect(first >= 900 && first < 4500).toBe(true)
    expect(daily >= 86400 && daily < 90000).toBe(true)
  })

  test('the service runs it from the default runlevel, and starts nothing where micad is installed', () => {
    const script = readFileSync(join(OPENRC_PAYLOAD, 'etc/init.d/mica-update'), 'utf8')
    expect(script).toContain('command=/usr/lib/mica/mica-update-daily')
    expect(script).toContain('/usr/lib/mica/mica-init installed micad')
    expect(readlinkSync(join(OPENRC_PAYLOAD, 'etc/runlevels/default/mica-update'))).toBe('/etc/init.d/mica-update')
  })
})
