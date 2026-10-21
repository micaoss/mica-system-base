// mica-accounts: the app accounts micad keeps on STATE, bound with the image's over
// /etc/passwd and /etc/group; against a fixture /etc, STATE, RAM shadow and mount
// table, with mount and umount faked to edit that table. Its place in each init's boot.
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { exec, fake, MICA, sandbox, SYSTEM_PATH, SYSTEMD_PAYLOAD } from './harness.ts'

const box = sandbox('accounts')
afterAll(box.done)

const IMAGE_PASSWD = 'root:x:0:0:root:/root:/bin/sh\nmessagebus:x:996:996::/nonexistent:/usr/sbin/nologin\nmica:x:1000:1000:mica operator:/home/mica:/bin/sh\n'
const IMAGE_GROUP = 'root:x:0:\nmessagebus:x:996:\nmica:x:1000:\n'
const SHADOW = 'root:$6$transient:20000:0:99999:7:::\nmessagebus:!:20000:0:99999:7:::\nmica:!:20000:0:99999:7:::\n'

interface Case { etc: string, run: string, state: string, shadow: string, mountinfo: string, calls: string, env: Record<string, string> }

function newCase(name: string): Case {
  const dir = join(box.dir, name)
  rmSync(dir, { recursive: true, force: true })
  const c = { etc: join(dir, 'etc'), run: join(dir, 'run'), state: join(dir, 'state'), shadow: join(dir, 'shadow'), mountinfo: join(dir, 'mountinfo'), calls: join(dir, 'calls') }
  mkdirSync(c.etc, { recursive: true })
  writeFileSync(join(c.etc, 'passwd'), IMAGE_PASSWD)
  writeFileSync(join(c.etc, 'group'), IMAGE_GROUP)
  writeFileSync(c.shadow, SHADOW)
  writeFileSync(c.mountinfo, '1 0 8:1 / / ro - ext4 /dev/root ro\n')
  writeFileSync(c.calls, '')
  const bin = join(dir, 'bin')
  // mount --bind <from> <to> and umount <to>, as entries of the fixture mount table.
  fake(bin, 'mount', 'echo "mount $*" >> "$CALLS"\necho "9 1 0:9 / $3 rw - tmpfs tmpfs rw" >> "$MOUNTINFO"')
  fake(bin, 'umount', 'echo "umount $*" >> "$CALLS"\ngrep -v " $1 rw " "$MOUNTINFO" > "$MOUNTINFO.new"; mv "$MOUNTINFO.new" "$MOUNTINFO"')
  return { ...c, env: { PATH: `${bin}:${SYSTEM_PATH}`, CALLS: c.calls, MOUNTINFO: c.mountinfo, MICA_ACCOUNTS_ETC: c.etc, MICA_ACCOUNTS_RUN: c.run, MICA_ACCOUNTS_STATE: c.state, MICA_ACCOUNTS_SHADOW: c.shadow, MICA_ACCOUNTS_MOUNTINFO: c.mountinfo } }
}

const accounts = (c: Case, ...args: string[]): { code: number, out: string } => exec(['sh', join(MICA, 'mica-accounts'), ...args], c.env)
const read = (path: string): string => readFileSync(path, 'utf8')
const calls = (c: Case): string[] => read(c.calls).split('\n').filter(Boolean)
const APP = 'app-web:x:30000:30000:mica app app-web:/nonexistent:/usr/sbin/nologin\n'

describe('mica-accounts build', () => {
  test('with no app account, binds the image\'s own files, saved once', () => {
    const c = newCase('build-empty')
    expect(accounts(c, 'build')).toEqual({ code: 0, out: '' })
    expect(read(join(c.run, 'passwd'))).toBe(IMAGE_PASSWD)
    expect(read(join(c.run, 'group'))).toBe(IMAGE_GROUP)
    expect(read(join(c.run, 'image.passwd'))).toBe(IMAGE_PASSWD)
    // No lock or temporary file is left.
    expect(readdirSync(c.run).sort()).toEqual(['group', 'image.group', 'image.passwd', 'passwd'])
    expect(calls(c)).toEqual([`mount --bind ${c.run}/passwd ${c.etc}/passwd`, `mount --bind ${c.run}/group ${c.etc}/group`])
    expect(read(c.shadow)).toBe(SHADOW)
  })

  test('a rebuild rebinds, from the saved image copy and not the bound file', () => {
    const c = newCase('build-again')
    accounts(c, 'build')
    // What a reader sees once bound: the image's lines and an app's.
    writeFileSync(join(c.etc, 'passwd'), IMAGE_PASSWD + APP)
    writeFileSync(c.calls, '')
    expect(accounts(c, 'build').code).toBe(0)
    expect(read(join(c.run, 'passwd'))).toBe(IMAGE_PASSWD)
    expect(calls(c)).toEqual([
      `umount ${c.etc}/passwd`, `mount --bind ${c.run}/passwd ${c.etc}/passwd`,
      `umount ${c.etc}/group`, `mount --bind ${c.run}/group ${c.etc}/group`,
    ])
  })

  test('skips each STATE line that is malformed, out of range or a clash, and keeps the rest', () => {
    const c = newCase('build-corrupt')
    mkdirSync(c.state)
    writeFileSync(join(c.state, 'passwd'), [
      'app-web:x:30000:30000:mica app app-web:/nonexistent:/usr/sbin/nologin',
      'short:x:30001',
      'low:x:1001:1001:mica app low:/nonexistent:/usr/sbin/nologin',
      'mica:x:30002:30002:mica app mica:/nonexistent:/usr/sbin/nologin',
      'twin:x:30000:30000:mica app twin:/nonexistent:/usr/sbin/nologin',
      'Bad:x:30003:30003:mica app Bad:/nonexistent:/usr/sbin/nologin',
      '',
    ].join('\n'))
    writeFileSync(join(c.state, 'group'), 'app-web:x:30000:\nmica:x:30002:\n')
    const ran = accounts(c, 'build')
    expect(ran.code).toBe(0)
    expect(ran.out.split('\n').filter(line => line.startsWith('mica-accounts: skipping passwd line'))).toHaveLength(5)
    expect(ran.out).toContain('mica-accounts: skipping group line 2 of STATE: mica:x:30002:')
    expect(read(join(c.run, 'passwd'))).toBe(IMAGE_PASSWD + APP)
    expect(read(join(c.run, 'group'))).toBe(`${IMAGE_GROUP}app-web:x:30000:\n`)
  })

  test('an image file without a final newline still gets one before the app lines', () => {
    const c = newCase('build-newline')
    writeFileSync(join(c.etc, 'passwd'), IMAGE_PASSWD.trimEnd())
    mkdirSync(c.state)
    writeFileSync(join(c.state, 'passwd'), APP)
    accounts(c, 'build')
    expect(read(join(c.run, 'passwd'))).toBe(IMAGE_PASSWD + APP)
  })
})

describe('mica-accounts add, remove and list', () => {
  test('add writes the account to STATE, binds it, and gives it a locked shadow entry', () => {
    const c = newCase('add')
    expect(accounts(c, 'add', 'app-web', '30000')).toEqual({ code: 0, out: '' })
    expect(read(join(c.state, 'passwd'))).toBe(APP)
    expect(read(join(c.state, 'group'))).toBe('app-web:x:30000:\n')
    expect(read(join(c.run, 'passwd'))).toBe(IMAGE_PASSWD + APP)
    expect(read(join(c.run, 'group'))).toBe(`${IMAGE_GROUP}app-web:x:30000:\n`)
    // The transient root password is kept.
    expect(read(c.shadow)).toBe(`${SHADOW}app-web:!:20000:0:99999:7:::\n`)
    expect(calls(c)).toContain(`mount --bind ${c.run}/passwd ${c.etc}/passwd`)
    expect(accounts(c, 'add', 'app-db', '30001', '30005').code).toBe(0)
    expect(accounts(c, 'list')).toEqual({ code: 0, out: 'app-web\t30000\t30000\napp-db\t30001\t30005\n' })
  })

  test('the same account again is no error; other ids, a taken name or id, or the range are refused', () => {
    const c = newCase('add-refused')
    accounts(c, 'add', 'app-web', '30000')
    expect(accounts(c, 'add', 'app-web', '30000', '30000')).toEqual({ code: 0, out: '' })
    const refused = (args: string[], message: string): void => {
      expect(accounts(c, 'add', ...args)).toEqual({ code: 1, out: `mica-accounts: ${message}\n` })
    }
    refused(['app-web', '30001'], 'app-web is an app account with other ids')
    refused(['mica', '30002'], 'mica is an account of the image')
    refused(['app-two', '30000'], 'uid 30000 is taken')
    refused(['app-two', '30002', '30000'], 'gid 30000 is taken')
    refused(['app-two', '1001'], 'uid 1001 is outside 30000..39999')
    refused(['app-two', '40000'], 'uid 40000 is outside 30000..39999')
    refused(['app-two', '30002', '29999'], 'gid 29999 is outside 30000..39999')
    refused(['App', '30002'], 'App is not an account name')
    refused(['a'.repeat(33), '30002'], `${'a'.repeat(33)} is not an account name`)
    refused(['-app', '30002'], '-app is not an account name')
    expect(read(join(c.state, 'passwd'))).toBe(APP)
  })

  test('remove drops the account and its shadow entry; an unknown name is no error', () => {
    const c = newCase('remove')
    accounts(c, 'add', 'app-web', '30000')
    accounts(c, 'add', 'app-db', '30001')
    expect(accounts(c, 'remove', 'app-web')).toEqual({ code: 0, out: '' })
    expect(read(join(c.state, 'passwd'))).not.toContain('app-web')
    expect(read(join(c.state, 'group'))).toBe('app-db:x:30001:\n')
    expect(read(join(c.run, 'passwd'))).toBe(`${IMAGE_PASSWD}app-db:x:30001:30001:mica app app-db:/nonexistent:/usr/sbin/nologin\n`)
    expect(read(c.shadow)).toBe(`${SHADOW}app-db:!:20000:0:99999:7:::\n`)
    expect(accounts(c, 'remove', 'app-web')).toEqual({ code: 0, out: '' })
    // An image account is never removed, from STATE or the shadow.
    expect(accounts(c, 'remove', 'mica').code).toBe(0)
    expect(read(c.shadow)).toContain('mica:!:')
    expect(accounts(c, 'list').out).toBe('app-db\t30001\t30001\n')
  })

  test('bad arguments are a usage error', () => {
    const c = newCase('usage')
    for (const args of [[], ['add', 'app'], ['add', 'app', '30000', '30000', 'x'], ['remove'], ['list', 'x'], ['build', 'x'], ['create', 'app', '30000']])
      expect(accounts(c, ...args).code).toBe(2)
    expect(existsSync(c.state)).toBe(false)
  })
})

describe('the accounts in each init\'s boot', () => {
  test('under systemd, mica-accounts.service binds them once STATE is up, before micad and the shadow', () => {
    const units = join(SYSTEMD_PAYLOAD, 'etc/systemd/system')
    const unit = read(join(units, 'mica-accounts.service'))
    expect(unit).toContain('ExecStart=/usr/lib/mica/mica-accounts build')
    expect(unit).toMatch(/^After=mica-seed-state\.service$/m)
    expect(unit).toMatch(/^RequiresMountsFor=\/mnt\/data\/state$/m)
    for (const target of ['local-fs.target', 'micad.service', 'mica-shadow-reconcile.service'])
      expect(unit).toMatch(new RegExp(`^Before=.*\\b${target.replaceAll('.', '\\.')}\\b`, 'm'))
    expect(readlinkSync(join(units, 'local-fs.target.wants/mica-accounts.service'))).toBe('/etc/systemd/system/mica-accounts.service')
    expect(read(join(units, 'mica-shadow-reconcile.service'))).toMatch(/^After=mica-accounts\.service$/m)
  })

  test('under OpenRC, mica-mounts binds them after the hostname, and goes on if that fails', () => {
    const text = read(resolve(import.meta.dir, '../../debs/mica-openrc/payload/etc/init.d/mica-mounts'))
    expect(text).toMatch(/\/usr\/lib\/mica\/mica-hosts\n\s+eend \$\? \|\| return 1\n[^\n]*\n\s+ebegin "Binding the accounts"\n\s+\/usr\/lib\/mica\/mica-accounts build\n\s+eend \$\?\n/)
  })
})
