// mica-unit, the user's services on DATA state: mica-systemd's against a fake
// systemctl over a fixture unit directory, mica-openrc's against a fake rc-service
// over a fixture /usr/local/etc; mica-local and mica-mounts' bind of that directory.
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { exec, fake, sandbox, SYSTEM_PATH, SYSTEMD_PAYLOAD } from './harness.ts'

const OPENRC_PAYLOAD = resolve(import.meta.dir, '../../debs/mica-openrc/payload')
const box = sandbox('unit')
afterAll(box.done)

const TAILSCALED = '[Unit]\nDescription=Tailscale node agent\n\n[Service]\nExecStart=/srv/tailscaled/tailscaled\n\n[Install]\nWantedBy=multi-user.target\n'

interface Case { dir: string, units: string, shipped: string, bin: string, calls: string, src: string }

function newCase(name: string, tool: 'systemctl' | 'rc-service'): Case {
  const dir = join(box.dir, name)
  rmSync(dir, { recursive: true, force: true })
  const c = { dir, units: join(dir, 'units'), shipped: join(dir, 'shipped'), bin: join(dir, 'bin'), calls: join(dir, 'calls'), src: join(dir, 'src') }
  for (const path of [c.units, c.shipped, c.src])
    mkdirSync(path, { recursive: true })
  writeFileSync(c.calls, '')
  fake(c.bin, tool, `echo "${tool} $*" >> "$CALLS"`)
  return c
}

const calls = (c: Case): string[] => readFileSync(c.calls, 'utf8').split('\n').filter(Boolean)
const link = (path: string): string | undefined => existsSync(path) || lstatExists(path) ? readlinkSync(path) : undefined
function lstatExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  }
  catch {
    return false
  }
}

describe('mica-unit for systemd', () => {
  const script = join(SYSTEMD_PAYLOAD, 'usr/sbin/mica-unit')
  const unit = (c: Case, ...args: string[]): { code: number, out: string } =>
    exec(['sh', script, ...args], { PATH: `${c.bin}:${SYSTEM_PATH}`, CALLS: c.calls, MICA_UNIT_DIR: c.units, MICA_UNIT_SHIPPED: c.shipped })
  const source = (c: Case, name: string, text: string): string => {
    writeFileSync(join(c.src, name), text)
    return join(c.src, name)
  }

  test('installs a unit into the DATA directory and enables it by its [Install] section', () => {
    const c = newCase('systemd-enable', 'systemctl')
    expect(unit(c, 'install', source(c, 'tailscaled.service', TAILSCALED)).code).toBe(0)
    expect(readFileSync(join(c.units, 'tailscaled.service'), 'utf8')).toBe(TAILSCALED)
    expect(statSync(join(c.units, 'tailscaled.service')).mode & 0o777).toBe(0o644)
    expect(unit(c, 'enable', '--now', 'tailscaled').code).toBe(0)
    expect(link(join(c.units, 'multi-user.target.wants/tailscaled.service'))).toBe('../tailscaled.service')
    expect(calls(c)).toEqual(['systemctl daemon-reload', 'systemctl daemon-reload', 'systemctl start tailscaled.service'])
  })

  test('links RequiredBy= and Alias= too, and an instance of a template', () => {
    const c = newCase('systemd-links', 'systemctl')
    unit(c, 'install', source(c, 'relay.service', '[Service]\nExecStart=/srv/relay\n[Install]\nRequiredBy=network.target\nAlias=relayd.service\nWantedBy=multi-user.target timers.target\n'))
    expect(unit(c, 'enable', 'relay.service').code).toBe(0)
    expect(link(join(c.units, 'network.target.requires/relay.service'))).toBe('../relay.service')
    expect(link(join(c.units, 'multi-user.target.wants/relay.service'))).toBe('../relay.service')
    expect(link(join(c.units, 'timers.target.wants/relay.service'))).toBe('../relay.service')
    expect(link(join(c.units, 'relayd.service'))).toBe('relay.service')
    unit(c, 'install', source(c, 'tunnel@.service', '[Service]\nExecStart=/srv/tunnel %i\n[Install]\nWantedBy=multi-user.target\n'))
    expect(unit(c, 'enable', 'tunnel@eu').code).toBe(0)
    expect(link(join(c.units, 'multi-user.target.wants/tunnel@eu.service'))).toBe('../tunnel@.service')
  })

  test('disables, stops and removes what it enabled', () => {
    const c = newCase('systemd-disable', 'systemctl')
    unit(c, 'install', source(c, 'tailscaled.service', TAILSCALED))
    unit(c, 'enable', 'tailscaled')
    writeFileSync(c.calls, '')
    expect(unit(c, 'disable', '--now', 'tailscaled').code).toBe(0)
    expect(lstatExists(join(c.units, 'multi-user.target.wants/tailscaled.service'))).toBe(false)
    expect(existsSync(join(c.units, 'tailscaled.service'))).toBe(true)
    expect(calls(c)).toEqual(['systemctl stop tailscaled.service', 'systemctl daemon-reload'])
    unit(c, 'enable', 'tailscaled')
    writeFileSync(c.calls, '')
    expect(unit(c, 'remove', 'tailscaled').code).toBe(0)
    expect(existsSync(join(c.units, 'tailscaled.service'))).toBe(false)
    expect(lstatExists(join(c.units, 'multi-user.target.wants/tailscaled.service'))).toBe(false)
    expect(calls(c)).toEqual(['systemctl stop tailscaled.service', 'systemctl daemon-reload'])
  })

  test('lists the installed units and whether each is enabled', () => {
    const c = newCase('systemd-list', 'systemctl')
    unit(c, 'install', source(c, 'tailscaled.service', TAILSCALED), source(c, 'idle.service', TAILSCALED))
    unit(c, 'enable', 'tailscaled')
    expect(unit(c, 'list').out).toBe('idle.service\tdisabled\ntailscaled.service\tenabled\n')
  })

  // A Mica unit cannot be shadowed or masked from DATA: the root's own units keep
  // their meaning across every update.
  test('refuses a name the root ships, a unit with no [Install] and a name that is no unit', () => {
    const c = newCase('systemd-refusals', 'systemctl')
    writeFileSync(join(c.shipped, 'micad.service'), '')
    const shipped = unit(c, 'install', source(c, 'micad.service', TAILSCALED))
    expect(shipped.code).not.toBe(0)
    expect(shipped.out).toContain('micad.service is shipped by the root')
    expect(existsSync(join(c.units, 'micad.service'))).toBe(false)
    unit(c, 'install', source(c, 'shadow.service', '[Service]\nExecStart=/srv/x\n[Install]\nAlias=micad.service\n'))
    expect(unit(c, 'enable', 'shadow').out).toContain('micad.service is shipped by the root')
    expect(lstatExists(join(c.units, 'micad.service'))).toBe(false)
    unit(c, 'install', source(c, 'bare.service', '[Service]\nExecStart=/srv/x\n'))
    expect(unit(c, 'enable', 'bare').out).toContain('bare.service has no WantedBy=, RequiredBy= or Alias=')
    expect(unit(c, 'install', source(c, 'notes.txt', 'x')).out).toContain('notes.txt is not a unit name')
    expect(unit(c, 'enable', 'absent').out).toContain('absent.service is not installed')
    expect(unit(c, 'frobnicate').code).toBe(2)
    expect(calls(c)).not.toContain('systemctl start micad.service')
  })
})

// At boot the units on DATA are loaded once their bind is up, after micad, as
// before, but never needing it: a user service starts even when micad does not.
test('mica-load-extensions orders after micad without requiring it', () => {
  const service = readFileSync(join(SYSTEMD_PAYLOAD, 'etc/systemd/system/mica-load-extensions.service'), 'utf8')
  expect(service).toMatch(/^After=.*\bmicad\.service\b/m)
  expect(service).not.toMatch(/^(Requires|BindsTo|Requisite)=.*micad/m)
  expect(service).toMatch(/^Requires=usr-local-lib-systemd-system\.mount$/m)
})

const SCRIPT = '#!/sbin/openrc-run\ncommand=/srv/tailscaled/tailscaled\ncommand_background=yes\npidfile=/run/tailscaled.pid\n'

describe('mica-unit for OpenRC', () => {
  const script = join(OPENRC_PAYLOAD, 'usr/sbin/mica-unit')
  const unit = (c: Case, ...args: string[]): { code: number, out: string } =>
    exec(['sh', script, ...args], { PATH: `${c.bin}:${SYSTEM_PATH}`, CALLS: c.calls, MICA_UNIT_DIR: c.units, MICA_UNIT_SHIPPED: c.shipped })
  const source = (c: Case, name: string, text: string): string => {
    writeFileSync(join(c.src, name), text)
    return join(c.src, name)
  }

  test('installs a script and its conf.d file, and enables it for every boot', () => {
    const c = newCase('openrc-enable', 'rc-service')
    expect(unit(c, 'install', source(c, 'tailscaled', SCRIPT)).code).toBe(0)
    expect(unit(c, 'install', '--conf', source(c, 'tailscaled.conf', 'command_args="--state=/srv/tailscaled/state"\n')).code).toBe(0)
    expect(statSync(join(c.units, 'init.d/tailscaled')).mode & 0o777).toBe(0o755)
    expect(readFileSync(join(c.units, 'conf.d/tailscaled'), 'utf8')).toContain('command_args')
    expect(unit(c, 'enable', '--now', 'tailscaled').code).toBe(0)
    expect(link(join(c.units, 'enabled/tailscaled'))).toBe('../init.d/tailscaled')
    expect(calls(c)).toEqual(['rc-service tailscaled start'])
  })

  test('disables, stops and removes what it enabled, and lists the rest', () => {
    const c = newCase('openrc-disable', 'rc-service')
    unit(c, 'install', source(c, 'tailscaled', SCRIPT), source(c, 'idle', SCRIPT))
    unit(c, 'enable', 'tailscaled')
    expect(unit(c, 'list').out).toBe('idle\tdisabled\ntailscaled\tenabled\n')
    expect(unit(c, 'disable', '--now', 'tailscaled').code).toBe(0)
    expect(lstatExists(join(c.units, 'enabled/tailscaled'))).toBe(false)
    expect(existsSync(join(c.units, 'init.d/tailscaled'))).toBe(true)
    unit(c, 'enable', 'tailscaled')
    writeFileSync(c.calls, '')
    expect(unit(c, 'remove', 'tailscaled').code).toBe(0)
    expect(existsSync(join(c.units, 'init.d/tailscaled'))).toBe(false)
    expect(lstatExists(join(c.units, 'enabled/tailscaled'))).toBe(false)
    expect(calls(c)).toEqual(['rc-service tailscaled stop'])
  })

  test('refuses a name the root ships and a file that is no openrc-run script', () => {
    const c = newCase('openrc-refusals', 'rc-service')
    writeFileSync(join(c.shipped, 'micad'), '')
    const shipped = unit(c, 'install', source(c, 'micad', SCRIPT))
    expect(shipped.code).not.toBe(0)
    expect(shipped.out).toContain('micad is shipped by the root')
    expect(existsSync(join(c.units, 'init.d/micad'))).toBe(false)
    expect(unit(c, 'install', source(c, 'plain', '#!/bin/sh\nexec /srv/x\n')).out).toContain('plain is not an openrc-run script')
    expect(unit(c, 'enable', 'absent').out).toContain('absent is not installed')
    expect(unit(c, 'frobnicate').code).toBe(2)
  })
})

describe('mica-local', () => {
  const text = readFileSync(join(OPENRC_PAYLOAD, 'etc/init.d/mica-local'), 'utf8')

  // In the default runlevel, after micad's bus: a user service starts even when micad
  // does not.
  test('starts every enabled script, after the bus and never needing micad', () => {
    const c = newCase('local-start', 'rc-service')
    mkdirSync(join(c.units, 'enabled'), { recursive: true })
    mkdirSync(join(c.units, 'init.d'), { recursive: true })
    for (const name of ['beta', 'alpha']) {
      writeFileSync(join(c.units, 'init.d', name), SCRIPT)
      Bun.spawnSync(['ln', '-s', `../init.d/${name}`, join(c.units, 'enabled', name)])
    }
    const script = join(c.dir, 'mica-local')
    writeFileSync(script, text)
    const ran = exec(['sh', '-c', `. ${script}; ebegin() { :; }; eend() { return \${1:-0}; }; ewarn() { echo "$*"; }; start`], { PATH: `${c.bin}:${SYSTEM_PATH}`, CALLS: c.calls, MICA_UNIT_DIR: c.units })
    expect(ran.code).toBe(0)
    expect(calls(c)).toEqual(['rc-service alpha start', 'rc-service beta start'])
    expect(/depend\(\) \{([^}]*)\}/.exec(text)?.[1]).not.toMatch(/need[^\n]*micad/)
    expect(readlinkSync(join(OPENRC_PAYLOAD, 'etc/runlevels/default/mica-local'))).toBe('/etc/init.d/mica-local')
  })
})

describe('mica-mounts', () => {
  // The user's scripts live on DATA state, bound over /usr/local/etc, which librc
  // searches after /etc for init.d and conf.d.
  test('binds DATA/state/openrc-local over /usr/local/etc, and unbinds it at shutdown', () => {
    const c = newCase('mounts', 'rc-service')
    const state = join(c.dir, 'openrc-local')
    const text = readFileSync(join(OPENRC_PAYLOAD, 'etc/init.d/mica-mounts'), 'utf8').replaceAll('/mnt/data/state/openrc-local', state)
    const script = join(c.dir, 'mica-mounts')
    writeFileSync(script, text)
    const stubs = 'bind() { echo "bind $*" >> "$CALLS"; }; mount() { :; }; seed() { :; }; hostname() { :; }; tmpfiles() { :; }'
    const ran = exec(['sh', '-c', `. ${script}; ebegin() { :; }; eend() { return \${1:-0}; }; ${stubs}; start`], { PATH: SYSTEM_PATH, CALLS: c.calls })
    expect(ran.code).toBe(0)
    expect(calls(c)).toContain(`bind ${state} /usr/local/etc`)
    for (const leaf of ['init.d', 'conf.d', 'enabled'])
      expect(statSync(join(state, leaf)).isDirectory()).toBe(true)
    expect(text).toMatch(/for target in [^;]*\/var \/usr\/local\/etc \/etc\/hostname/)
  })
})
