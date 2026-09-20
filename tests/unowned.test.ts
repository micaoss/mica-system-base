// Every path a root holds that no package claims, with the thing that wrote it:
// the list a composer diffs against its own declarations, since ownership cannot
// prove a generated path. Built over a synthetic root, so the rules are read
// rather than the Debian of the day.
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterAll, expect, test } from 'bun:test'
import { formatUnowned, unownedPaths } from '../src/unowned.ts'
import { workdir } from './fixture.ts'

const work = workdir('unowned')
afterAll(() => rmSync(work, { recursive: true, force: true }))

function root(name: string): string {
  const path = join(work, name)
  const put = (file: string, content = ''): void => {
    mkdirSync(dirname(join(path, file)), { recursive: true })
    writeFileSync(join(path, file), content)
  }
  // A package that owns one file and generates two others from its postinst.
  put('var/lib/dpkg/info/login.list', '/etc/pam.d\n/etc/pam.d/login\n/usr/bin/login\n')
  put('var/lib/dpkg/info/libpam-runtime.list', '/usr/sbin/pam-auth-update\n')
  put('var/lib/dpkg/info/libpam-runtime.postinst', '#!/bin/sh\npam-auth-update --package\n')
  put('var/lib/dpkg/info/mawk.list', '/usr/bin/mawk\n')
  put('var/lib/dpkg/info/mawk.postinst', '#!/bin/sh\nupdate-alternatives --install /usr/bin/awk awk /usr/bin/mawk 5\n')
  put('var/lib/dpkg/info/quota.list', '/usr/sbin/quotaon\n')
  put('var/lib/dpkg/info/quota.postinst', '#!/bin/sh\ngrep quota /etc/fstab || true\n')
  put('var/lib/dpkg/info/dbus.postinst', '#!/bin/sh\ndeb-systemd-helper enable dbus.service\n')
  put('etc/pam.d/login', 'auth @include common-auth\n')
  put('usr/bin/login')
  put('usr/sbin/pam-auth-update')
  put('usr/bin/mawk')
  put('usr/sbin/quotaon')
  // Unowned: generated, seeded, per-unit and one nobody claims.
  put('etc/pam.d/common-auth', 'auth required pam_unix.so\n')
  put('var/lib/pam/auth')
  put('etc/passwd', 'root:x:0:0:root:/root:/bin/sh\n')
  put('etc/subuid', 'mica:100000:65536\n')
  put('etc/hostname', 'mica\n')
  put('etc/ld.so.cache')
  put('etc/fstab')
  put('var/lib/systemd/deb-systemd-helper-enabled/dbus.service.dsh-also')
  put('etc/rc2.d/S01dbus')
  put('etc/nowhere.conf')
  // A dangling compatibility symlink created by a tmpfiles.d entry: no package
  // owns it and no script names it, so only the rule file can attribute it.
  put('usr/lib/tmpfiles.d/debian.conf', '# comment\nd /run/lock 0755 root root -\nL+ /etc/vconsole.conf  - - -  -  default/keyboard\n')
  put('var/lib/dpkg/info/systemd.list', '/usr/lib/tmpfiles.d/debian.conf\n')
  put('usr/bin/awk')
  mkdirSync(join(path, 'etc/alternatives'), { recursive: true })
  symlinkSync('/usr/bin/mawk', join(path, 'etc/alternatives/awk'))
  symlinkSync('default/keyboard', join(path, 'etc/vconsole.conf'))
  // Skipped: the dpkg database, documentation and the runtime directories.
  put('var/lib/dpkg/status', 'Package: login\n')
  put('usr/share/doc/login/copyright')
  put('run/mica/shadow')
  return path
}

test('an unowned path is listed with its writer, and an owned one is not', () => {
  const rows = unownedPaths(root('base'))
  const writers = new Map(rows.map(row => [row.path, row.writer]))
  expect([...writers.keys()]).toEqual([
    '/etc/alternatives/awk',
    '/etc/fstab',
    '/etc/hostname',
    '/etc/ld.so.cache',
    '/etc/nowhere.conf',
    '/etc/pam.d/common-auth',
    '/etc/passwd',
    '/etc/rc2.d/S01dbus',
    '/etc/subuid',
    '/etc/vconsole.conf',
    '/usr/bin/awk',
    '/var/lib/pam/auth',
    '/var/lib/systemd/deb-systemd-helper-enabled/dbus.service.dsh-also',
  ])
  // Owned paths, the dpkg database, documentation and runtime trees stay out.
  expect(writers.has('/etc/pam.d/login')).toBe(false)
  expect(rows.some(row => row.path.startsWith('/var/lib/dpkg/') || row.path.startsWith('/usr/share/doc/') || row.path.startsWith('/run/'))).toBe(false)
  // The writer is read from the root: a generator, the caller of a per-unit
  // generator, the script that names the path, or this repository's own build.
  expect(writers.get('/etc/pam.d/common-auth')).toBe('pam-auth-update (libpam-runtime.postinst)')
  expect(writers.get('/var/lib/pam/auth')).toBe('pam-auth-update (libpam-runtime.postinst)')
  expect(writers.get('/etc/ld.so.cache')).toBe('ldconfig (libc-bin.postinst)')
  expect(writers.get('/etc/fstab')).toBe('quota.postinst')
  expect(writers.get('/var/lib/systemd/deb-systemd-helper-enabled/dbus.service.dsh-also')).toBe('deb-systemd-helper (dbus.postinst)')
  expect(writers.get('/etc/rc2.d/S01dbus')).toBe('update-rc.d (dbus.postinst)')
  expect(writers.get('/etc/vconsole.conf')).toBe('systemd-tmpfiles (/usr/lib/tmpfiles.d/debian.conf)')
  // A range nothing in the image can apply says so where a reader greps it.
  expect(writers.get('/etc/subuid')).toContain('inert, no uidmap in the root')
  expect(writers.get('/etc/passwd')).toContain('src/bootstrap.ts writeSeed')
  expect(writers.get('/etc/hostname')).toBe('src/bootstrap.ts cleanRoot')
  // An alternative names the tool and the package that installed the link.
  expect(writers.get('/etc/alternatives/awk')).toBe('update-alternatives (mawk.postinst)')
  expect(writers.get('/usr/bin/awk')).toBe('mawk.postinst')
  // What cannot be established says so; a guess would be a wrong rule downstream.
  expect(writers.get('/etc/nowhere.conf')).toBe('unknown')
  // The file is sorted, tab-separated and has one row per path.
  const text = formatUnowned(rows)
  expect(text.endsWith('\n')).toBe(true)
  const [header, ...lines] = text.split('\n').filter(Boolean)
  // The counts travel with the artefact, and the header can be checked against
  // the rows by whoever reads the file rather than the run that wrote it.
  expect(header).toBe(`# mica-unowned v1: ${rows.length} paths no package claims, 1 without a named writer`)
  expect(lines).toHaveLength(rows.length)
  expect(lines.every(line => line.split('\t').length === 2)).toBe(true)
})
