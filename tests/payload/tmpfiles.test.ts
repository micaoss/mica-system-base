// mica-systemd's /etc/tmpfiles.d: same-named files that replace Debian's and systemd's
// /usr/lib/tmpfiles.d entries for the read-only /etc, keeping their /run lines.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { SYSTEMD_PAYLOAD } from './harness.ts'

const directory = join(SYSTEMD_PAYLOAD, 'etc/tmpfiles.d')
// Each file's entries: type, path, the rest, as systemd-tmpfiles reads them.
const entries = (name: string): string[][] =>
  readFileSync(join(directory, name), 'utf8').split('\n')
    .filter(line => line.trim() && !line.startsWith('#'))
    .map(line => line.trim().split(/\s+/))

describe('mica-systemd\'s tmpfiles overrides', () => {
  test('replaces exactly the entries that write to /etc', () => {
    expect(readdirSync(directory).sort()).toEqual(['20-systemd-shell-extra.conf', '20-systemd-ssh-generator.conf', 'credstore.conf', 'debian.conf'])
  })

  test('touches nothing outside /run', () => {
    for (const name of readdirSync(directory)) {
      for (const [, path] of entries(name))
        expect(path).toStartWith('/run/')
    }
  })

  test('keeps Debian\'s and systemd\'s /run lines, and masks the rest', () => {
    expect(entries('debian.conf')).toEqual([
      ['L', '/run/shm', '-', '-', '-', '-', '/dev/shm'],
      ['d', '/run/sendsigs.omit.d', '0755', 'root', 'root', '-'],
      ['d', '/run/lock', '1777', 'root', 'root', '-'],
    ])
    expect(entries('credstore.conf')).toEqual([
      ['z', '/run/credstore', '0700', 'root', 'root'],
      ['z', '/run/credstore.encrypted', '0700', 'root', 'root'],
    ])
    expect(entries('20-systemd-shell-extra.conf')).toEqual([])
    expect(entries('20-systemd-ssh-generator.conf')).toEqual([])
  })

  // The masked ssh generator entry made /run/sshd; mica-openssh's unit makes it now.
  test('sshd\'s privilege separation directory still comes from mica-sshd.service', () => {
    const unit = readFileSync(join(SYSTEMD_PAYLOAD, '../../mica-openssh/mica-sshd.service'), 'utf8').split('\n')
    expect(unit).toContain('RuntimeDirectory=sshd')
    expect(unit).toContain('RuntimeDirectoryMode=0755')
  })
})
