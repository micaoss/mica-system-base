// Build a locked root offline with mmdebstrap, then hold it to the lock.
import type { Options } from './args.ts'
import type { Row } from './lock.ts'
import type { Ids } from './pins.ts'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fail } from './errors.ts'
import { attached, capture, need, output } from './exec.ts'
import { ids, sources } from './pins.ts'
import { renderRepo } from './repo.ts'
import { assertBase, HOSTNAME, localRows, lstatExists, OPERATOR_ACCOUNTS, SHADOW_FILES, SHADOW_LAST_CHANGE, STRIPPED, writeRelease } from './rootfs.ts'
import { archivePath, verifyRows } from './verify.ts'

// Kept out of the root, as the slim Debian image did; copyright files stay.
const SLIM = [
  'path-exclude=/usr/share/doc/*',
  'path-include=/usr/share/doc/*/copyright',
  'path-exclude=/usr/share/info/*',
  'path-exclude=/usr/share/lintian/overrides/*',
  'path-exclude=/usr/share/locale/*',
  'path-exclude=/usr/share/man/*',
  // Nothing in the root converts character sets or builds locales.
  'path-exclude=/usr/lib/*/gconv/*',
  'path-exclude=/usr/share/i18n/*',
]

function passwdLine(user: Ids['users'][number], password = 'x'): string {
  return [user.name, password, user.uid, user.gid, user.gecos, user.home, user.shell].join(':')
}

function masterNames(file: string): Set<string> {
  return new Set(readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => line.split(':')[0]!))
}

// Seeded before any package installs, so maintainer scripts reuse the pinned IDs.
// The password field is '*' as in base-passwd's masters: pwconv and grpconv move
// it into /etc/shadow and /etc/gshadow, where it is the locked marker.
function writeSeed(work: string, cacheDir: string, selected: Row[], pinned: Ids): { passwd: Set<string>, group: Set<string> } {
  const basePasswd = selected.find(row => row.name === 'base-passwd')
  if (!basePasswd)
    fail('the selection has no base-passwd, so there is no static user table to seed')
  const extracted = join(work, 'base-passwd')
  output(['dpkg-deb', '-x', archivePath(cacheDir, basePasswd.sha256), extracted], 'extracting base-passwd')
  const master = (name: string): string => join(extracted, 'usr/share/base-passwd', `${name}.master`)
  mkdirSync(join(work, 'seed'))
  writeFileSync(join(work, 'seed/passwd'), readFileSync(master('passwd'), 'utf8') + pinned.users.map(user => `${passwdLine(user, '*')}\n`).join(''))
  writeFileSync(join(work, 'seed/group'), readFileSync(master('group'), 'utf8') + pinned.groups.map(group => `${group.name}:*:${group.gid}:\n`).join(''))
  return { passwd: masterNames(master('passwd')), group: masterNames(master('group')) }
}

function entries(file: string): string[][] {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => line.split(':'))
}

function assertIds(root: string, pinned: Ids, master: { passwd: Set<string>, group: Set<string> }): void {
  const users = new Map([...pinned.users, ...OPERATOR_ACCOUNTS.users].map(user => [user.name, passwdLine(user)]))
  for (const fieldsOf of entries(join(root, 'etc/passwd'))) {
    const name = fieldsOf[0]!
    if (master.passwd.has(name))
      continue
    const expected = users.get(name)
    if (!expected)
      fail(`system user ${name} (uid ${fieldsOf[2]}) is not pinned in ids.json`)
    if (fieldsOf.join(':') !== expected)
      fail(`system user ${name} is ${fieldsOf.join(':')}; ids.json pins ${expected}`)
  }
  const groups = new Map([...pinned.groups, ...OPERATOR_ACCOUNTS.groups].map(group => [group.name, String(group.gid)]))
  for (const [name = '', , gid] of entries(join(root, 'etc/group'))) {
    if (master.group.has(name))
      continue
    const expected = groups.get(name)
    if (!expected)
      fail(`system group ${name} (gid ${gid}) is not pinned in ids.json`)
    if (gid !== expected)
      fail(`system group ${name} has gid ${gid}; ids.json pins ${expected}`)
  }
}

function assertInventory(root: string, selected: Row[]): void {
  const format = '-f=${Package}\t${Version}\t${Architecture}\t${db:Status-Status}\n'
  const installed = output(['dpkg-query', `--admindir=${root}/var/lib/dpkg`, '-W', format], 'reading the installed package set')
    .split('\n')
    .filter(Boolean)
    .sort()
  const expected = selected.map(row => `${row.name}\t${row.version}\t${row.architecture}\tinstalled`).sort()
  const extra = installed.filter(line => !expected.includes(line))
  const absent = expected.filter(line => !installed.includes(line))
  if (extra.length || absent.length)
    fail(`installed package set differs from the lock\n  not in the lock: ${extra.join(', ') || '(none)'}\n  not installed: ${absent.join(', ') || '(none)'}`)
  const audit = capture(['dpkg', `--root=${root}`, '--audit'])
  if (audit.code !== 0 || audit.stdout.trim())
    fail(`dpkg --audit reported: ${audit.stdout.trim() || audit.stderr.trim()}`)
  if (existsSync(join(root, 'usr/bin/apt')) || existsSync(join(root, 'usr/bin/apt-get')))
    fail('APT was installed unexpectedly')
}

// Does not follow symlinks: an absolute one would escape the root.
export function nonDirectories(directory: string, depth = 1): { path: string, depth: number, name: string }[] {
  if (!existsSync(directory))
    return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? nonDirectories(path, depth + 1) : [{ path, depth, name: entry.name }]
  })
}

// Essential packages are extracted without dpkg filters: prune what the filters would have kept out.
function pruneExcluded(root: string): void {
  for (const tree of ['usr/share/info', 'usr/share/lintian', 'usr/share/locale', 'usr/share/man']) {
    for (const entry of nonDirectories(join(root, tree)))
      rmSync(entry.path)
  }
  for (const entry of nonDirectories(join(root, 'usr/share/doc'))) {
    if (entry.depth > 1 && entry.name !== 'copyright')
      rmSync(entry.path)
  }
}

// Drops mmdebstrap residue; the exclusions stay for later dpkg runs.
function cleanRoot(root: string, work: string, mirror: string, suite: string): void {
  pruneExcluded(root)
  rmSync(join(root, 'etc/dpkg/dpkg.cfg.d/99mmdebstrap'), { force: true })
  rmSync(join(root, 'etc/apt/apt.conf.d/99mmdebstrap'), { force: true })
  writeFileSync(join(root, 'etc/dpkg/dpkg.cfg.d/mica-slim'), `${SLIM.map(line => line.replace('=', ' ')).join('\n')}\n`)
  writeFileSync(join(root, 'etc/apt/sources.list'), `deb ${mirror} ${suite} main\n`)
  // mmdebstrap copies the build host's /etc/hostname -- a container ID that differs
  // per run and per architecture. The image's default is fixed; STATE overrides it.
  writeFileSync(join(root, 'etc/hostname'), `${HOSTNAME}\n`)
  // pwconv dates every shadow entry with the build day; the root carries one pinned day.
  for (const file of SHADOW_FILES.map(name => join(root, name)).filter(path => existsSync(path))) {
    const lines = readFileSync(file, 'utf8').split('\n')
    writeFileSync(file, lines.map(line => line ? line.split(':').map((field, index) => index === 2 ? SHADOW_LAST_CHANGE : field).join(':') : line).join('\n'))
  }
  for (let directory = join(root, work, 'repo'); directory.length > root.length && existsSync(directory); directory = join(directory, '..')) {
    if (directory === join(root, 'tmp'))
      break
    rmdirSync(directory)
  }
}

// The floor's command set is busybox. The GNU packages (STRIPPED) were installed
// with the rest, so every maintainer script ran with the tools it was written for;
// here they are purged and each command of theirs that busybox has becomes a link to
// it, at the path the package had it: the replacement is exactly what was removed,
// and no applet busybox merely has (login, getty, telnetd) appears. While they go,
// the same links bridge in /usr/local/bin, ahead of /usr/bin on dpkg's PATH, for the
// maintainer scripts of the packages being purged. /usr/bin/sh is diverted to busybox
// first, the way Debian lets /bin/sh be changed: dash's own postrm runs through it.
function strip(root: string): void {
  const inRoot = (command: string[], what: string): string => output(['chroot', root, ...command], what)
  const applets = new Set(inRoot(['/usr/bin/busybox', '--list'], 'listing the busybox applets').split('\n').filter(Boolean))
  const replaced = inRoot(['dpkg-query', '-L', ...STRIPPED], `listing ${STRIPPED.join(', ')}`).split('\n')
    .filter(path => /^\/(?:usr\/)?s?bin\/[^/]+$/.test(path) && applets.has(basename(path)))
  const bridge = join(root, 'usr/local/bin')
  const bridged = [...new Set(replaced.map(path => basename(path)))]
  for (const command of bridged)
    symlinkSync('/usr/bin/busybox', join(bridge, command))
  inRoot(['dpkg-divert', '--quiet', '--local', '--rename', '--divert', '/usr/bin/sh.distrib', '--add', '/usr/bin/sh'], 'diverting /usr/bin/sh')
  symlinkSync('busybox', join(root, 'usr/bin/sh'))
  const gnu = STRIPPED.filter(name => name !== 'dash')
  inRoot(['dpkg', '--purge', '--force-remove-essential', '--force-depends', ...gnu], `purging ${gnu.join(', ')}`)
  inRoot(['dpkg', '--purge', '--force-remove-essential', '--force-depends', 'dash'], 'purging dash')
  inRoot(['dpkg-divert', '--quiet', '--local', '--no-rename', '--remove', '/usr/bin/sh'], 'removing the /usr/bin/sh diversion')
  for (const path of replaced.filter(path => path !== '/usr/bin/sh' && path !== '/bin/sh')) {
    const target = join(root, path)
    if (!existsSync(target) && !lstatExists(target))
      symlinkSync('/usr/bin/busybox', target)
  }
  for (const command of bridged)
    rmSync(join(bridge, command))
  // Nobody logs in with a shell the floor does not have.
  inRoot(['usermod', '--shell', '/bin/sh', 'root'], 'giving root /bin/sh')
}

export async function bootstrap(options: Options, selected: Row[]): Promise<void> {
  const root = options.root!
  const arch = options.arch!
  if (process.getuid?.() !== 0)
    fail('installation requires root')
  need('dpkg-deb')
  need('mmdebstrap')
  await verifyRows(options.cacheDir, selected)
  if (output(['dpkg', '--print-architecture'], 'reading the host architecture').trim() !== arch)
    fail(`installation requires a native ${arch} host`)
  const pinned = ids()
  const { mirror, suite } = sources()
  mkdirSync(dirname(root), { recursive: true })
  const work = mkdtempSync(join(tmpdir(), 'debian-base-bootstrap.'))
  const local = options.local ? await localRows(options.local, arch) : []
  const installing = [...selected, ...local.map(entry => entry.row)]
  try {
    renderRepo(join(work, 'repo'), options.cacheDir, installing, new Map(local.map(entry => [entry.row.sha256, entry.path])))
    const master = writeSeed(work, options.cacheDir, selected, pinned)
    const code = attached([
      'mmdebstrap',
      '--mode=root',
      '--variant=custom',
      `--architectures=${arch}`,
      `--include=${installing.map(row => row.name).join(',')}`,
      ...SLIM.map(line => `--dpkgopt=${line}`),
      '--aptopt=Acquire::Languages "none"',
      '--hook-dir=/usr/share/mmdebstrap/hooks/file-mirror-automount',
      `--setup-hook=upload ${work}/seed/passwd /etc/passwd`,
      `--setup-hook=upload ${work}/seed/group /etc/group`,
      suite,
      root,
      `deb [trusted=yes] file://${work}/repo ./`,
    ])
    if (code !== 0)
      fail(`mmdebstrap failed (exit ${code}); the partial root is left at ${root}`)
    cleanRoot(root, work, mirror, suite)
    if (local.length)
      strip(root)
    assertInventory(root, local.length ? installing.filter(row => !STRIPPED.includes(row.name)) : installing)
    assertIds(root, pinned, master)
    if (local.length) {
      writeRelease(root)
      assertBase(root)
    }
  }
  finally {
    rmSync(work, { recursive: true, force: true })
  }
  console.log(`debian-base: bootstrapped ${selected.length} locked packages${local.length ? ` and ${local.length} of this repository's` : ''} into ${root} with mmdebstrap`)
}
