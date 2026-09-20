// Commands inside the environment image: cache | verify | select | bootstrap | pin-inputs | unowned.
import type { Options } from './args.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { parse, USAGE } from './args.ts'
import { bootstrap } from './bootstrap.ts'
import { populate } from './cache.ts'
import { fail, report } from './errors.ts'
import { need } from './exec.ts'
import { formatRows, selectBuild, selectInputs, selectRuntime } from './lock.ts'
import { resolveBuild, resolveInputs, resolveUpstream } from './pin-inputs.ts'
import { REPO, requireBun } from './pins.ts'
import { formatUnowned, unownedPaths } from './unowned.ts'
import { verifyRows } from './verify.ts'

const COMMANDS = ['cache', 'verify', 'select', 'bootstrap', 'pin-inputs', 'unowned']

// Cache runs from different containers share one directory: lock with flock(1).
function underCacheLock(cacheDir: string): number | undefined {
  if (process.env.MICA_BASE_CACHE_LOCKED === cacheDir)
    return undefined
  need('flock')
  mkdirSync(cacheDir, { recursive: true })
  const child = Bun.spawnSync(['flock', '-x', `${cacheDir}/.lock`, process.execPath, ...process.argv.slice(1)], {
    stdio: ['inherit', 'inherit', 'inherit'],
    env: { ...process.env, MICA_BASE_CACHE_LOCKED: cacheDir },
  })
  return child.exitCode ?? 1
}

async function main(options: Options): Promise<number> {
  requireBun()
  if (!options.arch && options.command !== 'unowned')
    fail('--arch is required')
  const arch = options.arch!
  if (options.command === 'pin-inputs') {
    if (options.selection.kind === 'package')
      await resolveBuild(options.selection.name, arch, options.output)
    else if (options.selection.kind === 'consumers')
      await resolveUpstream(options.selection.file, arch, options.output)
    else
      await resolveInputs(arch, options.output)
    return 0
  }
  if (options.command === 'unowned') {
    if (!options.root || !options.output)
      fail('unowned requires --root and --output')
    writeFileSync(options.output, formatUnowned(unownedPaths(options.root)))
    return 0
  }
  const selected = selectRuntime(REPO, arch, options.selection)
  const pinned = options.selection.kind === 'package' ? [] : [...selectInputs(REPO, arch), ...selectBuild(REPO, arch)]
  switch (options.command) {
    case 'select':
      console.log(formatRows(selected))
      return 0
    case 'verify':
      need('dpkg-deb')
      await verifyRows(options.cacheDir, [...pinned, ...selected])
      console.log(`debian-base: verified ${selected.length} packages in ${options.cacheDir}`)
      return 0
    case 'cache':
      need('dpkg-deb')
      await populate(options.cacheDir, [...pinned, ...selected], selected.length)
      return 0
    default:
      await bootstrap(options, selected)
      return 0
  }
}

if (import.meta.main) {
  try {
    const options = parse(process.argv.slice(2), COMMANDS)
    if (!options) {
      console.log(USAGE)
    }
    else {
      const locked = options.command === 'cache' ? underCacheLock(options.cacheDir) : undefined
      process.exitCode = locked ?? await main(options)
    }
  }
  catch (error) {
    process.exitCode = report(error)
  }
}
