// mica-mdev's service: after mdev -s, the module of every present device's alias is
// loaded once; mdev.conf loads the module of a hotplugged one. Both run against a fixture /sys/devices, a fake busybox that runs the host's
// tools for its applets but mdev and modprobe, and a fake kmod modprobe.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, expect, test } from 'bun:test'
import { exec, fake, sandbox, SYSTEM_PATH } from './harness.ts'

const SERVICE = resolve(import.meta.dir, '../../debs/mica-mdev/payload/etc/init.d/mica-mdev')
const box = sandbox('mdev')
afterAll(box.done)

const bin = join(box.dir, 'bin')
const kmod = join(box.dir, 'kmod')
const sys = join(box.dir, 'sys/devices')
const calls = join(box.dir, 'calls')
fake(bin, 'busybox', `case "$1" in
mdev) echo "mdev $2" >> "$CALLS"; exit "\${MDEV_EXIT:-0}" ;;
modprobe) shift; echo "busybox modprobe $*" >> "$CALLS"; exit 1 ;;
esac
applet=$1
shift
PATH=${SYSTEM_PATH} exec "$applet" "$@"`)
// modprobe fails, as it does when an alias names no module.
fake(kmod, 'modprobe', 'echo "modprobe $*" >> "$CALLS"\necho "modprobe: no module" >&2\nexit 1')
const script = join(box.dir, 'mica-mdev')
writeFileSync(script, readFileSync(SERVICE, 'utf8').replaceAll('/usr/bin/busybox', join(bin, 'busybox')).replaceAll('/sys/devices', sys))

function device(path: string, alias: string): void {
  mkdirSync(join(sys, path), { recursive: true })
  writeFileSync(join(sys, path, 'modalias'), `${alias}\n`)
}
device('pci0000:00/0000:00:1f.3', 'pci:v00008086d0000A348sv00008086sd00007270bc04sc03i00')
device('platform/leds', 'of:NledsT(null)Cgpio-leds')
// Two functions of one device share an alias: it is loaded once.
device('pci0000:00/0000:00:14.0/usb1/1-1/1-1:1.0', 'usb:v0BDAp8179d0000dc00dsc00dp00icFFiscFFipFFin00')
device('pci0000:00/0000:00:14.0/usb1/1-1/1-1:1.1', 'usb:v0BDAp8179d0000dc00dsc00dp00icFFiscFFipFFin00')
mkdirSync(join(sys, 'virtual/net/lo'), { recursive: true })
writeFileSync(join(sys, 'virtual/net/lo/uevent'), 'INTERFACE=lo\n')

// A service's PATH: the root's kmod modprobe on it, or none.
const start = (env: Record<string, string> = {}, path = kmod): { code: number, out: string, calls: string[] } => {
  writeFileSync(calls, '')
  const ran = exec(['/bin/sh', '-c', `ebegin() { echo "* $*"; }; eend() { return "$1"; }; . "${script}"; start_post`], { PATH: path, CALLS: calls, ...env })
  return { ...ran, calls: readFileSync(calls, 'utf8').trim().split('\n') }
}

test('after mdev -s, every present alias goes to its own modprobe once, quietly and without failing the boot', () => {
  const ran = start()
  expect(ran.code).toBe(0)
  expect(ran.calls).toEqual([
    'mdev -s',
    'modprobe -q -b of:NledsT(null)Cgpio-leds',
    'modprobe -q -b pci:v00008086d0000A348sv00008086sd00007270bc04sc03i00',
    'modprobe -q -b usb:v0BDAp8179d0000dc00dsc00dp00icFFiscFFipFFin00',
  ])
  expect(ran.out).not.toContain('no module')
})

test('a failing mdev -s still fails the service, after the modules are loaded', () => {
  const ran = start({ MDEV_EXIT: '3' })
  expect(ran.code).toBe(3)
  expect(ran.calls).toHaveLength(4)
})

test('a root without kmod loads them with busybox\'s modprobe', () => {
  const ran = start({}, join(box.dir, 'empty'))
  expect(ran.code).toBe(0)
  expect(ran.calls.slice(1)).toEqual([
    'busybox modprobe -q -b of:NledsT(null)Cgpio-leds',
    'busybox modprobe -q -b pci:v00008086d0000A348sv00008086sd00007270bc04sc03i00',
    'busybox modprobe -q -b usb:v0BDAp8179d0000dc00dsc00dp00icFFiscFFipFFin00',
  ])
})

// mdev runs a rule's command with sh -c, the uevent's variables in its environment.
const CONF = resolve(import.meta.dir, '../../debs/mica-mdev/payload/etc/mdev.conf')
const hotplug = readFileSync(CONF, 'utf8').split('\n').find(line => line.startsWith('$MODALIAS='))!.replace(/^\S+\s+\S+\s+\S+\s+@/, '').replaceAll('/usr/bin/busybox', join(bin, 'busybox'))
const uevent = (path: string): string[] => {
  writeFileSync(calls, '')
  exec(['/bin/sh', '-c', hotplug], { PATH: path, CALLS: calls, MODALIAS: 'usb:v0BDAp8179d0000dc00dsc00dp00icFFiscFFipFFin00' })
  return readFileSync(calls, 'utf8').trim().split('\n')
}

test('a hotplugged alias goes to kmod\'s modprobe, or busybox\'s on a root without kmod', () => {
  expect(uevent(kmod)).toEqual(['modprobe -q -b usb:v0BDAp8179d0000dc00dsc00dp00icFFiscFFipFFin00'])
  expect(uevent(join(box.dir, 'empty'))).toEqual(['busybox modprobe -q -b usb:v0BDAp8179d0000dc00dsc00dp00icFFiscFFipFFin00'])
})
