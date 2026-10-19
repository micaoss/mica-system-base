// Growing DATA on the authenticated SYSTEM disk and its discard policy
// (payload/usr/lib/mica/mica-grow-data).
import type { Ran } from './harness.ts'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { exec, fake, SYSTEMD_PAYLOAD, sandbox, SYSTEM_PATH } from './harness.ts'

const box = sandbox('grow')
afterAll(box.done)

const SYSTEM_UUID = '5a9055a0-0004-4000-8000-000000000002'
const DISK_UUID = '5a9055a0-0004-4000-8000-000000000000'
const FOREIGN_UUID = '5a9055a0-0004-4000-8000-0000000000ff'

describe('mica-grow-data', () => {
  const root = join(box.dir, 'grow')
  const bin = join(root, 'bin')
  const sys = join(root, 'sys/class/block')
  const calls = join(root, 'calls')
  const probes = join(root, 'probes')

  // The helper names /sys, /dev and systemd-repart by absolute path, so the test
  // runs a copy with those three roots moved into the sandbox -- the rewrite the
  // boot-failure test uses for its marker. Everything else, every identity check
  // and every exec line included, is the shipped text.
  const script = join(root, 'mica-grow-data')
  mkdirSync(bin, { recursive: true })
  writeFileSync(script, readFileSync(join(SYSTEMD_PAYLOAD, 'usr/lib/mica/mica-grow-data'), 'utf8')
    .replaceAll('/sys/class/block', sys)
    .replaceAll('disk=/dev/', `disk=${root}/dev/`)
    .replaceAll('/usr/bin/systemd-repart', join(bin, 'systemd-repart')))

  fake(bin, 'systemd-repart', 'printf "%s\\n" "$*" >>"$MICA_TEST_CALLS"')
  fake(bin, 'findmnt', 'printf "findmnt %s\\n" "$*" >>"$MICA_TEST_PROBES"\nprintf "%s\\n" "$MICA_TEST_SOURCE"')
  fake(bin, 'blkid', 'printf "blkid %s\\n" "$*" >>"$MICA_TEST_PROBES"\nif [ "$1" = -p ]; then printf "%s\\n" "$MICA_TEST_PTUUID"; else printf "%s\\n" "$MICA_TEST_PARTUUID"; fi')

  // A partition as sysfs presents it: /sys/class/block/<node> links into its disk's
  // device directory, which holds the partition index.
  const attach = (node: string, index: number, disk: string): void => {
    const device = join(root, 'sys/devices', disk, node)
    mkdirSync(device, { recursive: true })
    writeFileSync(join(device, 'partition'), `${index}\n`)
    mkdirSync(sys, { recursive: true })
    symlinkSync(device, join(sys, node))
  }
  attach('mmcblk1p2', 2, 'mmcblk1')
  attach('mmcblk1p1', 1, 'mmcblk1')
  attach('sda2', 2, 'sda')

  // The block device the checks demand: only a real device node satisfies [ -b ],
  // so the cases that must reach systemd-repart need mknod. The project runs its
  // tests as root in the environment image, where this always succeeds.
  mkdirSync(join(root, 'dev'), { recursive: true })
  const disk = join(root, 'dev/mmcblk1')
  const nodes = exec(['mknod', disk, 'b', '179', '0'], { PATH: SYSTEM_PATH }).code === 0

  interface Medium { source?: string, partuuid?: string, ptuuid?: string }
  const grow = (args: string[], medium: Medium = {}): Ran => {
    writeFileSync(calls, '')
    writeFileSync(probes, '')
    return exec(['sh', script, ...args], {
      PATH: `${bin}:${SYSTEM_PATH}`,
      MICA_TEST_CALLS: calls,
      MICA_TEST_PROBES: probes,
      MICA_TEST_SOURCE: medium.source ?? '/dev/mmcblk1p2',
      MICA_TEST_PARTUUID: medium.partuuid ?? SYSTEM_UUID,
      MICA_TEST_PTUUID: medium.ptuuid ?? DISK_UUID,
    })
  }
  const repart = (): string[] => readFileSync(calls, 'utf8').split('\n').filter(Boolean)
  const probed = (): string[] => readFileSync(probes, 'utf8').split('\n').filter(Boolean)

  test.skipIf(!nodes)('two arguments run the command this helper has always run', () => {
    expect(grow([SYSTEM_UUID, DISK_UUID]).code).toBe(0)
    expect(repart()).toEqual([`--dry-run=no ${disk}`])
  })

  test.skipIf(!nodes)('a discard policy is forwarded verbatim', () => {
    expect(grow([SYSTEM_UUID, DISK_UUID, '--discard=no']).code).toBe(0)
    expect(repart()).toEqual([`--dry-run=no --discard=no ${disk}`])
    expect(grow([SYSTEM_UUID, DISK_UUID, '--discard=yes']).code).toBe(0)
    expect(repart()).toEqual([`--dry-run=no --discard=yes ${disk}`])
  })

  // A policy that cannot be read is never quietly taken for the default: erasing
  // the unpartitioned bootloader copies of an eMMC is not recoverable.
  test('an unreadable discard policy is refused before the disk is looked at', () => {
    for (const policy of ['--discard=maybe', '--discard=YES', '--discard=', '--discard', 'no', 'yes', '']) {
      const ran = grow([SYSTEM_UUID, DISK_UUID, policy])
      expect([policy, ran.code]).not.toEqual([policy, 0])
      expect([policy, ran.out]).toEqual([policy, `mica-grow-data: unsupported discard policy: ${policy}\n`])
      expect([policy, repart()]).toEqual([policy, []])
      expect([policy, probed()]).toEqual([policy, []])
    }
  })

  test('an argument after the discard policy is refused', () => {
    const ran = grow([SYSTEM_UUID, DISK_UUID, '--discard=no', '/dev/mmcblk1'])
    expect(ran.code).not.toBe(0)
    expect(ran.out).toBe('mica-grow-data: unexpected argument: /dev/mmcblk1\n')
    expect(repart()).toEqual([])
    expect(probed()).toEqual([])
  })

  test('a missing UUID is refused', () => {
    for (const args of [[], [SYSTEM_UUID]]) {
      expect(grow(args).code).not.toBe(0)
      expect(repart()).toEqual([])
    }
  })

  // The identity of the medium is what makes growing it safe; every check refuses
  // on its own, with and without a discard policy.
  describe('the identity checks', () => {
    for (const policy of [[], ['--discard=no']]) {
      const label = policy.length ? ' (with a discard policy)' : ''

      test(`a foreign SYSTEM PARTUUID is refused${label}`, () => {
        expect(grow([SYSTEM_UUID, DISK_UUID, ...policy], { partuuid: FOREIGN_UUID }).code).not.toBe(0)
        expect(repart()).toEqual([])
      })

      test(`a SYSTEM that is not partition 2 is refused${label}`, () => {
        expect(grow([SYSTEM_UUID, DISK_UUID, ...policy], { source: '/dev/mmcblk1p1' }).code).not.toBe(0)
        expect(repart()).toEqual([])
      })

      test(`a parent that is no block device is refused${label}`, () => {
        expect(grow([SYSTEM_UUID, DISK_UUID, ...policy], { source: '/dev/sda2' }).code).not.toBe(0)
        expect(repart()).toEqual([])
      })

      test.skipIf(!nodes)(`a foreign disk PTUUID is refused${label}`, () => {
        expect(grow([SYSTEM_UUID, DISK_UUID, ...policy], { ptuuid: FOREIGN_UUID }).code).not.toBe(0)
        expect(repart()).toEqual([])
      })
    }

    test.skipIf(!nodes)('the checks read the mount, the partition index and the disk of the shipped paths', () => {
      grow([SYSTEM_UUID, DISK_UUID])
      expect(probed()).toEqual([
        'findmnt -rn -M /mnt/system -o SOURCE',
        'blkid -s PARTUUID -o value /dev/mmcblk1p2',
        `blkid -p -s PTUUID -o value ${disk}`,
      ])
    })
  })
})
