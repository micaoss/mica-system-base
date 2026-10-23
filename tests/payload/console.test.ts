// The login prompt: micad's device code through /etc/issue.d (mica-system), and
// mica-openrc's mica-getty, agetty on the consoles, against a fake supervise-daemon
// and a fake /sys and /dev.
import { mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { exec, fake, PAYLOAD, sandbox, SYSTEM_PATH } from './harness.ts'

const box = sandbox('console')
afterAll(box.done)

test('/etc/issue.d shows micad\'s device code after /etc/issue, and nothing while it has none', () => {
  expect(readlinkSync(join(PAYLOAD, 'etc/issue.d/50-mica-device-code.issue'))).toBe('/run/mica/device-code.issue')
})

describe('mica-getty', () => {
  const bin = join(box.dir, 'getty-bin')
  const calls = join(box.dir, 'getty-calls')
  const fs = join(box.dir, 'getty-fs')
  // supervise-daemon refuses a name other than RC_SVCNAME.
  fake(bin, 'supervise-daemon', '[ "$RC_SVCNAME" = "$1" ] || exit 1\necho "supervise-daemon $*" >> "$CALLS"')
  const script = join(box.dir, 'mica-getty')
  writeFileSync(script, readFileSync(resolve(import.meta.dir, '../../debs/mica-openrc/payload/etc/init.d/mica-getty'), 'utf8')
    .replaceAll('/sys/', `${fs}/sys/`).replaceAll('/dev/', `${fs}/dev/`).replaceAll('/usr/bin/login', `${fs}/usr/bin/login`).replaceAll('/run/', `${fs}/run/`))
  // A machine: its console= consoles, whether login is installed and whether a display exists.
  const machine = (active: string, { login = true, display = false } = {}): void => {
    rmSync(fs, { recursive: true, force: true })
    for (const dir of ['sys/class/tty/console', 'dev', 'usr/bin', 'run'])
      mkdirSync(join(fs, dir), { recursive: true })
    writeFileSync(join(fs, 'sys/class/tty/console/active'), `${active}\n`)
    for (const tty of ['tty0', 'tty1', 'tty2', 'ttyS0', 'ttyS2', 'ttyFIQ0'])
      writeFileSync(join(fs, 'dev', tty), '')
    if (login)
      writeFileSync(join(fs, 'usr/bin/login'), '')
    if (display)
      mkdirSync(join(fs, 'sys/class/graphics/fb0'), { recursive: true })
  }
  const run = (action: string): string[] => {
    writeFileSync(calls, '')
    expect(exec(['sh', '-c', `einfo() { :; }; ebegin() { :; }; eend() { return $1; }; . ${script}; ${action}`], { PATH: `${bin}:${SYSTEM_PATH}`, CALLS: calls }).code).toBe(0)
    return readFileSync(calls, 'utf8').split('\n').filter(Boolean)
  }
  const serial = (tty: string): string => `supervise-daemon mica-getty.${tty} --start --pidfile ${fs}/run/mica-getty.${tty}.pid --respawn-delay 1 --respawn-max 0 /usr/sbin/agetty -- -o -- \\u --noreset --noclear --keep-baud 115200,57600,38400,9600 ${tty} vt220`

  test('agetty on each serial console of the command line, as serial-getty@', () => {
    machine('tty0 ttyS2')
    expect(run('start')).toEqual([serial('ttyS2')])
    machine('ttyFIQ0')
    expect(run('start')).toEqual([serial('ttyFIQ0')])
  })

  test('with a display, agetty on tty2 too, the login VT; tty1, the logo\'s, stays idle', () => {
    machine('ttyS0 tty0', { display: true })
    expect(run('start')).toEqual([
      serial('ttyS0'),
      `supervise-daemon mica-getty.tty2 --start --pidfile ${fs}/run/mica-getty.tty2.pid --respawn-delay 1 --respawn-max 0 /usr/sbin/agetty -- -o -- \\u --noreset --noclear tty2 linux`,
    ])
  })

  test('no getty until the console option installs login', () => {
    machine('ttyS2', { login: false, display: true })
    expect(run('start')).toEqual([])
  })

  test('stop stops every getty it started', () => {
    machine('ttyS2')
    for (const tty of ['ttyS2', 'tty2'])
      writeFileSync(join(fs, `run/mica-getty.${tty}.pid`), '1\n')
    expect(run('stop').sort()).toEqual([
      `supervise-daemon mica-getty.tty2 --stop --pidfile ${fs}/run/mica-getty.tty2.pid`,
      `supervise-daemon mica-getty.ttyS2 --stop --pidfile ${fs}/run/mica-getty.ttyS2.pid`,
    ])
  })
})
