import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { exec, fake, sandbox, SYSTEM_PATH } from './harness.ts'

const box = sandbox('openrc-grow')
afterAll(box.done)
const bin = join(box.dir, 'bin'), sys = join(box.dir, 'sys/class/block')
const disk = join(box.dir, 'dev/mmcblk1'), calls = join(box.dir, 'calls')
mkdirSync(sys, { recursive: true })
mkdirSync(join(box.dir, 'dev'))
const systemUuid = '5a9055a0-0004-4000-8000-000000000002', diskUuid = '5a9055a0-0004-4000-8000-000000000000'
const geometry = [[1, 262144, 16384], [2, 278528, 2097152], [3, 2375680, 524288], [4, 8192, 24576], [5, 73728, 131072], [6, 221184, 32768]]
for (const [number, start, size] of geometry) {
  const device = join(box.dir, 'sys/devices/mmcblk1', `mmcblk1p${number}`)
  mkdirSync(device, { recursive: true })
  for (const [key, value] of [['partition', number], ['start', start], ['size', size]]) writeFileSync(join(device, String(key)), `${value}\n`)
  symlinkSync(device, join(sys, `mmcblk1p${number}`))
}
symlinkSync(join(box.dir, 'sys/devices/mmcblk1'), join(sys, 'mmcblk1'))
const script = join(box.dir, 'grow')
writeFileSync(script, readFileSync(resolve(import.meta.dir, '../../debs/mica-openrc/payload/usr/lib/mica/mica-grow-data'), 'utf8').replaceAll('/sys/class/block', sys).replace('disk=/dev/', `disk=${box.dir}/dev/`))
fake(bin, 'findmnt', 'echo /dev/mmcblk1p2')
fake(bin, 'blkid', `if [ "$1" = -p ]; then echo ${diskUuid}; else echo ${systemUuid}; fi`)
fake(bin, 'sfdisk', 'printf "sfdisk %s\\n" "$*" >>"$CALLS"')
fake(bin, 'partx', 'printf "partx %s\\n" "$*" >>"$CALLS"')

test('OpenRC grows the last partition on disk, DATA in slot 3 rather than vendor slot 6', () => {
  const node = exec(['mknod', disk, 'b', '7', '245'], { PATH: SYSTEM_PATH })
  expect(node.code).toBe(0)
  const run = exec(['sh', script, systemUuid, diskUuid], { PATH: `${bin}:${SYSTEM_PATH}`, CALLS: calls })
  expect(run.code).toBe(0)
  expect(readFileSync(calls, 'utf8')).toContain(`-N 3 ${disk}`)
  expect(readFileSync(calls, 'utf8')).toContain(`partx --update --nr 3 ${disk}`)
})
