// mica-accounts: the service accounts micad keeps on STATE and the login accounts of a
// provisioning agent, bound with the image's over /etc/passwd and /etc/group;
// against a fixture /etc, STATE, /home, RAM shadow and mount table, with mount and
// umount faked to edit that table. Its place in each init's boot.
import { chownSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { exec, fake, MICA, sandbox, SYSTEM_PATH, SYSTEMD_PAYLOAD } from './harness.ts'

const box = sandbox('accounts')
afterAll(box.done)

const IMAGE_PASSWD = 'root:x:0:0:root:/root:/bin/sh\nmessagebus:x:996:996::/nonexistent:/usr/sbin/nologin\nmica:x:1000:1000:mica operator:/home/mica:/bin/sh\n'
const IMAGE_GROUP = 'root:x:0:\nmessagebus:x:996:\nmica:x:1000:\n'
const SHADOW = 'root:$6$transient:20000:0:99999:7:::\nmessagebus:!:20000:0:99999:7:::\nmica:!:20000:0:99999:7:::\n'

interface Case { etc: string, run: string, state: string, homes: string, shadow: string, mountinfo: string, calls: string, env: Record<string, string> }

function newCase(name: string): Case {
  const dir = join(box.dir, name)
  rmSync(dir, { recursive: true, force: true })
  const c = { etc: join(dir, 'etc'), run: join(dir, 'run'), state: join(dir, 'state'), homes: join(dir, 'home'), shadow: join(dir, 'shadow'), mountinfo: join(dir, 'mountinfo'), calls: join(dir, 'calls') }
  mkdirSync(c.etc, { recursive: true })
  mkdirSync(join(c.homes, 'mica'), { recursive: true })
  writeFileSync(join(c.etc, 'passwd'), IMAGE_PASSWD)
  writeFileSync(join(c.etc, 'group'), IMAGE_GROUP)
  writeFileSync(c.shadow, SHADOW)
  writeFileSync(c.mountinfo, '1 0 8:1 / / ro - ext4 /dev/root ro\n')
  writeFileSync(c.calls, '')
  const bin = join(dir, 'bin')
  // mount --bind <from> <to> and umount <to>, as entries of the fixture mount table.
  fake(bin, 'mount', 'echo "mount $*" >> "$CALLS"\necho "9 1 0:9 / $3 rw - tmpfs tmpfs rw" >> "$MOUNTINFO"')
  fake(bin, 'umount', 'echo "umount $*" >> "$CALLS"\ngrep -v " $1 rw " "$MOUNTINFO" > "$MOUNTINFO.new"; mv "$MOUNTINFO.new" "$MOUNTINFO"')
  return { ...c, env: { PATH: `${bin}:${SYSTEM_PATH}`, CALLS: c.calls, MOUNTINFO: c.mountinfo, MICA_ACCOUNTS_ETC: c.etc, MICA_ACCOUNTS_RUN: c.run, MICA_ACCOUNTS_STATE: c.state, MICA_ACCOUNTS_SHADOW: c.shadow, MICA_ACCOUNTS_MOUNTINFO: c.mountinfo, MICA_ACCOUNTS_HOMES: c.homes } }
}

const accounts = (c: Case, ...args: string[]): { code: number, out: string } => exec(['sh', join(MICA, 'mica-accounts'), ...args], c.env)
const read = (path: string): string => readFileSync(path, 'utf8')
const calls = (c: Case): string[] => read(c.calls).split('\n').filter(Boolean)
const SERVICE = 'svc-web:x:30000:30000:mica service svc-web:/nonexistent:/usr/sbin/nologin\n'

describe('mica-accounts build', () => {
  test('with no service account, binds the image\'s own files, saved once', () => {
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
    // What a reader sees once bound: the image's lines and a service's.
    writeFileSync(join(c.etc, 'passwd'), IMAGE_PASSWD + SERVICE)
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
      'svc-web:x:30000:30000:mica service svc-web:/nonexistent:/usr/sbin/nologin',
      'short:x:30001',
      'low:x:1001:1001:mica service low:/nonexistent:/usr/sbin/nologin',
      'mica:x:30002:30002:mica service mica:/nonexistent:/usr/sbin/nologin',
      'twin:x:30000:30000:mica service twin:/nonexistent:/usr/sbin/nologin',
      'Bad:x:30003:30003:mica service Bad:/nonexistent:/usr/sbin/nologin',
      '',
    ].join('\n'))
    writeFileSync(join(c.state, 'group'), 'svc-web:x:30000:\nmica:x:30002:\n')
    const ran = accounts(c, 'build')
    expect(ran.code).toBe(0)
    expect(ran.out.split('\n').filter(line => line.startsWith('mica-accounts: skipping passwd line'))).toHaveLength(5)
    expect(ran.out).toContain('mica-accounts: skipping group line 2 of STATE: mica:x:30002:')
    expect(read(join(c.run, 'passwd'))).toBe(IMAGE_PASSWD + SERVICE)
    expect(read(join(c.run, 'group'))).toBe(`${IMAGE_GROUP}svc-web:x:30000:\n`)
  })

  test('a service account kept with the GECOS of an earlier release still binds', () => {
    const c = newCase('earlier-gecos')
    mkdirSync(c.state)
    const earlier = 'web:x:30000:30000:mica app web:/nonexistent:/usr/sbin/nologin\n'
    writeFileSync(join(c.state, 'passwd'), earlier)
    writeFileSync(join(c.state, 'group'), 'web:x:30000:\n')
    expect(accounts(c, 'build').code).toBe(0)
    expect(read(join(c.run, 'passwd'))).toBe(IMAGE_PASSWD + earlier)
    expect(accounts(c, 'list')).toEqual({ code: 0, out: 'web\t30000\t30000\n' })
  })

  test('an image file without a final newline still gets one before the service lines', () => {
    const c = newCase('build-newline')
    writeFileSync(join(c.etc, 'passwd'), IMAGE_PASSWD.trimEnd())
    mkdirSync(c.state)
    writeFileSync(join(c.state, 'passwd'), SERVICE)
    accounts(c, 'build')
    expect(read(join(c.run, 'passwd'))).toBe(IMAGE_PASSWD + SERVICE)
  })
})

describe('mica-accounts add, remove and list', () => {
  test('add writes the account to STATE, binds it, and gives it a locked shadow entry', () => {
    const c = newCase('add')
    expect(accounts(c, 'add', 'svc-web', '30000')).toEqual({ code: 0, out: '' })
    expect(read(join(c.state, 'passwd'))).toBe(SERVICE)
    expect(read(join(c.state, 'group'))).toBe('svc-web:x:30000:\n')
    expect(read(join(c.run, 'passwd'))).toBe(IMAGE_PASSWD + SERVICE)
    expect(read(join(c.run, 'group'))).toBe(`${IMAGE_GROUP}svc-web:x:30000:\n`)
    // The transient root password is kept.
    expect(read(c.shadow)).toBe(`${SHADOW}svc-web:!:20000:0:99999:7:::\n`)
    expect(calls(c)).toContain(`mount --bind ${c.run}/passwd ${c.etc}/passwd`)
    expect(accounts(c, 'add', 'svc-db', '30001', '30005').code).toBe(0)
    expect(accounts(c, 'list')).toEqual({ code: 0, out: 'svc-web\t30000\t30000\nsvc-db\t30001\t30005\n' })
  })

  test('the same account again is no error; other ids, a taken name or id, or the range are refused', () => {
    const c = newCase('add-refused')
    accounts(c, 'add', 'svc-web', '30000')
    expect(accounts(c, 'add', 'svc-web', '30000', '30000')).toEqual({ code: 0, out: '' })
    const refused = (args: string[], message: string): void => {
      expect(accounts(c, 'add', ...args)).toEqual({ code: 1, out: `mica-accounts: ${message}\n` })
    }
    refused(['svc-web', '30001'], 'svc-web is a service account with other ids')
    refused(['mica', '30002'], 'mica is an account of the image')
    refused(['svc-two', '30000'], 'uid 30000 is taken')
    refused(['svc-two', '30002', '30000'], 'gid 30000 is taken')
    refused(['svc-two', '1001'], 'uid 1001 is outside 30000..39999')
    refused(['svc-two', '40000'], 'uid 40000 is outside 30000..39999')
    refused(['svc-two', '30002', '29999'], 'gid 29999 is outside 30000..39999')
    refused(['Svc', '30002'], 'Svc is not an account name')
    refused(['a'.repeat(33), '30002'], `${'a'.repeat(33)} is not an account name`)
    refused(['-svc', '30002'], '-svc is not an account name')
    expect(read(join(c.state, 'passwd'))).toBe(SERVICE)
  })

  test('remove drops the account and its shadow entry; an unknown name is no error', () => {
    const c = newCase('remove')
    accounts(c, 'add', 'svc-web', '30000')
    accounts(c, 'add', 'svc-db', '30001')
    expect(accounts(c, 'remove', 'svc-web')).toEqual({ code: 0, out: '' })
    expect(read(join(c.state, 'passwd'))).not.toContain('svc-web')
    expect(read(join(c.state, 'group'))).toBe('svc-db:x:30001:\n')
    expect(read(join(c.run, 'passwd'))).toBe(`${IMAGE_PASSWD}svc-db:x:30001:30001:mica service svc-db:/nonexistent:/usr/sbin/nologin\n`)
    expect(read(c.shadow)).toBe(`${SHADOW}svc-db:!:20000:0:99999:7:::\n`)
    expect(accounts(c, 'remove', 'svc-web')).toEqual({ code: 0, out: '' })
    // An image account is never removed, from STATE or the shadow.
    expect(accounts(c, 'remove', 'mica').code).toBe(0)
    expect(read(c.shadow)).toContain('mica:!:')
    expect(accounts(c, 'list').out).toBe('svc-db\t30001\t30001\n')
  })

  test('bad arguments are a usage error', () => {
    const c = newCase('usage')
    for (const args of [[], ['add', 'svc'], ['add', 'svc', '30000', '30000', 'x'], ['remove'], ['list', 'x'], ['build', 'x'], ['create', 'svc', '30000']])
      expect(accounts(c, ...args).code).toBe(2)
    expect(existsSync(c.state)).toBe(false)
  })
})

// A login account's home is made with its owner, which takes root.
describe.skipIf(process.getuid?.() !== 0)('mica-accounts add-login, remove-login and list-login', () => {
  const LOGIN = (name: string, uid: number): string => `${name}:x:${uid}:${uid}:mica login ${name}:/home/${name}:/bin/sh\n`
  const owner = (path: string): string => {
    const { uid, gid, mode } = statSync(path)
    return `${uid}:${gid} ${(mode & 0o777).toString(8)}`
  }

  test('add-login chooses the lowest free uid, binds the account and its group, makes its home and lets its keys in', () => {
    const c = newCase('login')
    accounts(c, 'add', 'svc-web', '30000')
    expect(accounts(c, 'add-login', 'alice')).toEqual({ code: 0, out: '20000\n' })
    expect(accounts(c, 'add-login', 'bob')).toEqual({ code: 0, out: '20001\n' })
    expect(read(join(c.state, 'passwd'))).toBe(SERVICE + LOGIN('alice', 20000) + LOGIN('bob', 20001))
    expect(read(join(c.state, 'group'))).toBe('svc-web:x:30000:\nalice:x:20000:\nbob:x:20001:\n')
    expect(read(join(c.run, 'passwd'))).toBe(IMAGE_PASSWD + SERVICE + LOGIN('alice', 20000) + LOGIN('bob', 20001))
    expect(owner(join(c.homes, 'alice'))).toBe('20000:20000 700')
    // No password: '*' lets a key log in, '!' would lock even that.
    expect(read(c.shadow)).toBe(`${SHADOW}svc-web:!:20000:0:99999:7:::\nalice:*:20000:0:99999:7:::\nbob:*:20000:0:99999:7:::\n`)
    // Again is no error and the same uid; the classes list apart.
    expect(accounts(c, 'add-login', 'alice')).toEqual({ code: 0, out: '20000\n' })
    expect(accounts(c, 'list-login')).toEqual({ code: 0, out: 'alice\t20000\tno\nbob\t20001\tno\n' })
    expect(accounts(c, 'list')).toEqual({ code: 0, out: 'svc-web\t30000\t30000\n' })
  })

  test('a locked entry of a login account loses its lock at the next build', () => {
    const c = newCase('login-unlock')
    accounts(c, 'add-login', 'alice')
    writeFileSync(c.shadow, `${SHADOW}alice:!:20000:0:99999:7:::\n`)
    expect(accounts(c, 'build').code).toBe(0)
    expect(read(c.shadow)).toBe(`${SHADOW}alice:*:20000:0:99999:7:::\n`)
  })

  test('remove-login keeps the home, which makes its uid no one else\'s and its owner\'s again', () => {
    const c = newCase('login-home')
    accounts(c, 'add-login', 'alice')
    writeFileSync(join(c.homes, 'alice', 'notes'), 'mine\n')
    expect(accounts(c, 'remove-login', 'alice')).toEqual({ code: 0, out: '' })
    expect(read(join(c.state, 'passwd'))).toBe('')
    expect(read(c.shadow)).toBe(SHADOW)
    expect(read(join(c.homes, 'alice', 'notes'))).toBe('mine\n')
    expect(accounts(c, 'add-login', 'carol').out).toBe('20001\n')
    expect(accounts(c, 'add-login', 'alice').out).toBe('20000\n')
    expect(accounts(c, 'remove-login', 'nobody')).toEqual({ code: 0, out: '' })
    // A kept home whose owner another account holds is refused, not handed over.
    mkdirSync(join(c.homes, 'dave'))
    chownSync(join(c.homes, 'dave'), 20001, 20001)
    expect(accounts(c, 'add-login', 'dave')).toEqual({ code: 1, out: `mica-accounts: ${c.homes}/dave is owned by uid 20001, which is not free for dave\n` })
  })

  test('refuses root, mica, sshd, the image\'s names and the service accounts; the classes stay apart', () => {
    const c = newCase('login-refused')
    accounts(c, 'add', 'svc-web', '30000')
    accounts(c, 'add-login', 'alice')
    const refused = (args: string[], message: string): void => {
      expect(accounts(c, ...args)).toEqual({ code: 1, out: `mica-accounts: ${message}\n` })
    }
    for (const name of ['root', 'mica', 'sshd'])
      refused(['add-login', name], `${name} is not a login name`)
    refused(['add-login', 'messagebus'], 'messagebus is an account of the image')
    refused(['add-login', 'svc-web'], 'svc-web is a service account')
    refused(['add-login', 'Alice'], 'Alice is not an account name')
    refused(['add', 'alice', '30001'], 'alice is a login account')
    refused(['add', 'svc-two', '20001'], 'uid 20001 is outside 30000..39999')
    refused(['remove', 'alice'], 'alice is a login account')
    refused(['remove-login', 'svc-web'], 'svc-web is a service account')
    expect(read(join(c.state, 'passwd'))).toBe(SERVICE + LOGIN('alice', 20000))
  })

  // The image's mica-admins group takes the admins as members; the privilege option
  // (mica-sudo) and micad's switch decide what that group may do.
  test('add-login makes or keeps an account, an admin with --admin and none without', () => {
    const c = newCase('login-admin')
    writeFileSync(join(c.etc, 'group'), `${IMAGE_GROUP}mica-admins:x:982:\n`)
    const admins = (): string => read(join(c.run, 'group')).split('\n').find(line => line.startsWith('mica-admins:'))!
    expect(accounts(c, 'add-login', 'alice', '--admin')).toEqual({ code: 0, out: '20000\n' })
    expect(accounts(c, 'add-login', 'bob')).toEqual({ code: 0, out: '20001\n' })
    expect(admins()).toBe('mica-admins:x:982:alice')
    expect(read(join(c.state, 'admins'))).toBe('alice\n')
    expect(accounts(c, 'list-login').out).toBe('alice\t20000\tyes\nbob\t20001\tno\n')
    // Both directions on a kept account, each idempotent, the uid unchanged.
    expect(accounts(c, 'add-login', 'bob', '--admin')).toEqual({ code: 0, out: '20001\n' })
    expect(accounts(c, 'add-login', 'bob', '--admin')).toEqual({ code: 0, out: '20001\n' })
    expect(admins()).toBe('mica-admins:x:982:alice,bob')
    expect(accounts(c, 'add-login', 'alice')).toEqual({ code: 0, out: '20000\n' })
    expect(accounts(c, 'add-login', 'alice')).toEqual({ code: 0, out: '20000\n' })
    expect(admins()).toBe('mica-admins:x:982:bob')
    expect(read(join(c.state, 'admins'))).toBe('bob\n')
    // Gone with the account.
    expect(accounts(c, 'remove-login', 'bob').code).toBe(0)
    expect(admins()).toBe('mica-admins:x:982:')
    expect(read(join(c.state, 'admins'))).toBe('')
    // A name in admins that is no login account makes no member.
    accounts(c, 'add', 'svc-web', '30000')
    writeFileSync(join(c.state, 'admins'), 'svc-web\nmica\nghost\n')
    accounts(c, 'build')
    expect(admins()).toBe('mica-admins:x:982:')
    for (const args of [['add-login', 'carol', '--root'], ['add-login', 'carol', '--admin', 'x'], ['set-login-admin', 'alice']])
      expect(accounts(c, ...args).code).toBe(2)
  })

  test('a build skips a login line of another shape, and every bad argument is a usage error', () => {
    const c = newCase('login-corrupt')
    mkdirSync(c.state)
    writeFileSync(join(c.state, 'passwd'), [
      LOGIN('alice', 20000).trim(),
      'bob:x:20001:20002:mica login bob:/home/bob:/bin/sh',
      'carl:x:20003:20003:mica login carl:/root:/bin/sh',
      'dora:x:20004:20004:mica login dora:/home/dora:/bin/bash',
      'sshd:x:20005:20005:mica login sshd:/home/sshd:/bin/sh',
      '',
    ].join('\n'))
    const ran = accounts(c, 'build')
    expect(ran.out.split('\n').filter(line => line.startsWith('mica-accounts: skipping passwd line'))).toHaveLength(4)
    expect(read(join(c.run, 'passwd'))).toBe(IMAGE_PASSWD + LOGIN('alice', 20000))
    for (const args of [['add-login'], ['add-login', 'a', 'b'], ['remove-login'], ['list-login', 'x']])
      expect(accounts(c, ...args).code).toBe(2)
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
