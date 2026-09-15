// Pack one staged tree into a .deb, inside the environment image: the packaging
// contract every package of this repository is built under.
//
// A control template carries @VERSION@ and @ARCH@ and never Installed-Size or
// the provenance fields: those are computed or written here, so no template
// value can stop matching the archive. Every payload mtime is set to
// SOURCE_DATE_EPOCH, every path is root/root, md5sums are sorted, and the packed
// payload is compared with the staged tree before the archive is accepted.
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fail } from '../errors.ts'
import { capture, output } from '../exec.ts'

export interface Provenance {
  version: string
  repository: string
  commit: string
  epoch: number
}

export interface PackRequest {
  stage: string
  control: string
  arch: 'amd64' | 'arm64' | 'all'
  out: string
  provenance: Provenance
  // Maintainer scripts by name (preinst, postinst, prerm, postrm) -> file.
  scripts?: Record<string, string>
  // Values for ${name} substitutions in Depends, e.g. shlibs:Depends.
  substitutions?: Record<string, string>
}

const MAINTAINER_SCRIPTS = new Set(['preinst', 'postinst', 'prerm', 'postrm'])
const REQUIRED = ['Package', 'Version', 'Architecture', 'Maintainer', 'Section', 'Priority', 'Description']

// Top-level fields of a control file, continuation lines folded.
export function controlFields(text: string): Map<string, string> {
  const fields = new Map<string, string>()
  let current: string | undefined
  for (const line of text.split('\n')) {
    if (/^[ \t]/.test(line) && current) {
      fields.set(current, `${fields.get(current)}\n${line}`)
      continue
    }
    const index = line.indexOf(':')
    current = index > 0 ? line.slice(0, index) : undefined
    if (current)
      fields.set(current, line.slice(index + 1).trim())
  }
  return fields
}

function walk(root: string, relative = ''): string[] {
  const entries: string[] = []
  for (const name of readdirSync(join(root, relative)).sort()) {
    const path = relative ? `${relative}/${name}` : name
    entries.push(path)
    const stats = lstatSync(join(root, path))
    if (stats.isDirectory())
      entries.push(...walk(root, path))
  }
  return entries
}

// dpkg-deb's Installed-Size: KiB per regular file or symlink, one per other entry.
export function installedSize(root: string): number {
  let total = 0
  for (const path of walk(root)) {
    if (path === 'DEBIAN' || path.startsWith('DEBIAN/'))
      continue
    const stats = lstatSync(join(root, path))
    total += stats.isFile() || stats.isSymbolicLink() ? Math.ceil(stats.size / 1024) : 1
  }
  return total
}

export function renderControl(template: string, request: PackRequest, size: number): string {
  const { provenance } = request
  const fields = controlFields(template)
  for (const field of REQUIRED) {
    if (!fields.get(field))
      fail(`${request.control} declares no ${field}`)
  }
  for (const field of ['Installed-Size', 'Mica-Source-Repo', 'Mica-Source-Commit']) {
    if (fields.has(field))
      fail(`${request.control} declares ${field}, which the packer computes or writes`)
  }
  if (!fields.get('Version')!.includes('@VERSION@'))
    fail(`${request.control} has a Version without @VERSION@`)
  if (!fields.get('Architecture')!.includes('@ARCH@'))
    fail(`${request.control} has an Architecture without @ARCH@`)
  if (!/^[A-Z0-9][\w.-]*$/i.test(provenance.repository))
    fail(`'${provenance.repository}' is not a repository name`)
  if (!/^[0-9a-f]{40}$/.test(provenance.commit))
    fail(`'${provenance.commit}' is not a full 40-hex commit id`)
  let text = template.replaceAll('@VERSION@', provenance.version).replaceAll('@ARCH@', request.arch)
  for (const [name, value] of Object.entries(request.substitutions ?? {})) {
    if (!value)
      fail(`the substitution \${${name}} is empty; it would leave a dangling separator in ${request.control}`)
    text = text.replaceAll(`\${${name}}`, value)
  }
  // Only relationship fields are substituted; a description may quote ${...} as prose.
  for (const [name, value] of controlFields(text)) {
    if (/^(?:Pre-)?Depends$|^Recommends$|^Suggests$|^Provides$|^Conflicts$|^Breaks$|^Replaces$/.test(name) && /\$\{[^}]+\}/.test(value))
      fail(`${request.control} still carries an unexpanded substitution in ${name}`)
  }
  return `${text.replace(/\n+$/, '')}\nInstalled-Size: ${size}\nMica-Source-Repo: ${provenance.repository}\nMica-Source-Commit: ${provenance.commit}\n`
}

async function md5(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('md5')
  hasher.update(readFileSync(path))
  return hasher.digest('hex')
}

function setMtimes(root: string, epoch: number): void {
  for (const path of [...walk(root), '']) {
    const full = join(root, path)
    if (lstatSync(full).isSymbolicLink())
      output(['touch', '--no-dereference', `--date=@${epoch}`, full], `setting the mtime of ${path}`)
    else
      utimesSync(full, epoch, epoch)
  }
}

export async function pack(request: PackRequest): Promise<string> {
  const { stage, provenance } = request
  if (!Number.isInteger(provenance.epoch) || provenance.epoch < 0)
    fail('SOURCE_DATE_EPOCH must be a whole number of seconds')
  if (!existsSync(stage) || !statSync(stage).isDirectory() || !readdirSync(stage).length)
    fail(`${stage} is not a non-empty staged tree`)
  if (existsSync(join(stage, 'DEBIAN')))
    fail(`${stage} already carries DEBIAN, which the packer owns`)
  const template = readFileSync(request.control, 'utf8')
  const work = join(request.out, `.pack-${basename(request.control)}-${process.pid}`)
  rmSync(work, { recursive: true, force: true })
  try {
    const root = join(work, 'root')
    cpSync(stage, root, { recursive: true, verbatimSymlinks: true })
    const control = renderControl(template, request, installedSize(root))
    const packageName = controlFields(control).get('Package')!
    if (!/^[a-z0-9][a-z0-9+.-]+$/.test(packageName))
      fail(`'${packageName}' is not a Debian package name`)
    mkdirSync(join(root, 'DEBIAN'), { mode: 0o755 })
    writeFileSync(join(root, 'DEBIAN/control'), control, { mode: 0o644 })
    const sums: string[] = []
    for (const path of walk(root).filter(path => !path.startsWith('DEBIAN')).sort()) {
      if (lstatSync(join(root, path)).isFile())
        sums.push(`${await md5(join(root, path))}  ${path}`)
    }
    writeFileSync(join(root, 'DEBIAN/md5sums'), sums.length ? `${sums.join('\n')}\n` : '', { mode: 0o644 })
    for (const [name, file] of Object.entries(request.scripts ?? {})) {
      if (!MAINTAINER_SCRIPTS.has(name))
        fail(`'${name}' is not a maintainer script dpkg runs`)
      writeFileSync(join(root, 'DEBIAN', name), readFileSync(file))
      chmodSync(join(root, 'DEBIAN', name), 0o755)
    }
    output(['chown', '-Rh', '0:0', root], 'owning the staged tree as root')
    setMtimes(root, provenance.epoch)
    mkdirSync(request.out, { recursive: true })
    const deb = join(request.out, `${packageName}_${provenance.version}_${request.arch}.deb`)
    rmSync(deb, { force: true })
    const built = capture(['dpkg-deb', '--build', '--root-owner-group', root, deb], { ...process.env, SOURCE_DATE_EPOCH: String(provenance.epoch) })
    if (built.code !== 0)
      fail(`dpkg-deb --build ${packageName} failed: ${built.stderr.trim()}`)
    const packed = controlFields(output(['dpkg-deb', '--field', deb], `reading ${basename(deb)}`))
    const want: Record<string, string> = { 'Package': packageName, 'Version': provenance.version, 'Architecture': request.arch, 'Mica-Source-Repo': provenance.repository, 'Mica-Source-Commit': provenance.commit }
    for (const [field, value] of Object.entries(want)) {
      if (packed.get(field) !== value)
        fail(`${basename(deb)} declares ${field}: ${packed.get(field) ?? '(none)'}, not ${value}`)
    }
    const listing = output(['dpkg-deb', '--contents', deb], `listing ${basename(deb)}`).split('\n').filter(Boolean)
    const foreign = listing.filter(line => line.split(/\s+/)[1] !== 'root/root')
    if (foreign.length)
      fail(`${basename(deb)} carries paths not owned by root/root: ${foreign.slice(0, 3).join('; ')}`)
    const paths = output(['sh', '-c', 'dpkg-deb --fsys-tarfile "$1" | tar --quoting-style=literal -tf -', 'paths', deb], `reading ${basename(deb)}`)
      .split('\n')
      .map(line => line.replace(/^\.\//, '').replace(/\/$/, ''))
      .filter(Boolean)
      .sort()
    const staged = walk(stage).sort()
    if (paths.join('\n') !== staged.join('\n'))
      fail(`the payload of ${basename(deb)} is not the staged tree`)
    return deb
  }
  finally {
    rmSync(work, { recursive: true, force: true })
  }
}
