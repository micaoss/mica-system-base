// /etc/hosts: a link to /run/mica/hosts, which mica-hosts writes at every boot and
// micad rewrites; mica-hosts against a fixture hostname and run directory, and its
// place in each init's boot.
import { readdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { exec, MICA, PAYLOAD, sandbox, SYSTEM_PATH, SYSTEMD_PAYLOAD } from './harness.ts'

const box = sandbox('hosts')
afterAll(box.done)

describe('mica-hosts', () => {
  const run = join(box.dir, 'run')
  const script = join(box.dir, 'mica-hosts')
  writeFileSync(script, readFileSync(join(MICA, 'mica-hosts'), 'utf8').replaceAll('/run/mica', run))
  const name = join(box.dir, 'hostname')

  test('writes localhost and this host\'s name, readable by every user, through a rename', () => {
    writeFileSync(name, 'mica-5f2a\n')
    expect(exec(['sh', script], { PATH: SYSTEM_PATH, MICA_HOSTNAME_FILE: name }).code).toBe(0)
    expect(readFileSync(join(run, 'hosts'), 'utf8')).toBe('127.0.0.1\tlocalhost\n::1\tlocalhost\n127.0.1.1\tmica-5f2a\n')
    expect(statSync(join(run, 'hosts')).mode & 0o777).toBe(0o644)
    expect(readdirSync(run)).toEqual(['hosts'])
  })

  test('replaces what was there, with the hostname of now', () => {
    writeFileSync(join(run, 'hosts'), '127.0.0.1\tlocalhost\n10.0.0.9\tnas\n')
    writeFileSync(name, 'harbour\n')
    expect(exec(['sh', script], { PATH: SYSTEM_PATH, MICA_HOSTNAME_FILE: name }).code).toBe(0)
    expect(readFileSync(join(run, 'hosts'), 'utf8')).toBe('127.0.0.1\tlocalhost\n::1\tlocalhost\n127.0.1.1\tharbour\n')
  })
})

describe('/etc/hosts', () => {
  test('mica-system links it to /run/mica/hosts', () => {
    expect(readlinkSync(join(PAYLOAD, 'etc/hosts'))).toBe('../run/mica/hosts')
  })

  test('under systemd, mica-hosts.service writes it after the hostname and before sysinit.target', () => {
    const units = join(SYSTEMD_PAYLOAD, 'etc/systemd/system')
    const unit = readFileSync(join(units, 'mica-hosts.service'), 'utf8')
    expect(unit).toContain('ExecStart=/usr/lib/mica/mica-hosts')
    expect(unit).toMatch(/^DefaultDependencies=no$/m)
    expect(unit).toMatch(/^After=.*\bmica-apply-hostname\.service\b/m)
    expect(unit).toMatch(/^After=.*\betc-hostname\.mount\b/m)
    for (const target of ['sysinit.target', 'systemd-resolved.service', 'nss-lookup.target'])
      expect(unit).toMatch(new RegExp(`^Before=.*\\b${target.replace('.', '\\.')}\\b`, 'm'))
    expect(readlinkSync(join(units, 'sysinit.target.wants/mica-hosts.service'))).toBe('/etc/systemd/system/mica-hosts.service')
  })

  test('under OpenRC, mica-mounts writes it right after it applies the hostname', () => {
    const text = readFileSync(resolve(import.meta.dir, '../../debs/mica-openrc/payload/etc/init.d/mica-mounts'), 'utf8')
    expect(text).toMatch(/hostname -F \/etc\/hostname &&\s+\/usr\/lib\/mica\/mica-hosts\n/)
  })
})
