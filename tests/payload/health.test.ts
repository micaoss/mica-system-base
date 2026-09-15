// The health gate (payload/usr/lib/mica/mica-health). Every command it calls --
// mica-deploy, systemctl, busctl, mica-apid, df -- is a fake that logs its argv, so no
// host state is read or written.
import type { Ran } from './harness.ts'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { exec, fake, MICA, sandbox } from './harness.ts'

const box = sandbox('health')
afterAll(box.done)

interface Case { dir: string, bin: string, calls: string, conf: string, path?: string }

function newCase(name: string): Case {
  const dir = join(box.dir, name)
  rmSync(dir, { recursive: true, force: true })
  const c = { dir, bin: join(dir, 'bin'), calls: join(dir, 'calls.log'), conf: join(dir, 'health.conf') }
  mkdirSync(c.bin, { recursive: true })
  writeFileSync(c.calls, '')
  // The required set mirrors the SHIPPED /etc/mica/health.conf; a fast settle
  // keeps the cases from sleeping.
  writeFileSync(c.conf, 'require=boot-settled\nrequire=micad\nrequire=apid\nsettle-sec=0\nprobe-timeout-sec=5\nvar-threshold-pct=85\n')
  return c
}

// Replace the required set; no members leaves no `require=` line at all.
function setRequired(c: Case, ...members: string[]): void {
  const rest = readFileSync(c.conf, 'utf8').split('\n').filter(line => line && !line.startsWith('require='))
  writeFileSync(c.conf, [...members.map(member => `require=${member}`), ...rest, ''].join('\n'))
}

function logged(c: Case, name: string, body: string): void {
  fake(c.bin, name, `echo "${name} $*" >> "$CALLS_FILE"\n${body}`)
}

function deploymentStatus(c: Case, id: string): void {
  writeFileSync(join(c.dir, 'deployment-status.txt'), `${id}\n`)
}

function healthyFakes(c: Case): void {
  deploymentStatus(c, 'a'.repeat(64))
  logged(c, 'mica-deploy', `
case "$1" in
  "booted")
      [ -n "\${FAKE_DEPLOY_STDERR:-}" ] && echo "$FAKE_DEPLOY_STDERR" >&2
      [ "\${FAKE_DEPLOY_STATUS_RC:-0}" = 0 ] && cat "$CASE_DIR/deployment-status.txt"
      exit \${FAKE_DEPLOY_STATUS_RC:-0} ;;
  "confirm") exit \${FAKE_MARKGOOD_RC:-0} ;;
esac
exit 0`)
  logged(c, 'systemctl', `
case "$1" in
  is-system-running) echo "\${FAKE_SYS_STATE:-running}" ;;
  list-jobs) printf "%s" "\${FAKE_JOBS:-}" ;;
  list-units) printf "%s" "\${FAKE_FAILED_UNITS:-}" ;;
  list-unit-files) case "\${FAKE_UNITS:-micad.service apid.service}" in *"$3"*) echo "$3 enabled" ;; esac ;;
esac
exit 0`)
  logged(c, 'busctl', 'exit ${FAKE_BUSCTL_RC:-0}')
  logged(c, 'mica-apid', 'exit ${FAKE_APID_RC:-0}')
  logged(c, 'df', 'printf "Filesystem 1024-blocks Used Available Capacity Mounted\\n/dev/x 100 10 90 %s%% /var\\n" "${FAKE_VAR_PCT:-12}"')
}

// The mica-apid binary ABSENT while apid.service is listed: PATH is narrowed to
// the fakes and the real tools mica-health and the fakes need, so nothing else a
// `command -v mica-apid` could find is reachable.
function noApidBinary(c: Case): void {
  rmSync(join(c.bin, 'mica-apid'), { force: true })
  const sysbin = join(c.dir, 'sysbin')
  mkdirSync(sysbin, { recursive: true })
  for (const tool of ['sh', 'cat', 'sed', 'head', 'awk', 'tr', 'grep', 'timeout', 'mktemp', 'rm', 'sleep']) {
    const path = Bun.which(tool)
    if (path)
      symlinkSync(path, join(sysbin, tool))
  }
  c.path = `${c.bin}:${sysbin}`
}

function runHealth(c: Case, env: Record<string, string> = {}): Ran {
  return exec(['sh', join(MICA, 'mica-health')], { PATH: c.path ?? `${c.bin}:/usr/bin:/bin`, CALLS_FILE: c.calls, MICA_HEALTH_CONF: c.conf, CASE_DIR: c.dir, ...env })
}

const calls = (c: Case): string[] => readFileSync(c.calls, 'utf8').split('\n')
const markedGood = (c: Case): boolean => calls(c).includes('mica-deploy confirm')

describe('the deployment status', () => {
  test('a missing backend never confirms', () => {
    expect(runHealth(newCase('backend-absent')).code).toBe(1)
  })

  test('no deployment, a failing backend or malformed status never confirm', () => {
    const none = newCase('backend-no-deployment')
    healthyFakes(none)
    deploymentStatus(none, '')
    expect(runHealth(none).code).toBe(1)
    expect(markedGood(none)).toBe(false)

    const errors = newCase('backend-errors')
    healthyFakes(errors)
    const ran = runHealth(errors, { FAKE_DEPLOY_STATUS_RC: '1', FAKE_DEPLOY_STDERR: 'shared DATA unavailable' })
    expect(ran.code).toBe(1)
    expect(markedGood(errors)).toBe(false)
    expect(ran.out).toContain('shared DATA unavailable')

    const garbled = newCase('backend-unparseable')
    healthyFakes(garbled)
    deploymentStatus(garbled, 'unexpected output')
    expect(runHealth(garbled).code).toBe(1)
    expect(markedGood(garbled)).toBe(false)
  })
})

describe('a healthy boot', () => {
  test('confirms, names the deployment and concludes every required member', () => {
    const c = newCase('healthy')
    healthyFakes(c)
    const ran = runHealth(c)
    expect(ran.code).toBe(0)
    expect(markedGood(c)).toBe(true)
    expect(ran.out).toContain('PENDING_CONFIRM -> CONFIRMED')
    expect(ran.out).toContain('booted deployment: aaaaa')
    expect(ran.out).toContain('required set: boot-settled micad apid')
    expect(ran.out.match(/required member .*: OK/g)?.length).toBe(3)
    expect(calls(c)).toContain('busctl --system --quiet call com.mica.micad /com/mica/micad com.mica.micad1 GetState s ')
  })

  test('confirms again on a second run', () => {
    const c = newCase('idempotent')
    healthyFakes(c)
    runHealth(c)
    expect(runHealth(c).code).toBe(0)
    expect(calls(c).filter(line => line === 'mica-deploy confirm').length).toBe(2)
  })
})

// A failed unit is REPORTED, never fatal (PLAN-089): spending a boot credit on
// a oneshot that governs nothing is how a working system rolls into a slot that
// cannot run. It still has to be visible.
describe('failed units', () => {
  test('are reported to micad and confirm anyway', () => {
    const c = newCase('failed-unit-reported')
    healthyFakes(c)
    const ran = runHealth(c, { FAKE_SYS_STATE: 'degraded', FAKE_FAILED_UNITS: 'mica-example.service loaded failed failed X\n' })
    expect(ran.code).toBe(0)
    expect(markedGood(c)).toBe(true)
    expect(ran.out).toContain('note: failed unit: mica-example.service')
    expect(ran.out).toContain('REPORTED, not fatal')
    expect(readFileSync(c.calls, 'utf8')).toContain('ReportHealth sss units degraded 1 failed: mica-example.service')
  })

  test('none is reported ok', () => {
    const c = newCase('no-failed-units')
    healthyFakes(c)
    runHealth(c)
    expect(readFileSync(c.calls, 'utf8')).toContain('ReportHealth sss units ok')
  })

  test('a long list is capped in the report and whole in the journal', () => {
    const c = newCase('failed-units-capped')
    healthyFakes(c)
    const units = Array.from({ length: 12 }, (_, index) => `u${index + 1}.service loaded failed failed X\n`).join('')
    const ran = runHealth(c, { FAKE_SYS_STATE: 'degraded', FAKE_FAILED_UNITS: units })
    expect(ran.code).toBe(0)
    expect(ran.out.match(/note: failed unit:/g)?.length).toBe(12)
    expect(readFileSync(c.calls, 'utf8')).toMatch(/ReportHealth sss units degraded 12 failed: u1\.service .* u10\.service \(\+2 more\)/)
  })
})

describe('systemd states', () => {
  test('maintenance fails boot-settled, and only because it is required', () => {
    const c = newCase('maintenance')
    healthyFakes(c)
    const ran = runHealth(c, { FAKE_SYS_STATE: 'maintenance' })
    expect(ran.code).toBe(1)
    expect(markedGood(c)).toBe(false)
    expect(ran.out).toContain('required member boot-settled')

    const dropped = newCase('maintenance-boot-settled-not-required')
    healthyFakes(dropped)
    setRequired(dropped, 'micad', 'apid')
    const relaxed = runHealth(dropped, { FAKE_SYS_STATE: 'maintenance' })
    expect(relaxed.code).toBe(0)
    expect(markedGood(dropped)).toBe(true)
    expect(relaxed.out).toContain('would have failed')
  })

  // `starting` is the state this gate always sees: it is itself a job of the
  // initial transaction. A job `waiting` is blocked on ordering; only another
  // job still `running` means the boot is genuinely in flight.
  test('starting with only this gate running is settled', () => {
    const c = newCase('starting-self-only')
    healthyFakes(c)
    const ran = runHealth(c, { FAKE_SYS_STATE: 'starting', FAKE_JOBS: '1 mica-health.service start running\n2 mica-status-led.service start waiting\n' })
    expect(ran.code).toBe(0)
    expect(markedGood(c)).toBe(true)
  })

  test('starting with another job running is not', () => {
    const c = newCase('starting-other-job-running')
    healthyFakes(c)
    const ran = runHealth(c, { FAKE_SYS_STATE: 'starting', FAKE_JOBS: '1 mica-health.service start running\n2 something-slow.service start running\n' })
    expect(ran.code).toBe(1)
    expect(markedGood(c)).toBe(false)
    expect(ran.out).toContain('something-slow.service')
  })

  test('starting, settled, with a failed unit confirms and reports', () => {
    const c = newCase('starting-self-only-with-failed-unit')
    healthyFakes(c)
    const ran = runHealth(c, { FAKE_SYS_STATE: 'starting', FAKE_JOBS: '1 mica-health.service start running\n', FAKE_FAILED_UNITS: 'broken.service loaded failed failed X\n' })
    expect(ran.code).toBe(0)
    expect(markedGood(c)).toBe(true)
    expect(readFileSync(c.calls, 'utf8')).toContain('ReportHealth sss units degraded')
  })
})

// A broken slot is one the device cannot be recovered from. The daemon cases run
// with no failed unit: a wedged daemon is `active (running)` to systemd.
describe('the required daemons', () => {
  test('a wedged micad fails the gate with no failed unit at all', () => {
    const c = newCase('micad-wedged')
    healthyFakes(c)
    const ran = runHealth(c, { FAKE_BUSCTL_RC: '1' })
    expect(ran.code).toBe(1)
    expect(markedGood(c)).toBe(false)
    expect(ran.out).toContain('required member micad')
    expect(ran.out).not.toContain('note: failed unit:')
  })

  test('a failing apid healthz fails the gate', () => {
    const c = newCase('apid-wedged')
    healthyFakes(c)
    const ran = runHealth(c, { FAKE_APID_RC: '22' })
    expect(ran.code).toBe(1)
    expect(markedGood(c)).toBe(false)
    expect(ran.out).toContain('required member apid')
  })

  test('both wedged names micad first', () => {
    const c = newCase('bad-update-both-daemons-wedged')
    healthyFakes(c)
    const ran = runHealth(c, { FAKE_BUSCTL_RC: '1', FAKE_APID_RC: '22' })
    expect(ran.code).toBe(1)
    expect(markedGood(c)).toBe(false)
    expect(ran.out).toContain('required member micad')
  })

  test('apid is probed through mica-apid --healthcheck', () => {
    const c = newCase('apid-probe-is-healthcheck')
    healthyFakes(c)
    runHealth(c)
    expect(calls(c)).toContain('mica-apid --healthcheck')
  })
})

// A required member the gate cannot probe is a refusal, not a skip.
describe('unprobeable members', () => {
  test('a required unit the image does not ship refuses', () => {
    for (const [name, units, missing] of [['require-micad-not-installed', 'apid.service', 'micad.service'], ['require-apid-not-installed', 'micad.service', 'apid.service']]) {
      const c = newCase(name!)
      healthyFakes(c)
      const ran = runHealth(c, { FAKE_UNITS: units! })
      expect(ran.code).toBe(1)
      expect(markedGood(c)).toBe(false)
      expect(ran.out).toContain(`${missing} is not installed`)
    }
  })

  test('apid listed without the mica-apid binary refuses', () => {
    const c = newCase('require-apid-no-probe')
    healthyFakes(c)
    noApidBinary(c)
    const ran = runHealth(c)
    expect(ran.code).toBe(1)
    expect(markedGood(c)).toBe(false)
    expect(ran.out).toContain('no mica-apid binary')
  })
})

// An empty required set is "always mark good", reachable in production through
// a missing, unreadable or emptied health.conf; there is no compiled-in default.
describe('the required set', () => {
  test('empty refuses', () => {
    const c = newCase('require-empty')
    healthyFakes(c)
    setRequired(c)
    const ran = runHealth(c)
    expect(ran.code).toBe(1)
    expect(markedGood(c)).toBe(false)
    expect(ran.out).toContain('always mark good')
  })

  test('an absent conf refuses and names the file', () => {
    const c = newCase('require-conf-absent')
    healthyFakes(c)
    rmSync(c.conf)
    expect(existsSync(c.conf)).toBe(false)
    const ran = runHealth(c)
    expect(ran.code).toBe(1)
    expect(markedGood(c)).toBe(false)
    expect(ran.out).toContain(c.conf)
  })

  test('an unknown member refuses and lists the vocabulary', () => {
    const c = newCase('require-unknown-member')
    healthyFakes(c)
    setRequired(c, 'boot-settled', 'micad', 'apid', 'micadd')
    const ran = runHealth(c)
    expect(ran.code).toBe(1)
    expect(markedGood(c)).toBe(false)
    expect(ran.out).toContain('requires `micadd`')
    expect(ran.out).toContain('boot-settled, micad, apid')
  })

  test('each require= line is what makes its member fatal', () => {
    const apid = newCase('apid-down-but-not-required')
    healthyFakes(apid)
    setRequired(apid, 'boot-settled', 'micad')
    expect(runHealth(apid, { FAKE_APID_RC: '22' }).code).toBe(0)
    expect(markedGood(apid)).toBe(true)
    expect(calls(apid).some(line => line.startsWith('mica-apid '))).toBe(false)

    const micad = newCase('micad-down-but-not-required')
    healthyFakes(micad)
    setRequired(micad, 'boot-settled', 'apid')
    expect(runHealth(micad, { FAKE_BUSCTL_RC: '1' }).code).toBe(0)
    expect(markedGood(micad)).toBe(true)
    expect(readFileSync(micad.calls, 'utf8')).not.toContain('com.mica.micad1 GetState')
  })
})

describe('/var pressure', () => {
  test('is reported degraded and never fatal', () => {
    const c = newCase('var-pressure')
    healthyFakes(c)
    const ran = runHealth(c, { FAKE_VAR_PCT: '91' })
    expect(ran.code).toBe(0)
    expect(markedGood(c)).toBe(true)
    expect(readFileSync(c.calls, 'utf8')).toContain('ReportHealth sss var degraded')
    expect(ran.out).toContain('NOT fatal')
  })

  test('under the threshold is reported ok', () => {
    const c = newCase('var-ok')
    healthyFakes(c)
    runHealth(c, { FAKE_VAR_PCT: '12' })
    expect(readFileSync(c.calls, 'utf8')).toContain('ReportHealth sss var ok')
  })
})
