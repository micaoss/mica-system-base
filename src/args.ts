// Option parsing and the refusals that need no lock, cache or container.

import type { Arch, Selection } from './lock.ts'
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fail } from './errors.ts'
import { ARCHES } from './lock.ts'
import { REPO } from './pins.ts'

export interface Options {
  command: string
  arch?: Arch
  cacheDir: string
  selection: Selection
  root?: string
  // A directory of this repository's own archives, installed with the selection.
  local?: string
  output?: string
  check: boolean
}

const VALUED = ['--arch', '--cache-dir', '--packages', '--package', '--root', '--output', '--local'] as const

// Resolves symlinks in the part of the path that exists, like `realpath -m`.
export function resolvePath(path: string): string {
  const absolute = resolve(path)
  if (existsSync(absolute))
    return realpathSync(absolute)
  const parent = dirname(absolute)
  return parent === absolute ? absolute : join(resolvePath(parent), basename(absolute))
}

function isEmptyDirectory(path: string): boolean {
  return statSync(path).isDirectory() && readdirSync(path).length === 0
}

export function parse(argv: string[], commands: string[]): Options | undefined {
  const command = argv[0] ?? '--help'
  if (command === '--help' || command === '-h')
    return undefined
  if (!commands.includes(command))
    fail(`unknown command: ${command}`)
  const values = new Map<string, string>()
  let all = false
  let check = false
  for (let index = 1; index < argv.length; index++) {
    const option = argv[index]!
    if ((VALUED as readonly string[]).includes(option)) {
      const value = argv[index + 1]
      if (!value || value.startsWith('--'))
        fail(`${option} requires a value`)
      values.set(option, value)
      index++
    }
    else if (option === '--all') {
      all = true
    }
    else if (option === '--check' && command === 'pin-inputs') {
      check = true
    }
    else {
      fail(`unknown option: ${option}`)
    }
  }
  const arch = values.get('--arch')
  if (!['test', 'pin-inputs', 'unowned'].includes(command)) {
    if (!arch)
      fail('--arch is required')
    if (!(ARCHES as string[]).includes(arch))
      fail(`unsupported architecture: ${arch}`)
  }
  const packagesFile = values.get('--packages')
  const packageName = values.get('--package')
  if (Number(all) + Number(packagesFile !== undefined) + Number(packageName !== undefined) > 1)
    fail('--all, --packages and --package are mutually exclusive')
  if (command === 'bootstrap' && packageName !== undefined)
    fail('--package cannot be used with bootstrap; select a complete system closure')
  if (command !== 'bootstrap' && values.has('--local'))
    fail('--local is only valid with bootstrap')
  if (!['bootstrap', 'unowned'].includes(command) && values.has('--root'))
    fail('--root is only valid with bootstrap and unowned')
  if (!['pin-inputs', 'unowned'].includes(command) && values.has('--output'))
    fail('--output is only valid with pin-inputs and unowned')

  const cacheDir = resolvePath(values.get('--cache-dir') ?? join(REPO, 'repos'))
  if (cacheDir === '/')
    fail('cache directory cannot be the host root')
  const options: Options = { command, cacheDir, check, selection: { kind: 'base' } }
  if (arch)
    options.arch = arch as Arch
  if (all)
    options.selection = { kind: 'all' }
  if (packagesFile !== undefined)
    options.selection = { kind: 'consumers', file: packagesFile }
  if (packageName !== undefined)
    options.selection = { kind: 'package', name: packageName }
  const output = values.get('--output')
  if (output !== undefined)
    options.output = resolvePath(output)

  if (command === 'unowned') {
    const given = values.get('--root')
    if (!given)
      fail('unowned requires --root')
    options.root = resolvePath(given)
  }
  if (command === 'bootstrap') {
    const given = values.get('--root')
    if (!given)
      fail('bootstrap requires --root')
    const root = resolvePath(given)
    if (root === '/')
      fail('installation cannot target the host root')
    if (existsSync(root) && !isEmptyDirectory(root))
      fail('installation root must be empty')
    if (`${cacheDir}/`.startsWith(`${root}/`))
      fail('installation root cannot contain the cache')
    if (`${root}/`.startsWith(`${cacheDir}/`))
      fail('installation root cannot be inside the cache')
    options.root = root
    const local = values.get('--local')
    if (local !== undefined)
      options.local = resolvePath(local)
  }
  return options
}

export const USAGE = `usage: bun src/container.ts cache|verify|select|bootstrap --arch amd64|arm64
       [--cache-dir PATH] [--packages FILE | --all | --package NAME] [--root PATH]
       bun src/container.ts pin-inputs [--check]
       bun src/container.ts test | test-bootstrap --arch amd64|arm64

container.ts runs each command through src/cli.ts inside the environment image
named by environment.json (localhost/mica-system-base-env:<arch>).

The default selection is the minimal Debian bootstrap floor. --packages names
local packages whose locked upstream dependencies are added to that floor.
--all selects every locked runtime package. --package selects one upstream
package for cache, verify or select; it excludes the base and the inputs.
select prints the selected rows of locks/upstream.lock.
cache downloads only missing archives (runtime and inputs) with mica-build-tools'
\`repos get\` and verifies their SHA256 and metadata. It is the only command
besides pin-inputs that touches the network. MICA_MIRROR names a mirror to
fetch through -- \`<base>\` or \`pool:<base>\` for a mirror serving /pool,
\`snapshot:<base>\` for a mirror of snapshot.debian.org; the mirror is tried
first and each record's own URL is the fallback, the committed SHA256 is checked
either way, and cache reports how many archives came from each.
MICA_FETCH_DEADLINE bounds one download (seconds, default 600).
bootstrap builds the selected root offline with the environment's mmdebstrap. It needs
CAP_SYS_ADMIN and an empty destination; a foreign architecture runs in a
BuildKit stage. No command installs APT into the root.
pin-inputs rewrites the rows of locks/upstream.lock it resolves: input.<name>
from the snapshot (the archives a package declares with inputs=),
build.<package>.<name> in the C image from the snapshot of
debs/<package>/build-sources.json (the closure of the packages it declares with
build=), and the closure of upstream.pkgs with its packages.tsv lines;
--check only compares.

Default cache: repos/sha256/<sha256>, the source cache of mica-build-tools. Version, architecture, URL
and SHA256 are pinned in locks/upstream.lock; packages.tsv names the consumers
that select each Debian package.`
