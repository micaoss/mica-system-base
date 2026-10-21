// The device access groups: an app running unprivileged reaches GPIO, I2C, SPI and
// serial devices through gpio, i2c, spi and dialout. The groups are pinned in
// config/ids.json; udev (mica-systemd) and mdev (mica-mdev) give the nodes to them.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { SYSTEMD_PAYLOAD } from './harness.ts'

const REPO = resolve(import.meta.dir, '../..')

describe('the device access groups', () => {
  test('gpio, i2c and spi have fixed gids', () => {
    const ids = JSON.parse(readFileSync(resolve(REPO, 'config/ids.json'), 'utf8')) as { groups: { name: string, gid: number }[] }
    const gid = (name: string): number | undefined => ids.groups.find(group => group.name === name)?.gid
    expect([gid('gpio'), gid('i2c'), gid('spi')]).toEqual([984, 987, 983])
    expect(new Set(ids.groups.map(group => group.gid)).size).toBe(ids.groups.length)
  })

  // mdev's first matching line, its regex matched against the whole node name.
  const mdev = readFileSync(resolve(REPO, 'debs/mica-mdev/payload/etc/mdev.conf'), 'utf8').split('\n')
    .filter(line => line && !line.startsWith('#') && !line.startsWith('$'))
    .map(line => line.split(/\s+/))
  const node = (name: string): string => {
    const rule = mdev.find(([regex]) => new RegExp(`^(?:${regex})$`).test(name))
    return rule ? `${rule[1]} ${rule[2]}` : '(none)'
  }

  test.each([
    ['gpiochip0', 'root:gpio 0660'],
    ['gpiochip12', 'root:gpio 0660'],
    ['i2c-0', 'root:i2c 0660'],
    ['i2c-10', 'root:i2c 0660'],
    ['spidev0.0', 'root:spi 0660'],
    ['spidev3.1', 'root:spi 0660'],
    // Serial ports stay dialout's, as Debian's udev gives tty[A-Z]*[0-9] and ttymxc*.
    ['ttyS0', 'root:dialout 0660'],
    ['ttyUSB0', 'root:dialout 0660'],
    ['ttyACM1', 'root:dialout 0660'],
    ['ttyAMA0', 'root:dialout 0660'],
    ['ttyFIQ0', 'root:dialout 0660'],
    ['ttymxc2', 'root:dialout 0660'],
    ['tty1', 'root:tty 0620'],
  ])('under mdev, %s is %s', (name, owner) => {
    expect(node(name)).toBe(owner)
  })

  test('under udev, mica-systemd\'s rules give the nodes to gpio, i2c and spi', () => {
    const rules = readFileSync(resolve(SYSTEMD_PAYLOAD, 'usr/lib/udev/rules.d/60-mica-devices.rules'), 'utf8').split('\n').filter(line => line && !line.startsWith('#'))
    expect(rules).toEqual([
      'SUBSYSTEM=="gpio", KERNEL=="gpiochip[0-9]*", GROUP="gpio", MODE="0660"',
      'SUBSYSTEM=="i2c-dev", KERNEL=="i2c-[0-9]*", GROUP="i2c", MODE="0660"',
      'SUBSYSTEM=="spidev", KERNEL=="spidev[0-9]*.[0-9]*", GROUP="spi", MODE="0660"',
    ])
  })
})
