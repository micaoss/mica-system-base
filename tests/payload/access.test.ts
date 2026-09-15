// Access: /etc/shadow built in RAM (payload/usr/lib/mica/mica-shadow-reconcile)
// and dropbear.service's prestart (payload/usr/lib/mica/mica-dropbear-prestart)
// with the static half of the dropbear contract.
import { chmodSync, chownSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { REPO } from '../fixture.ts'
import { exec, fake, MICA, PAYLOAD, sandbox, SYSTEM_PATH } from './harness.ts'

const box = sandbox('access')
afterAll(box.done)

const mode = (path: string): string => (statSync(path).mode & 0o7777).toString(8)
const ROOT = process.getuid?.() === 0

describe('mica-shadow-reconcile', () => {
  // A bcrypt hash of the shape micad writes, and one micad did NOT write -- set by
  // hand over the serial console. Opaque: the script never parses them.
  const MICA_HASH = '$2b$12$abcdefghijklmnopqrstuvOJqM0iZ5wKzXwZ2G8bqZ0aVjPQnDGa'
  const DEV_HASH = '$2b$12$ZZZZZZZZZZZZZZZZZZZZZuOJqM0iZ5wKzXwZ2G8bqZ0aVjPQnDGa'
  const PASSWD_BOTH = 'root:x:0:0:root:/root:/bin/sh\ndaemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin\n'
  const PASSWD_DAEMON_ONLY = 'daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin\n'
  const PASSWD_WITH_NEW = `${PASSWD_BOTH}newsvc:x:990:990:new service:/nonexistent:/usr/sbin/nologin\n`
  const FACTORY = 'root:!:19000:0:99999:7:::\ndaemon:*:19000:0:99999:7:::\n'
  const shadowWith = (hash: string): string => `root:${hash}:19000:0:99999:7:::\ndaemon:*:19000:0:99999:7:::\n`

  // chgrp shadow needs privilege; without it a fake chgrp is put first on PATH
  // and the group assertion is skipped.
  const fakebin = join(box.dir, 'shadow-fakebin')
  const realGroup = exec(['sh', '-c', `: > "$1" && chgrp shadow "$1"`, 'probe', join(box.dir, 'probe')], { PATH: SYSTEM_PATH }).code === 0
  if (!realGroup)
    fake(fakebin, 'chgrp', 'exit 0')

  interface Case { state: string, shadow: string, passwd: string, factory: string }
  const newCase = (name: string, shadow: string, passwd = PASSWD_BOTH, factory = FACTORY): Case => {
    const dir = join(box.dir, 'shadow', name)
    rmSync(dir, { recursive: true, force: true })
    const c = { state: join(dir, 'state'), shadow: join(dir, 'state/shadow'), passwd: join(dir, 'passwd'), factory: join(dir, 'factory') }
    mkdirSync(c.state, { recursive: true })
    writeFileSync(c.shadow, `${shadow.replace(/\n+$/, '')}\n`)
    chmodSync(c.shadow, 0o640)
    writeFileSync(c.passwd, passwd)
    writeFileSync(c.factory, factory)
    return c
  }
  const reconcile = (c: Case): number => exec(['sh', join(MICA, 'mica-shadow-reconcile'), c.shadow], { PATH: `${fakebin}:${SYSTEM_PATH}`, MICA_SHADOW_PASSWD: c.passwd, MICA_SHADOW_FACTORY: c.factory }).code
  const lines = (c: Case): string[] => readFileSync(c.shadow, 'utf8').split('\n').filter(Boolean)
  const hashOf = (c: Case, user: string): string => lines(c).find(line => line.split(':')[0] === user)?.split(':')[1] ?? '(none)'
  const wellFormed = (c: Case): boolean => lines(c).every(line => line.split(':').length === 9)

  test('the file is built from the factory copy, every entry locked', () => {
    const c = newCase('build-from-factory', '')
    expect(reconcile(c)).toBe(0)
    expect(hashOf(c, 'root')).toBe('!')
    expect(wellFormed(c)).toBe(true)
    expect(readFileSync(c.shadow, 'utf8').endsWith('\n')).toBe(true)
    expect(mode(c.shadow)).toBe('640')
    if (realGroup)
      expect(exec(['stat', '-c', '%G', c.shadow], { PATH: SYSTEM_PATH }).out.trim()).toBe('shadow')
  })

  // The security property: a password survives only if the rebuild does not
  // happen, and then there is no shadow file at all and a login fails closed.
  test('no password survives a run, whoever set it', () => {
    for (const hash of [MICA_HASH, DEV_HASH]) {
      const c = newCase(`password-${hash.slice(7, 9)}`, shadowWith(hash))
      expect(hashOf(c, 'root')).toBe(hash)
      expect(reconcile(c)).toBe(0)
      expect(hashOf(c, 'root')).toBe('!')
      expect(readFileSync(c.shadow, 'utf8')).not.toContain(hash)
    }
  })

  test('an account in passwd with no factory entry is appended, locked', () => {
    const c = newCase('appends-new-account', '', PASSWD_WITH_NEW)
    expect(reconcile(c)).toBe(0)
    expect(hashOf(c, 'newsvc')).toBe('!')
    expect(wellFormed(c)).toBe(true)
  })

  // The factory copy is the image's statement about its own accounts.
  test('an account only the factory names is kept', () => {
    const c = newCase('keeps-factory-only-account', '', PASSWD_DAEMON_ONLY)
    expect(reconcile(c)).toBe(0)
    expect(hashOf(c, 'root')).toBe('!')
  })

  test('a second run is byte-identical and leaves no temporary file', () => {
    const c = newCase('idempotent', '')
    reconcile(c)
    const first = readFileSync(c.shadow, 'utf8')
    reconcile(c)
    expect(readFileSync(c.shadow, 'utf8')).toBe(first)
    expect(readdirSync(c.state).filter(name => name.startsWith('shadow.'))).toEqual([])
  })

  test('missing inputs fail loudly', () => {
    const noPasswd = newCase('missing-passwd', '')
    rmSync(noPasswd.passwd)
    expect(reconcile(noPasswd)).not.toBe(0)
    const noFactory = newCase('missing-factory', '')
    rmSync(noFactory.factory)
    expect(reconcile(noFactory)).not.toBe(0)
  })

  // An unterminated last line would glue two entries together on append.
  test('an unterminated factory copy still yields whole lines', () => {
    const c = newCase('unterminated-factory', '', PASSWD_BOTH, 'root:!:19000:0:99999:7:::\ndaemon:*:19000:0:99999:7:::')
    expect(reconcile(c)).toBe(0)
    expect(wellFormed(c)).toBe(true)
    expect(readFileSync(c.shadow, 'utf8').endsWith('\n')).toBe(true)
    expect(hashOf(c, 'daemon')).not.toBe('(none)')
  })

  // /run/mica does not exist on a fresh boot: /run is an empty tmpfs.
  test('the destination directory is created when absent', () => {
    const c = newCase('creates-its-directory', '')
    rmSync(c.state, { recursive: true, force: true })
    expect(reconcile(c)).toBe(0)
    expect(existsSync(c.shadow)).toBe(true)
    expect(hashOf(c, 'root')).toBe('!')
  })
})

describe('mica-dropbear-prestart', () => {
  const script = join(MICA, 'mica-dropbear-prestart')
  const bin = join(box.dir, 'dropbear-bin')
  const trace = join(box.dir, 'dropbear-trace')
  // The fakes refuse an existing output file and write <file>.pub beside the key,
  // as dropbear-bin 2025.89's dropbearkey does, and fail on demand.
  fake(bin, 'dropbearkey', 'printf \'dropbearkey %s\\n\' "$*" >>"$MICA_TEST_TRACE"\n[ -z "${MICA_TEST_KEYGEN_FAIL:-}" ] || { : >"$4"; exit 1; }\n[ ! -e "$4" ] || exit 1\nprintf \'generated %s\\n\' "$2" >"$4"\nprintf \'public\\n\' >"$4.pub"')
  fake(bin, 'dropbearconvert', 'printf \'dropbearconvert %s\\n\' "$*" >>"$MICA_TEST_TRACE"\nprintf \'converted %s\\n\' "$(cat "$3")" >"$4"')
  const ARGS = '-p 192.0.2.1:22 -s -w'

  const newCase = (name: string): { state: string, key: string } => {
    const state = join(box.dir, 'dropbear', name, 'ssh')
    mkdirSync(state, { recursive: true })
    chmodSync(state, 0o700)
    writeFileSync(trace, '')
    return { state, key: join(state, 'dropbear_ed25519_host_key') }
  }
  const prestart = (state: string, env: Record<string, string> = { DROPBEAR_ARGS: ARGS }): number =>
    exec([script], { PATH: `${bin}:${SYSTEM_PATH}`, MICA_TEST_TRACE: trace, MICA_SSH_OWNER: String(process.getuid?.() ?? 0), MICA_SSH_STATE: state, ...env }).code
  const tool = (name: string): number => readFileSync(trace, 'utf8').split('\n').filter(line => line.startsWith(name)).length

  test('the first start generates an owner-only key on STATE, and later starts keep it', () => {
    const { state, key } = newCase('fresh')
    expect(prestart(state)).toBe(0)
    expect(readFileSync(key, 'utf8')).toBe('generated ed25519\n')
    expect(mode(key)).toBe('600')
    expect(readdirSync(state)).toEqual(['dropbear_ed25519_host_key'])
    writeFileSync(trace, '')
    expect(prestart(state)).toBe(0)
    expect(readFileSync(key, 'utf8')).toBe('generated ed25519\n')
    expect(readFileSync(trace, 'utf8')).toBe('')
  })

  test('only the dropbear key counts: any other file on STATE is left alone and a key is generated', () => {
    const { state, key } = newCase('other-key')
    writeFileSync(join(state, 'ssh_host_ed25519_key'), 'other-key\n', { mode: 0o644 })
    expect(prestart(state)).toBe(0)
    expect(readFileSync(key, 'utf8')).toBe('generated ed25519\n')
    expect(tool('dropbearconvert')).toBe(0)
    expect(readFileSync(join(state, 'ssh_host_ed25519_key'), 'utf8')).toBe('other-key\n')
  })

  test('an interrupted first start does not block, and a failed one leaves no key', () => {
    const interrupted = newCase('interrupted')
    writeFileSync(`${interrupted.key}.new`, 'partial')
    writeFileSync(`${interrupted.key}.new.pub`, 'partial')
    expect(prestart(interrupted.state)).toBe(0)
    expect(readFileSync(interrupted.key, 'utf8')).toBe('generated ed25519\n')
    expect(readdirSync(interrupted.state)).toEqual(['dropbear_ed25519_host_key'])

    const failed = newCase('keygen-fails')
    expect(prestart(failed.state, { DROPBEAR_ARGS: ARGS, MICA_TEST_KEYGEN_FAIL: '1' })).not.toBe(0)
    expect(existsSync(failed.key)).toBe(false)
  })

  test('refuses STATE and keys another user could have planted or read', () => {
    const missing = newCase('no-state')
    rmSync(missing.state, { recursive: true })
    expect(prestart(missing.state)).not.toBe(0)
    expect(existsSync(missing.state)).toBe(false)

    const linkedDir = newCase('symlink-dir')
    const real = join(linkedDir.state, '..', 'real')
    mkdirSync(real)
    rmSync(linkedDir.state, { recursive: true })
    symlinkSync(real, linkedDir.state)
    expect(prestart(linkedDir.state)).not.toBe(0)
    expect(readdirSync(real)).toEqual([])

    const writable = newCase('writable-dir')
    chmodSync(writable.state, 0o777)
    expect(prestart(writable.state)).not.toBe(0)
    expect(existsSync(writable.key)).toBe(false)

    const linkedKey = newCase('symlink-key')
    const elsewhere = join(linkedKey.state, '..', 'elsewhere')
    writeFileSync(elsewhere, 'elsewhere\n')
    symlinkSync(elsewhere, linkedKey.key)
    expect(prestart(linkedKey.state)).not.toBe(0)
    expect(readFileSync(elsewhere, 'utf8')).toBe('elsewhere\n')

    const readable = newCase('readable-key')
    writeFileSync(readable.key, 'mine\n', { mode: 0o644 })
    chmodSync(readable.key, 0o644)
    expect(prestart(readable.state)).not.toBe(0)
    expect(readFileSync(readable.key, 'utf8')).toBe('mine\n')
  })

  test.if(ROOT)('refuses a STATE directory or key owned by another uid', () => {
    const dir = newCase('foreign-owner')
    chownSync(dir.state, 4242, 4242)
    expect(prestart(dir.state)).not.toBe(0)
    const key = newCase('foreign-key')
    writeFileSync(key.key, 'theirs\n', { mode: 0o600 })
    chownSync(key.key, 4242, 4242)
    expect(prestart(key.state)).not.toBe(0)
  })

  // dropbear with no -p listens on port 22 on every address.
  test('refuses arguments that name no listener, before making a key', () => {
    const { state, key } = newCase('no-args')
    expect(prestart(state, {})).not.toBe(0)
    expect(prestart(state, { DROPBEAR_ARGS: '-s -w' })).not.toBe(0)
    expect(existsSync(key)).toBe(false)
  })
})

describe('the dropbear contract in the payload and the package', () => {
  const unit = readFileSync(join(PAYLOAD, 'etc/systemd/system/dropbear.service'), 'utf8').split('\n')
  const control = readFileSync(join(REPO, 'debs/mica-system/control'), 'utf8')

  test('the unit needs its arguments, the shadow file and STATE, and keeps sessions', () => {
    for (const line of [
      'EnvironmentFile=/run/mica/dropbear.env',
      'ExecStartPre=/usr/lib/mica/mica-dropbear-prestart',
      'ExecStart=/usr/sbin/dropbear -F -E -r /mnt/data/state/ssh/dropbear_ed25519_host_key $DROPBEAR_ARGS',
      'Requires=mica-shadow-reconcile.service',
      'RequiresMountsFor=/mnt/data/state',
      'KillMode=process',
    ])
      expect(unit).toContain(line)
    expect(unit.some(line => /^After=.*\bmica-shadow-reconcile\.service\b/.test(line))).toBe(true)
    // -R writes the compiled-in /etc/dropbear paths, on the read-only root.
    expect(unit.some(line => /\s-R(?:\s|$)/.test(line))).toBe(false)
    expect(readFileSync(join(MICA, 'mica-dropbear-prestart'), 'utf8')).toContain('state=${MICA_SSH_STATE:-/mnt/data/state/ssh}')
  })

  test('the postinst refuses the link, and no OpenSSH remains in the base', () => {
    expect(readFileSync(join(REPO, 'debs/mica-system/postinst'), 'utf8')).toMatch(/^DROPBEAR_LINK=\/etc\/systemd\/system\/multi-user\.target\.wants\/dropbear\.service$/m)
    expect(existsSync(join(PAYLOAD, 'etc/ssh'))).toBe(false)
    expect(existsSync(join(PAYLOAD, 'etc/systemd/system/etc-ssh.mount'))).toBe(false)
    const depends = /^Depends: (.*)$/m.exec(control)?.[1] ?? ''
    expect(depends.split(', ')).toContain('dropbear-bin')
    expect(depends).not.toMatch(/openssh/)
  })
})
