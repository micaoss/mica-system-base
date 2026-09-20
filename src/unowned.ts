// Every path of a base root that no package claims, with the thing that wrote it.
//
// A composer that proves a declaration by package ownership has nothing to prove
// a generated path with, and nothing compares the set it declares against the set
// a root actually has. This is that set: one row per path, tab-separated, sorted
// by path, `<path>\t<writer>`. The writer is what a consumer cannot derive -- a
// generated rule names its generator -- so it is read out of the root itself: the
// maintainer scripts that name the path, the generators those scripts run, and
// the few paths this repository writes with its own code. A path whose writer
// cannot be established says `unknown`, which is a work item, not a guess.
import { readdirSync, readFileSync, lstatSync } from 'node:fs'
import { join } from 'node:path'

// What the build of this repository writes itself, with the code that writes it.
const OURS: Record<string, string> = {
  '/etc/passwd': 'bootstrap seed (src/bootstrap.ts writeSeed) and useradd',
  '/etc/passwd-': 'useradd backup of the bootstrap seed',
  '/etc/group': 'bootstrap seed (src/bootstrap.ts writeSeed) and groupadd',
  '/etc/group-': 'groupadd backup of the bootstrap seed',
  '/etc/shadow': 'pwconv (passwd.postinst shadowconfig), last-change day set by src/bootstrap.ts cleanRoot',
  '/etc/shadow-': 'pwconv backup, last-change day set by src/bootstrap.ts cleanRoot',
  '/etc/gshadow': 'grpconv (passwd.postinst shadowconfig)',
  '/etc/gshadow-': 'grpconv backup',
  '/etc/apt/sources.list': 'src/bootstrap.ts cleanRoot',
  '/etc/hostname': 'src/bootstrap.ts cleanRoot',
  '/etc/dpkg/dpkg.cfg.d/mica-slim': 'src/bootstrap.ts cleanRoot',
  '/etc/.pwd.lock': 'passwd tools (lock file of useradd and friends)',
}

// Generators a maintainer script runs, keyed by the paths they write.
const GENERATED: { match: RegExp, writer: string }[] = [
  { match: /^\/etc\/pam\.d\/common-/, writer: 'pam-auth-update (libpam-runtime.postinst)' },
  { match: /^\/var\/lib\/pam\//, writer: 'pam-auth-update (libpam-runtime.postinst)' },
  { match: /^\/etc\/ld\.so\.cache$/, writer: 'ldconfig (libc-bin.postinst)' },
  { match: /^\/usr\/lib\/udev\/hwdb\.bin$/, writer: 'systemd-hwdb update (udev.postinst)' },
  { match: /^\/etc\/security\/opasswd$/, writer: 'pam_unix (libpam-modules.postinst)' },
  { match: /^\/etc\/machine-id$/, writer: 'systemd-machine-id-setup (systemd.postinst); regenerated on the device' },
  { match: /^\/var\/lib\/apt\/lists\//, writer: 'apt (the mmdebstrap bootstrap)' },
  { match: /^\/etc\/(?:subuid|subgid)-$/, writer: 'useradd backup' },
]

// Generators that write one path per unit or script name, so the caller is the
// package whose maintainer script names that unit: deb-systemd-helper for the
// enablement state and its links, update-rc.d for the sysv links.
const PER_UNIT: { match: RegExp, name: (path: string) => string, writer: string }[] = [
  { match: /^\/var\/lib\/systemd\/deb-systemd-helper-enabled\//, name: path => path.split('/').pop()!.replace(/\.dsh-also$/, ''), writer: 'deb-systemd-helper' },
  { match: /^\/etc\/systemd\/system\/[^/]+\.(?:wants|requires)\//, name: path => path.split('/').pop()!, writer: 'deb-systemd-helper' },
  { match: /^\/etc\/systemd\/system\/[^/]+\.service$/, name: path => path.split('/').pop()!, writer: 'deb-systemd-helper (an alias or a dbus name link)' },
  { match: /^\/etc\/rc[0-6S]\.d\//, name: path => path.split('/').pop()!.replace(/^[SK]\d+/, ''), writer: 'update-rc.d' },
]

// What a root holds and what its packages claim.
function rootPaths(root: string, skip: RegExp): string[] {
  const walk = (relative: string): string[] => readdirSync(join(root, relative || '.'), { withFileTypes: true }).flatMap((entry) => {
    const path = relative ? `${relative}/${entry.name}` : entry.name
    return entry.isDirectory() && !lstatSync(join(root, path)).isSymbolicLink() ? walk(path) : [path]
  })
  return walk('').map(path => `/${path}`).filter(path => !skip.test(path))
}

// Directories a root fills at runtime or that describe the packaging itself.
const SKIP = /^\/(dev|proc|sys|run|tmp|mnt|mica|home|srv|root|boot)\/|^\/var\/(lib\/dpkg|log|cache)\/|^\/usr\/share\/doc\//

// Paths systemd-tmpfiles creates from a tmpfiles.d entry. A maintainer script's
// dh_installtmpfiles section runs it at install time, so the path is in the root
// with no package owning it and no script naming it -- the rule file names it
// instead. /etc/vconsole.conf is the one this repository could not attribute
// until the entry was read: a dangling compatibility symlink, which is neither a
// present file nor an absent path, and is exactly the kind of thing a composer
// drops without noticing.
function tmpfilesEntries(root: string): Map<string, string> {
  const entries = new Map<string, string>()
  for (const directory of ['usr/lib/tmpfiles.d', 'etc/tmpfiles.d']) {
    let names: string[]
    try {
      names = readdirSync(join(root, directory))
    }
    catch {
      continue
    }
    for (const name of names.filter(file => file.endsWith('.conf'))) {
      for (const line of readFileSync(join(root, directory, name), 'utf8').split('\n')) {
        const [type, path] = line.trim().split(/\s+/)
        // The types that create a path; the rest act on one that already exists.
        if (!type || !/^[LdDfFCwpvqQbch][+=!-]*$/.test(type) || !path?.startsWith('/') || entries.has(path))
          continue
        entries.set(path, `/${directory}/${name}`)
      }
    }
  }
  return entries
}

export interface UnownedPath { path: string, writer: string }

export function unownedPaths(root: string): UnownedPath[] {
  const info = join(root, 'var/lib/dpkg/info')
  const owned = new Set<string>()
  for (const file of readdirSync(info).filter(name => name.endsWith('.list'))) {
    for (const line of readFileSync(join(info, file), 'utf8').split('\n')) {
      if (line)
        owned.add(line)
    }
  }
  const scripts = readdirSync(info).filter(name => /\.(?:pre|post)(?:inst|rm)$/.test(name) || name.endsWith('.config'))
    .map(name => ({ name, text: readFileSync(join(info, name), 'utf8') }))
  const alternatives = scripts.filter(script => script.text.includes('update-alternatives'))
  const tmpfiles = tmpfilesEntries(root)
  return rootPaths(root, SKIP).filter(path => !owned.has(path)).sort().map((path) => {
    const generated = GENERATED.find(rule => rule.match.test(path))
    const link = path.startsWith('/etc/alternatives/') ? path.slice('/etc/alternatives/'.length) : ''
    const named = scripts.filter(script => script.text.includes(` ${path}\n`) || script.text.includes(`${path} `) || script.text.includes(`"${path}"`) || script.text.includes(`${path}"`))
    const unit = PER_UNIT.find(rule => rule.match.test(path))
    const caller = unit ? scripts.filter(script => script.text.includes(unit.name(path))).map(script => script.name) : []
    const writer = OURS[path]
      ?? generated?.writer
      ?? (tmpfiles.has(path) ? `systemd-tmpfiles (${tmpfiles.get(path)})` : undefined)
      ?? (link ? `update-alternatives (${alternatives.filter(script => script.text.includes(`/etc/alternatives/${link}`) || script.text.includes(` ${link} `)).map(script => script.name).join(', ') || 'unknown caller'})` : undefined)
      ?? (named.length ? named.map(script => script.name).join(', ') : undefined)
      ?? (unit ? `${unit.writer} (${caller.join(', ') || 'unknown caller'})` : 'unknown')
    return { path, writer }
  })
}

// The file a release publishes. The header carries what the run log would
// otherwise be the only witness of: how many paths this root holds that no
// package claims, and how many of them this repository could not attribute. A
// reader three months from now has the counts beside the rows and can check one
// against the other; a number that lives only in a CI log is attention, not an
// instrument. (The single unattributed row this artefact once carried was found
// by hand, not by anything that read the file.)
export const UNOWNED_HEADER = '# mica-unowned v1'

export function formatUnowned(rows: UnownedPath[]): string {
  const unknown = rows.filter(row => row.writer === 'unknown').length
  const header = `${UNOWNED_HEADER}: ${rows.length} paths no package claims, ${unknown} without a named writer`
  return `${[header, ...rows.map(row => `${row.path}\t${row.writer}`)].join('\n')}\n`
}
