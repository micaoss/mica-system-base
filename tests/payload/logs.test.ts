// The log settings: mica-log-env's parsing and refusals and its default cap from DATA's
// capacity; what each init makes of them -- mica-openrc's syslogd arguments and logread,
// mica-systemd's mica-log-settings against a fake systemctl and journalctl.
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { exec, fake, MICA, PAYLOAD, sandbox, SYSTEM_PATH, SYSTEMD_PAYLOAD } from './harness.ts'

const OPENRC = resolve(import.meta.dir, '../../debs/mica-openrc/payload')
const UBI = resolve(import.meta.dir, '../../debs/mica-storage-ubi/payload')
const box = sandbox('logs')
afterAll(box.done)

// mica-log-env with the image's defaults, a drop-in directory and micad's file in the
// sandbox, and DATA at `data` (a missing one: the smallest DATA).
const dropins = join(box.dir, 'log.d')
const settings = join(box.dir, 'log.env')
const env = (data = join(box.dir, 'no-data')): Record<string, string> => ({
  PATH: SYSTEM_PATH,
  MICA_LOG_DEFAULTS: join(PAYLOAD, 'usr/lib/mica/log/log.env'),
  MICA_LOG_DROPINS: dropins,
  MICA_LOG_SETTINGS: settings,
  MICA_DATA_ROOT: data,
})
const logEnv = (lines: string[] | undefined, data?: string): { code: number, out: string } => {
  rmSync(settings, { force: true })
  if (lines)
    writeFileSync(settings, lines.join('\n'))
  return exec(['sh', join(MICA, 'mica-log-env')], env(data))
}
const assignments = (persistent: string, max: number, remote = '', protocol = 'udp', largest = 16384): string =>
  `LOG_PERSISTENT=${persistent}\nLOG_MAX_KIB=${max}\nLOG_REMOTE=${remote}\nLOG_REMOTE_PROTOCOL=${protocol}\nLOG_MAX_KIB_LIMIT=${largest}\n`
mkdirSync(dropins)

describe('mica-log-env', () => {
  test('the image keeps the log on DATA, capped at a quarter of project 101\'s limit and 32 MiB at most', () => {
    // No DATA: the smallest limit, 32 MiB, and a quarter of it.
    expect(logEnv(undefined)).toEqual({ code: 0, out: assignments('yes', 8192) })
    // A DATA of this host's /: an eighth of it clamped to 32-256 MiB, a quarter of that.
    const [blocks, size] = exec(['stat', '-f', '-c', '%b %S', '/'], { PATH: SYSTEM_PATH }).out.trim().split(' ').map(Number) as [number, number]
    const limit = Math.min(Math.max(Math.floor(blocks * Math.floor(size / 1024) / 8), 32768), 262144)
    expect(logEnv(undefined, '/')).toEqual({ code: 0, out: assignments('yes', Math.min(Math.floor(limit / 4), 32768), '', 'udp', Math.floor(limit / 2)) })
    // The largest cap, half the limit, is printed on a refusal too.
    const refused = logEnv(['LOG_PERSISTENT=maybe'], '/')
    expect(refused.code).toBe(1)
    expect(refused.out.startsWith(assignments('no', Math.min(Math.floor(limit / 4), 32768), '', 'udp', Math.floor(limit / 2)))).toBe(true)
  })

  test('micad\'s file wins over a drop-in, which wins over the image; quotes are taken off', () => {
    writeFileSync(join(dropins, '10-ubi.env'), readFileSync(join(UBI, 'usr/lib/mica/log/log.d/10-ubi.env')))
    expect(logEnv(undefined)).toEqual({ code: 0, out: assignments('no', 8192) })
    expect(logEnv(['# micad', 'LOG_PERSISTENT="yes"', 'LOG_MAX_KIB=4096', 'LOG_REMOTE="192.0.2.10:514"', 'LOG_REMOTE_PROTOCOL=tcp', ''])).toEqual({ code: 0, out: assignments('yes', 4096, '192.0.2.10:514', 'tcp') })
    expect(logEnv(['LOG_REMOTE=[2001:db8::7]:6514'])).toEqual({ code: 0, out: assignments('no', 8192, '[2001:db8::7]:6514') })
    rmSync(join(dropins, '10-ubi.env'))
  })

  test('refuses anything else: the reason, status 1, and the log in RAM with nothing forwarded', () => {
    for (const lines of [
      ['LOG_PERSISTENT=maybe'],
      ['LOG_FOO=1'],
      ['not an assignment'],
      ['LOG_REMOTE=$(reboot):514'],
      ['LOG_REMOTE=collector.example:514'],
      ['LOG_REMOTE=192.0.2.300:514'],
      ['LOG_REMOTE=192.0.2.1:70000'],
      ['LOG_REMOTE=192.0.2.1'],
      ['LOG_REMOTE=[2001:db8::g]:514'],
      ['LOG_REMOTE_PROTOCOL=tls'],
      ['LOG_MAX_KIB=512'],
      ['LOG_MAX_KIB=16385'],
      ['LOG_MAX_KIB=08192'],
      ['LOG_MAX_KIB_LIMIT=262144'],
    ]) {
      const ran = logEnv(lines)
      expect(ran.code).toBe(1)
      expect(ran.out.startsWith(assignments('no', 8192))).toBe(true)
      expect(ran.out).toMatch(/^mica-log-env: .*; the log stays in RAM and nothing is forwarded$/m)
    }
    // Half of the smallest limit is the largest cap.
    expect(logEnv(['LOG_MAX_KIB=16384']).code).toBe(0)
  })
})

// The scripts with mica-log-env and the paths they write moved into the sandbox.
function copy(source: string, name: string, replacements: Record<string, string>): string {
  let text = readFileSync(source, 'utf8').replaceAll('/usr/lib/mica/mica-log-env', join(box.dir, 'mica-log-env'))
  for (const [from, to] of Object.entries(replacements))
    text = text.replaceAll(from, to)
  writeFileSync(join(box.dir, name), text)
  return join(box.dir, name)
}
writeFileSync(join(box.dir, 'mica-log-env'), readFileSync(join(MICA, 'mica-log-env')))
exec(['chmod', '0755', join(box.dir, 'mica-log-env')], { PATH: SYSTEM_PATH })

// Both inits eval mica-log-env's whole output, LOG_MAX_KIB_LIMIT included, under
// set -eu: the cases below run with it, and it changes nothing they do.
test('the inits eval every line mica-log-env prints, the largest cap with them', () => {
  rmSync(settings, { force: true })
  expect(exec(['sh', join(box.dir, 'mica-log-env')], env()).out).toContain('\nLOG_MAX_KIB_LIMIT=16384\n')
  for (const name of [join(OPENRC, 'usr/lib/mica/mica-syslogd-args'), join(SYSTEMD_PAYLOAD, 'usr/lib/mica/mica-log-settings')])
    expect(readFileSync(name, 'utf8')).toContain('eval "$settings"')
})

describe('mica-syslogd-args', () => {
  const script = copy(join(OPENRC, 'usr/lib/mica/mica-syslogd-args'), 'mica-syslogd-args', {})
  const args = (lines?: string[]): { code: number, out: string } => {
    rmSync(settings, { force: true })
    if (lines)
      writeFileSync(settings, lines.join('\n'))
    return exec(['sh', script], env())
  }

  test('on DATA: the file and three rotations, a quarter of the cap each, no debug', () => {
    expect(args()).toEqual({ code: 0, out: 'syslogd -n -O /var/log/messages -s 2048 -b 3 -l 7\n' })
    expect(args(['LOG_MAX_KIB=16384'])).toEqual({ code: 0, out: 'syslogd -n -O /var/log/messages -s 4096 -b 3 -l 7\n' })
  })

  test('in RAM: the ring logread reads; a collector over UDP, kept locally too', () => {
    expect(args(['LOG_PERSISTENT=no'])).toEqual({ code: 0, out: 'syslogd -n -C1024\n' })
    expect(args(['LOG_PERSISTENT=no', 'LOG_REMOTE=192.0.2.10:514'])).toEqual({ code: 0, out: 'syslogd -n -C1024 -R 192.0.2.10:514 -L\n' })
    expect(args(['LOG_REMOTE=[2001:db8::7]:514'])).toEqual({ code: 0, out: 'syslogd -n -O /var/log/messages -s 2048 -b 3 -l 7 -R [2001:db8::7]:514 -L\n' })
  })

  test('TCP forwards nothing, and says so; invalid settings keep the log in RAM', () => {
    const tcp = args(['LOG_PERSISTENT=no', 'LOG_REMOTE=192.0.2.10:514', 'LOG_REMOTE_PROTOCOL=tcp'])
    expect(tcp.code).toBe(0)
    expect(tcp.out).toBe('syslogd -n -C1024\nmica-syslogd-args: busybox syslogd forwards over UDP only; LOG_REMOTE_PROTOCOL=tcp forwards nothing\n')
    const bad = args(['LOG_REMOTE=nowhere'])
    expect(bad.code).toBe(0)
    expect(bad.out.split('\n')[0]).toBe('syslogd -n -C1024')
  })

  test('mica-syslogd starts after DATA, builds its arguments, and logs a boot marker', () => {
    const init = readFileSync(join(OPENRC, 'etc/init.d/mica-syslogd'), 'utf8')
    for (const text of ['need mica-kernfs', 'after mica-mounts', 'provide logger', 'command_args=$(/usr/lib/mica/mica-syslogd-args)', 'busybox logger -t mica-boot "boot $(cat /proc/sys/kernel/random/boot_id)"'])
      expect(init).toContain(text)
  })
})

describe('logread', () => {
  const log = join(box.dir, 'var-log')
  const shm = join(box.dir, 'shm')
  const bin = join(box.dir, 'logread-bin')
  // busybox's logread prints the ring; tail is recorded.
  fake(bin, 'busybox', '[ "$1" = logread ] || exit 9\nshift\necho "ring $*"\nprintf "a\\nx mica-boot: boot one\\nb\\nx mica-boot: boot two\\nc\\n"')
  fake(bin, 'tail', 'echo "tail $*"')
  const script = join(OPENRC, 'usr/bin/logread')
  const read = (...args: string[]): { code: number, out: string } =>
    exec(['sh', script, ...args], { PATH: `${bin}:${SYSTEM_PATH}`, MICA_LOG_DIR: log, MICA_SYSVIPC_SHM: shm })
  mkdirSync(log)

  test('with the ring, busybox logread; -b cuts at the boot markers', () => {
    writeFileSync(shm, '       key      shmid perms\n 1095648583          3   644\n')
    expect(read().out).toBe('ring \na\nx mica-boot: boot one\nb\nx mica-boot: boot two\nc\n')
    expect(read('-f').out.split('\n')[0]).toBe('ring -f')
    expect(read('-b', '0').out).toBe('x mica-boot: boot two\nc\n')
    expect(read('-b', '-1').out).toBe('x mica-boot: boot one\nb\n')
  })

  test('without it, the files on DATA oldest first, then what comes to messages', () => {
    writeFileSync(shm, '       key      shmid perms\n         0          3   644\n')
    writeFileSync(join(log, 'messages.1'), 'one\nx mica-boot: boot first\n')
    writeFileSync(join(log, 'messages.0'), 'two\n')
    writeFileSync(join(log, 'messages'), 'x mica-boot: boot second\nthree\n')
    expect(read()).toEqual({ code: 0, out: 'one\nx mica-boot: boot first\ntwo\nx mica-boot: boot second\nthree\n' })
    expect(read('-b', '-1').out).toBe('x mica-boot: boot first\ntwo\n')
    expect(read('-b', '0').out).toBe('x mica-boot: boot second\nthree\n')
    expect(read('-F').out).toBe(`one\nx mica-boot: boot first\ntwo\nx mica-boot: boot second\nthree\ntail -n 0 -F ${log}/messages\n`)
    // The first boot has no previous one.
    rmSync(join(log, 'messages.1'))
    rmSync(join(log, 'messages.0'))
    expect(read('-b', '-1')).toEqual({ code: 0, out: '' })
  })

  test('refuses other options', () => {
    for (const args of [['-b', '-2'], ['-x'], ['-f', '-b', '0'], ['extra']])
      expect(read(...args).code).toBe(2)
  })
})

describe('mica-log-settings', () => {
  const bin = join(box.dir, 'settings-bin')
  const calls = join(box.dir, 'settings-calls')
  const run = join(box.dir, 'run')
  const journal = join(box.dir, 'var/log/journal')
  // systemctl answers is-active from $ACTIVE; journalctl and install are recorded, and
  // install makes the directory.
  fake(bin, 'systemctl', 'echo "systemctl $*" >>"$CALLS"\ncase "$*" in "-q is-active "*) case " $ACTIVE " in *" ${3%.service} "*) exit 0 ;; esac; exit 3 ;; esac')
  fake(bin, 'journalctl', 'echo "journalctl $*" >>"$CALLS"')
  fake(bin, 'install', 'echo "install $*" >>"$CALLS"\nfor path; do :; done\nmkdir -p "$path"')
  const script = copy(join(SYSTEMD_PAYLOAD, 'usr/lib/mica/mica-log-settings'), 'mica-log-settings', {})
  const apply = (lines: string[] | undefined, active = 'systemd-journald'): string[] => {
    rmSync(settings, { force: true })
    if (lines)
      writeFileSync(settings, lines.join('\n'))
    writeFileSync(calls, '')
    const ran = exec(['sh', script], { ...env(), PATH: `${bin}:${SYSTEM_PATH}`, CALLS: calls, ACTIVE: active, MICA_JOURNALD_DROPINS: join(run, 'journald.conf.d'), MICA_NETLOGD_DROPINS: join(run, 'netlogd.conf.d'), MICA_JOURNAL_DIR: journal })
    expect(ran.code).toBe(0)
    return readFileSync(calls, 'utf8').split('\n').filter(line => line && !line.includes('is-active'))
  }
  const capFile = join(run, 'journald.conf.d/50-mica.conf')
  const netlogd = join(run, 'netlogd.conf.d/50-mica.conf')

  test('the image\'s settings: the journal directory, flushed to, and no drop-in at all', () => {
    expect(apply(undefined)).toEqual([`install -d -m 2755 -g systemd-journal ${journal}`, 'journalctl --flush'])
    expect(existsSync(capFile)).toBe(false)
    expect(existsSync(netlogd)).toBe(false)
    // Again: the directory is there, nothing restarts.
    expect(apply(undefined)).toEqual(['journalctl --flush'])
  })

  test('another cap is rendered and restarts journald once; the image\'s cap removes it again', () => {
    expect(apply(['LOG_MAX_KIB=16384'])).toEqual(['systemctl restart systemd-journald.service', 'journalctl --flush'])
    expect(readFileSync(capFile, 'utf8')).toBe('[Journal]\nSystemMaxUse=16384K\nSystemMaxFileSize=2048K\n')
    expect(apply(['LOG_MAX_KIB=16384'])).toEqual(['journalctl --flush'])
    expect(apply(['LOG_MAX_KIB=8192'])).toEqual(['systemctl restart systemd-journald.service', 'journalctl --flush'])
    expect(existsSync(capFile)).toBe(false)
  })

  test('the log in RAM: journald gives /var back and the directory goes', () => {
    expect(existsSync(journal)).toBe(true)
    expect(apply(['LOG_PERSISTENT=no'])).toEqual(['journalctl --relinquish-var'])
    expect(existsSync(journal)).toBe(false)
    expect(apply(['LOG_PERSISTENT=no'])).toEqual([])
  })

  test('a collector starts systemd-netlogd on its drop-in; none stops it while it runs', () => {
    expect(apply(['LOG_PERSISTENT=no', 'LOG_REMOTE=192.0.2.10:514'])).toEqual(['systemctl --no-block restart systemd-netlogd.service'])
    expect(readFileSync(netlogd, 'utf8')).toBe('[Network]\nAddress=192.0.2.10:514\nProtocol=udp\nLogFormat=rfc5424\n')
    expect(apply(['LOG_PERSISTENT=no', 'LOG_REMOTE=192.0.2.10:514'])).toEqual([])
    expect(apply(['LOG_PERSISTENT=no', 'LOG_REMOTE=[2001:db8::7]:6514', 'LOG_REMOTE_PROTOCOL=tcp'])).toEqual(['systemctl --no-block restart systemd-netlogd.service'])
    expect(readFileSync(netlogd, 'utf8')).toBe('[Network]\nAddress=[2001:db8::7]:6514\nProtocol=tcp\nLogFormat=rfc5424\n')
    expect(apply(['LOG_PERSISTENT=no'], 'systemd-journald systemd-netlogd')).toEqual(['systemctl --no-block stop systemd-netlogd.service'])
    expect(existsSync(netlogd)).toBe(false)
  })

  test('invalid settings: the journal in RAM and no collector', () => {
    apply(['LOG_REMOTE=192.0.2.10:514'])
    expect(apply(['LOG_REMOTE=nowhere'], 'systemd-journald systemd-netlogd')).toEqual(['journalctl --relinquish-var', 'systemctl --no-block stop systemd-netlogd.service'])
    expect(existsSync(journal)).toBe(false)
  })

  test('the unit runs after /var and /var/lib/mica, before the flush; netlogd waits for its drop-in', () => {
    const unit = readFileSync(join(SYSTEMD_PAYLOAD, 'etc/systemd/system/mica-log-settings.service'), 'utf8')
    for (const line of ['After=systemd-journald.service var.mount var-lib-mica.mount', 'Requires=var.mount var-lib-mica.mount', 'Before=systemd-journal-flush.service sysinit.target shutdown.target', 'ExecStart=/usr/lib/mica/mica-log-settings'])
      expect(unit.split('\n')).toContain(line)
    expect(readlinkSync(join(SYSTEMD_PAYLOAD, 'etc/systemd/system/sysinit.target.wants/mica-log-settings.service'))).toBe('/etc/systemd/system/mica-log-settings.service')
    expect(readFileSync(join(SYSTEMD_PAYLOAD, 'etc/systemd/system/systemd-netlogd.service.d/10-mica.conf'), 'utf8')).toMatch(/^ConditionPathExists=\/run\/systemd\/netlogd\.conf\.d\/50-mica\.conf$/m)
    const journald = readFileSync(join(SYSTEMD_PAYLOAD, 'etc/systemd/journald.conf.d/00-mica.conf'), 'utf8')
    for (const line of ['Storage=auto', 'SystemMaxUse=8M', 'SystemMaxFileSize=1M', 'MaxLevelStore=info'])
      expect(journald.split('\n')).toContain(line)
  })
})
