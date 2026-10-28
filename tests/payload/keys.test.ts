// mica-add-keys: a key file added to root's and mica's authorized_keys, the way keys
// reach an image without micad; against a fixture /etc/passwd and homes, owned by
// whoever runs the test.
import { lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { exec, MICA, sandbox, SYSTEM_PATH } from './harness.ts'

const box = sandbox('keys')
afterAll(box.done)

const ED = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl'
const RSA = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC7 operator@bench'
const uid = process.getuid!(), gid = process.getgid!()

interface Case { dir: string, file: string, passwd: string, root: string, mica: string }

function newCase(name: string, keys: string): Case {
  const dir = join(box.dir, name)
  rmSync(dir, { recursive: true, force: true })
  const c = { dir, file: join(dir, 'mica-authorized-keys'), passwd: join(dir, 'passwd'), root: join(dir, 'root'), mica: join(dir, 'home/mica') }
  mkdirSync(c.root, { recursive: true })
  mkdirSync(c.mica, { recursive: true })
  writeFileSync(c.passwd, `root:x:${uid}:${gid}:root:${c.root}:/bin/sh\nmica:x:${uid}:${gid}:mica operator:${c.mica}:/bin/sh\n`)
  writeFileSync(c.file, keys)
  return c
}

const run = (c: Case) => exec(['sh', join(MICA, 'mica-add-keys'), c.file], { PATH: SYSTEM_PATH, MICA_PASSWD: c.passwd })
const keysOf = (home: string) => readFileSync(join(home, '.ssh/authorized_keys'), 'utf8')
const mode = (path: string) => statSync(path).mode & 0o777

describe('mica-add-keys', () => {
  test('adds every key for root and mica, 0700 and 0600, comments and blank lines aside', () => {
    const c = newCase('adds', `# the bench\n\n${ED}\n${RSA}\n`)
    const ran = run(c)
    expect(ran.code, ran.out).toBe(0)
    for (const home of [c.root, c.mica]) {
      expect(keysOf(home)).toBe(`${ED}\n${RSA}\n`)
      expect(mode(join(home, '.ssh'))).toBe(0o700)
      expect(mode(join(home, '.ssh/authorized_keys'))).toBe(0o600)
    }
    expect(ran.out).toContain('2 key(s) added for root')
  })

  test('keeps the keys an account holds and adds none twice', () => {
    const c = newCase('keeps', `${ED}\n${RSA}\n`)
    mkdirSync(join(c.root, '.ssh'))
    writeFileSync(join(c.root, '.ssh/authorized_keys'), `${RSA}\nssh-ed25519 AAAAexisting kept\n`)
    expect(run(c).code).toBe(0)
    expect(keysOf(c.root)).toBe(`${RSA}\nssh-ed25519 AAAAexisting kept\n${ED}\n`)
    const again = run(c)
    expect(again.code).toBe(0)
    expect(again.out).toContain('0 key(s) added for root')
    expect(keysOf(c.mica)).toBe(`${ED}\n${RSA}\n`)
  })

  test.each([
    ['an options prefix', `${ED}\ncommand="sh" ${ED}\n`],
    ['a private key', `${ED}\n-----BEGIN OPENSSH PRIVATE KEY-----\n`],
    ['an unknown type', `${ED}\nssh-dss AAAAB3Nza\n`],
    ['a control character', `${ED}\nssh-ed25519 AAAA C3Nz\x01\n`],
    ['no key at all', '# nothing\n\n'],
  ])('refuses the whole file over %s, and writes nothing', (_what, keys) => {
    const c = newCase(`refuses-${_what.replaceAll(' ', '-')}`, keys)
    const ran = run(c)
    expect(ran.code).toBe(1)
    expect(() => lstatSync(join(c.root, '.ssh'))).toThrow()
    expect(() => lstatSync(join(c.mica, '.ssh'))).toThrow()
  })

  test('writes through no link in a home, and still serves the other account', () => {
    const c = newCase('link', `${ED}\n`)
    const elsewhere = join(c.dir, 'elsewhere')
    writeFileSync(elsewhere, 'untouched\n')
    mkdirSync(join(c.mica, '.ssh'))
    symlinkSync(elsewhere, join(c.mica, '.ssh/authorized_keys'))
    const ran = run(c)
    expect(ran.code).toBe(1)
    expect(readFileSync(elsewhere, 'utf8')).toBe('untouched\n')
    expect(keysOf(c.root)).toBe(`${ED}\n`)
    expect(ran.out).toContain('no keys added for mica')
  })

  test('removes a link left where the new file is written, not writing through it', () => {
    const c = newCase('stale', `${ED}\n`)
    const elsewhere = join(c.dir, 'elsewhere')
    writeFileSync(elsewhere, 'untouched\n')
    mkdirSync(join(c.mica, '.ssh'))
    symlinkSync(elsewhere, join(c.mica, '.ssh/authorized_keys.mica-add-keys'))
    expect(run(c).code).toBe(0)
    expect(readFileSync(elsewhere, 'utf8')).toBe('untouched\n')
    expect(keysOf(c.mica)).toBe(`${ED}\n`)
  })

  test('skips an account the image does not have', () => {
    const c = newCase('no-mica', `${ED}\n`)
    writeFileSync(c.passwd, `root:x:${uid}:${gid}:root:${c.root}:/bin/sh\n`)
    const ran = run(c)
    expect(ran.code).toBe(0)
    expect(keysOf(c.root)).toBe(`${ED}\n`)
    expect(ran.out).toContain('no account mica')
  })
})

describe('mica-provisioning-import', () => {
  const script = readFileSync(join(MICA, 'mica-provisioning-import'), 'utf8')

  test('hands a medium\'s key file to mica-add-keys only on an image without micad', () => {
    const micad = script.indexOf('"$INIT" installed micad')
    const add = script.indexOf('"$ADD_KEYS" "${dir}/${KEYS}"')
    expect(micad).toBeGreaterThan(0)
    expect(add).toBeGreaterThan(micad)
    expect(script.slice(micad, add)).toContain('exit 0')
    expect(script).toContain('KEYS=mica-authorized-keys')
    expect(script).toContain('regular "${dir}/${DOCUMENT}" || regular "${dir}/${KEYS}"')
  })
})
