// Access: /etc/shadow built in RAM (payload/usr/lib/mica/mica-shadow-reconcile),
// dropbear.service's prestart (debs/mica-ssh/mica-dropbear-prestart) and
// mica-sshd.service's, mica-ssh's and mica-openssh's, with the static half of
// their contract.
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
  const script = join(REPO, 'debs/mica-ssh/mica-dropbear-prestart')
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

describe('the dropbear contract in mica-ssh', () => {
  const unit = readFileSync(join(REPO, 'debs/mica-ssh/dropbear.service'), 'utf8').split('\n')

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
    expect(readFileSync(join(REPO, 'debs/mica-ssh/mica-dropbear-prestart'), 'utf8')).toContain('state=${MICA_SSH_STATE:-/mnt/data/state/ssh}')
  })

  test('the postinst refuses an enabled dropbear.service, and no OpenSSH is in the floor', () => {
    const postinst = readFileSync(join(REPO, 'debs/mica-ssh/postinst'), 'utf8')
    expect(postinst).toContain('LINK=/etc/systemd/system/multi-user.target.wants/dropbear.service')
    expect(postinst).not.toContain('multi-user.target.wants/mica-sshd.service')
    expect(existsSync(join(PAYLOAD, 'etc/ssh'))).toBe(false)
    expect(existsSync(join(PAYLOAD, 'etc/systemd/system/etc-ssh.mount'))).toBe(false)
  })
})

// micad's saved /var/lib/mica/ssh/sshd.env, whichever server the product carries.
const SSHD_ENV = { SSH_LISTEN: '22', SSH_PASSWORD: 'no', SSH_ROOT_LOGIN: 'yes' }
// A transient root password's marker, as micad writes it beside the shadow file.
const MARKER = join(box.dir, 'transient-root-password')
writeFileSync(MARKER, '$2b$12$hash\n')
const BAD_ENVS: Record<string, string>[] = [
  {},
  { ...SSHD_ENV, SSH_LISTEN: '' },
  { ...SSHD_ENV, SSH_LISTEN: '22;reboot' },
  { ...SSHD_ENV, SSH_LISTEN: '192.0.2.5' },
  { ...SSHD_ENV, SSH_LISTEN: 'host.example:22' },
  { ...SSHD_ENV, SSH_LISTEN: '[2001:db8::5]' },
  { ...SSHD_ENV, SSH_PASSWORD: 'maybe' },
  { ...SSHD_ENV, SSH_ROOT_LOGIN: '' },
]

describe('mica-sshd-prestart of mica-ssh (dropbear)', () => {
  const bin = join(box.dir, 'sshd-dropbear-bin')
  const trace = join(box.dir, 'sshd-dropbear-trace')
  fake(bin, 'dropbearkey', 'printf \'dropbearkey %s\\n\' "$*" >>"$MICA_TEST_TRACE"\n[ ! -e "$4" ] || exit 1\nprintf \'generated %s\\n\' "$2" >"$4"\nprintf \'public\\n\' >"$4.pub"')
  const script = join(box.dir, 'mica-sshd-prestart.dropbear')
  writeFileSync(script, readFileSync(join(REPO, 'debs/mica-ssh/mica-sshd-prestart'), 'utf8').replace('/usr/lib/mica/mica-dropbear-prestart', join(REPO, 'debs/mica-ssh/mica-dropbear-prestart')))
  const newCase = (name: string): { state: string, out: string } => {
    const state = join(box.dir, 'sshd-dropbear', name, 'ssh')
    mkdirSync(state, { recursive: true })
    chmodSync(state, 0o700)
    writeFileSync(trace, '')
    return { state, out: join(state, '..', 'sshd-dropbear.env') }
  }
  const prestart = (c: { state: string, out: string }, env: Record<string, string>): number =>
    exec(['sh', script], { PATH: `${bin}:${SYSTEM_PATH}`, MICA_TEST_TRACE: trace, MICA_SSH_OWNER: String(process.getuid?.() ?? 0), MICA_SSH_STATE: c.state, MICA_SSHD_DROPBEAR_ENV: c.out, MICA_SSH_TRANSIENT_MARKER: join(box.dir, 'no-marker'), ...env }).code

  test('translates the settings into dropbear\'s arguments and makes the dropbear key', () => {
    const c = newCase('every-address')
    expect(prestart(c, SSHD_ENV)).toBe(0)
    expect(readFileSync(c.out, 'utf8')).toBe('DROPBEAR_ARGS="-p 22 -s"\n')
    expect(readFileSync(join(c.state, 'dropbear_ed25519_host_key'), 'utf8')).toBe('generated ed25519\n')
    expect(prestart(c, { SSH_LISTEN: '192.0.2.5:22 [2001:db8::5]:2222', SSH_PASSWORD: 'yes', SSH_ROOT_LOGIN: 'no', MICA_SSH_TRANSIENT_MARKER: MARKER })).toBe(0)
    expect(readFileSync(c.out, 'utf8')).toBe('DROPBEAR_ARGS="-p 192.0.2.5:22 -p [2001:db8::5]:2222 -w"\n')
    expect(readFileSync(trace, 'utf8').split('\n').filter(Boolean)).toHaveLength(1)
  })

  // The saved settings outlive the boot; the transient password does not.
  test('turns password logins off when no transient root password is set', () => {
    const c = newCase('no-transient')
    expect(prestart(c, { ...SSHD_ENV, SSH_PASSWORD: 'yes' })).toBe(0)
    expect(readFileSync(c.out, 'utf8')).toBe('DROPBEAR_ARGS="-p 22 -s"\n')
    writeFileSync(join(box.dir, 'empty-marker'), '')
    expect(prestart(c, { ...SSHD_ENV, SSH_PASSWORD: 'yes', MICA_SSH_TRANSIENT_MARKER: join(box.dir, 'empty-marker') })).toBe(0)
    expect(readFileSync(c.out, 'utf8')).toBe('DROPBEAR_ARGS="-p 22 -s"\n')
  })

  test('refuses settings that are not micad\'s, before making a key', () => {
    for (const env of BAD_ENVS) {
      const c = newCase('refused')
      rmSync(c.out, { force: true })
      expect(prestart(c, env)).not.toBe(0)
      expect(existsSync(c.out)).toBe(false)
      expect(readdirSync(c.state)).toEqual([])
    }
  })
})

describe('mica-sshd-prestart of mica-openssh', () => {
  const script = join(REPO, 'debs/mica-openssh/mica-sshd-prestart')
  const bin = join(box.dir, 'openssh-bin')
  const trace = join(box.dir, 'openssh-trace')
  // ssh-keygen writes the key and <file>.pub, and refuses an existing file; sshd -t
  // fails on demand.
  fake(bin, 'ssh-keygen', 'printf \'ssh-keygen %s\\n\' "$*" >>"$MICA_TEST_TRACE"\nfor key; do :; done\n[ ! -e "$key" ] || exit 1\nprintf \'generated ed25519\\n\' >"$key"\nprintf \'public\\n\' >"$key.pub"')
  fake(bin, 'sshd', 'printf \'sshd %s\\n\' "$*" >>"$MICA_TEST_TRACE"\n[ -z "${MICA_TEST_SSHD_FAIL:-}" ]')
  const newCase = (name: string): { state: string, key: string, config: string } => {
    const state = join(box.dir, 'openssh', name, 'ssh')
    mkdirSync(state, { recursive: true })
    chmodSync(state, 0o700)
    writeFileSync(trace, '')
    return { state, key: join(state, 'ssh_host_ed25519_key'), config: join(state, '..', 'sshd_config') }
  }
  const prestart = (c: { state: string, config: string }, env: Record<string, string>): number =>
    exec(['sh', script], { PATH: `${bin}:${SYSTEM_PATH}`, MICA_TEST_TRACE: trace, MICA_SSH_OWNER: String(process.getuid?.() ?? 0), MICA_SSH_STATE: c.state, MICA_SSHD_CONFIG: c.config, MICA_SSH_TRANSIENT_MARKER: join(box.dir, 'no-marker'), ...env }).code
  const rendered = (c: { key: string }, listen: string[], password: string, root: string): string => [
    '# Rendered by /usr/lib/mica/mica-sshd-prestart from /var/lib/mica/ssh/sshd.env.',
    ...listen.map(listener => `ListenAddress ${listener}`),
    `HostKey ${c.key}`,
    `PasswordAuthentication ${password}`,
    `PermitRootLogin ${root}`,
    'KbdInteractiveAuthentication no',
    'PubkeyAuthentication yes',
    'AuthorizedKeysFile .ssh/authorized_keys',
    'StrictModes yes',
    'UsePAM no',
    'UseDNS no',
    'X11Forwarding no',
    'PrintMotd no',
    'PrintLastLog no',
    'PidFile none',
    'KexAlgorithms -diffie-hellman-group-exchange-sha1,diffie-hellman-group-exchange-sha256',
    'Subsystem sftp /usr/lib/sftp-server',
    '',
  ].join('\n')

  test('renders sshd_config from the settings, checked by sshd -t, with no PAM', () => {
    const c = newCase('render')
    expect(prestart(c, SSHD_ENV)).toBe(0)
    expect(readFileSync(c.config, 'utf8')).toBe(rendered(c, ['0.0.0.0:22', '[::]:22'], 'no', 'yes'))
    expect(readFileSync(trace, 'utf8')).toContain(`sshd -t -f ${c.config}.new\n`)
    expect(prestart(c, { SSH_LISTEN: '192.0.2.5:22 [2001:db8::5]:2222', SSH_PASSWORD: 'yes', SSH_ROOT_LOGIN: 'no', MICA_SSH_TRANSIENT_MARKER: MARKER })).toBe(0)
    expect(readFileSync(c.config, 'utf8')).toBe(rendered(c, ['192.0.2.5:22', '[2001:db8::5]:2222'], 'yes', 'no'))
  })

  test('turns password logins off when no transient root password is set', () => {
    const c = newCase('no-transient')
    expect(prestart(c, { ...SSHD_ENV, SSH_PASSWORD: 'yes' })).toBe(0)
    expect(readFileSync(c.config, 'utf8')).toBe(rendered(c, ['0.0.0.0:22', '[::]:22'], 'no', 'yes'))
  })

  test('the first start generates an owner-only ed25519 key on STATE, and later starts keep it', () => {
    const c = newCase('key')
    expect(prestart(c, SSHD_ENV)).toBe(0)
    expect(readFileSync(c.key, 'utf8')).toBe('generated ed25519\n')
    expect(mode(c.key)).toBe('600')
    expect(readdirSync(c.state)).toEqual(['ssh_host_ed25519_key'])
    expect(readFileSync(trace, 'utf8')).toContain(`ssh-keygen -q -t ed25519 -N  -C  -f ${c.key}.new\n`)
    writeFileSync(trace, '')
    expect(prestart(c, SSHD_ENV)).toBe(0)
    expect(readFileSync(c.key, 'utf8')).toBe('generated ed25519\n')
    expect(readFileSync(trace, 'utf8')).not.toContain('ssh-keygen')
  })

  test('refuses STATE and keys another user could have planted or read', () => {
    const writable = newCase('writable-dir')
    chmodSync(writable.state, 0o777)
    expect(prestart(writable, SSHD_ENV)).not.toBe(0)
    expect(existsSync(writable.key)).toBe(false)
    const readable = newCase('readable-key')
    writeFileSync(readable.key, 'mine\n', { mode: 0o644 })
    chmodSync(readable.key, 0o644)
    expect(prestart(readable, SSHD_ENV)).not.toBe(0)
    const linked = newCase('symlink-key')
    writeFileSync(join(linked.state, '..', 'elsewhere'), 'elsewhere\n')
    symlinkSync(join(linked.state, '..', 'elsewhere'), linked.key)
    expect(prestart(linked, SSHD_ENV)).not.toBe(0)
    expect(existsSync(linked.config)).toBe(false)
  })

  test('a configuration sshd refuses leaves the last one in place', () => {
    const c = newCase('sshd-refuses')
    expect(prestart(c, SSHD_ENV)).toBe(0)
    const before = readFileSync(c.config, 'utf8')
    expect(prestart(c, { ...SSHD_ENV, SSH_PASSWORD: 'yes', MICA_SSH_TRANSIENT_MARKER: MARKER, MICA_TEST_SSHD_FAIL: '1' })).not.toBe(0)
    expect(readFileSync(c.config, 'utf8')).toBe(before)
    expect(existsSync(`${c.config}.new`)).toBe(false)
  })

  test('refuses settings that are not micad\'s, before making a key', () => {
    for (const env of BAD_ENVS) {
      const c = newCase('refused')
      expect(prestart(c, env)).not.toBe(0)
      expect(readdirSync(c.state)).toEqual([])
      expect(existsSync(c.config)).toBe(false)
    }
  })
})

// One service, two servers: micad drives mica-sshd whichever the product carries,
// and the init starts it at boot from micad's saved settings, without micad.
describe.each(['mica-ssh', 'mica-openssh'])('the mica-sshd contract in %s', (name) => {
  const directory = join(REPO, 'debs', name)
  const unit = readFileSync(join(directory, 'mica-sshd.service'), 'utf8').split('\n')
  const openrc = readFileSync(join(directory, 'mica-sshd.openrc'), 'utf8')
  const dockerfile = readFileSync(join(directory, 'Dockerfile'), 'utf8')

  test('the unit starts at boot on micad\'s saved settings, after the shadow file and DATA, keeps sessions and logs as mica-sshd', () => {
    for (const line of [
      'EnvironmentFile=-/var/lib/mica/ssh/sshd.env',
      'ExecCondition=/bin/sh -c \'test "${SSH_ENABLED}" = yes\'',
      'ExecStartPre=/usr/lib/mica/mica-sshd-prestart',
      'Requires=mica-shadow-reconcile.service',
      'RequiresMountsFor=/mnt/data/state /var/lib/mica',
      'SyslogIdentifier=mica-sshd',
      'KillMode=process',
      'WantedBy=multi-user.target',
    ])
      expect(unit).toContain(line)
    expect(unit.some(line => /^After=.*\bmica-shadow-reconcile\.service\b/.test(line))).toBe(true)
    expect(unit.some(line => line.includes('/run/mica/sshd.env'))).toBe(false)
    expect(readFileSync(join(directory, '50-mica-sshd.preset'), 'utf8')).toBe('enable mica-sshd.service\n')
    expect(dockerfile).toContain('ln -s /etc/systemd/system/mica-sshd.service /stage/etc/systemd/system/multi-user.target.wants/mica-sshd.service;')
  })

  test('the OpenRC service reads the same settings, refuses to start while SSH is off, runs the same prestart and logs as mica-sshd', () => {
    for (const text of ['. /var/lib/mica/ssh/sshd.env', 'if [ "$SSH_ENABLED" != yes ]; then', '/usr/lib/mica/mica-sshd-prestart', 'need mica-mounts mica-shadow-reconcile', 'error_logger="busybox logger -t mica-sshd"', 'supervisor=supervise-daemon'])
      expect(openrc).toContain(text)
    expect(openrc).not.toContain('/run/mica/sshd.env')
  })

  test('mica-sshd-boot, in the default runlevel, is the same script in both packages', () => {
    expect(readFileSync(join(directory, 'mica-sshd-boot.openrc'), 'utf8')).toBe(readFileSync(join(REPO, 'debs/mica-ssh/mica-sshd-boot.openrc'), 'utf8'))
    expect(dockerfile).toContain('install -D -m 0755 /in/ssh/mica-sshd-boot.openrc /stage/etc/init.d/mica-sshd-boot;')
    expect(dockerfile).toContain('ln -s /etc/init.d/mica-sshd-boot /stage/etc/runlevels/default/mica-sshd-boot;')
  })
})

// mica-sshd-boot's start(), run by sh with OpenRC's helpers faked.
describe('mica-sshd-boot', () => {
  const bin = join(box.dir, 'sshd-boot-bin')
  const trace = join(box.dir, 'sshd-boot-trace')
  const settings = join(box.dir, 'sshd-boot', 'sshd.env')
  mkdirSync(join(box.dir, 'sshd-boot'), { recursive: true })
  fake(bin, 'rc-service', 'printf \'rc-service %s\\n\' "$*" >>"$MICA_TEST_TRACE"')
  const script = join(box.dir, 'mica-sshd-boot')
  writeFileSync(script, readFileSync(join(REPO, 'debs/mica-ssh/mica-sshd-boot.openrc'), 'utf8').replaceAll('/var/lib/mica/ssh/sshd.env', settings))
  const start = (): { code: number, calls: string } => {
    writeFileSync(trace, '')
    const { code } = exec(['sh', '-c', `einfo() { :; }; . ${script}; start`], { PATH: `${bin}:${SYSTEM_PATH}`, MICA_TEST_TRACE: trace })
    return { code, calls: readFileSync(trace, 'utf8') }
  }

  test('starts mica-sshd when the saved settings turn SSH on', () => {
    writeFileSync(settings, 'SSH_ENABLED=yes\nSSH_LISTEN="22"\nSSH_PASSWORD=no\nSSH_ROOT_LOGIN=yes\n')
    expect(start()).toEqual({ code: 0, calls: 'rc-service mica-sshd start\n' })
  })

  test('starts nothing, and does not fail, when SSH is off or was never configured', () => {
    writeFileSync(settings, 'SSH_ENABLED=no\nSSH_LISTEN="22"\nSSH_PASSWORD=no\nSSH_ROOT_LOGIN=yes\n')
    expect(start()).toEqual({ code: 0, calls: '' })
    rmSync(settings)
    expect(start()).toEqual({ code: 0, calls: '' })
  })
})

describe('the servers behind mica-sshd', () => {
  test('dropbear starts with the arguments mica-ssh\'s prestart writes', () => {
    const unit = readFileSync(join(REPO, 'debs/mica-ssh/mica-sshd.service'), 'utf8').split('\n')
    expect(unit).toContain('EnvironmentFile=-/run/mica/sshd-dropbear.env')
    expect(unit).toContain('ExecStart=/usr/sbin/dropbear -F -E -r /mnt/data/state/ssh/dropbear_ed25519_host_key $DROPBEAR_ARGS')
  })

  test('sshd starts on the rendered configuration, with its privilege separation directory', () => {
    const unit = readFileSync(join(REPO, 'debs/mica-openssh/mica-sshd.service'), 'utf8').split('\n')
    for (const line of ['ExecStart=/usr/sbin/sshd -D -e -f /run/mica/sshd_config', 'RuntimeDirectory=sshd', 'RuntimeDirectoryMode=0755'])
      expect(unit).toContain(line)
    const openrc = readFileSync(join(REPO, 'debs/mica-openssh/mica-sshd.openrc'), 'utf8')
    expect(openrc).toContain('command_args="-D -e -f /run/mica/sshd_config"')
    expect(openrc).toContain('checkpath -d -m 0755 -o root:root /run/sshd')
  })
})
