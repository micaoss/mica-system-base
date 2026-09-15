// Run the payload's device scripts -- the files that ship under payload/ -- against
// fixtures, with every external command they call replaced by a fake on PATH.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const PAYLOAD = resolve(import.meta.dir, '../../payload')
export const MICA = join(PAYLOAD, 'usr/lib/mica')

export interface Ran { code: number, out: string }

export function sandbox(label: string): { dir: string, done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `${label}.`))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

// An executable /bin/sh fake: `body` is shell source, expanded when the fake runs.
export function fake(bin: string, name: string, body: string): void {
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
  chmodSync(join(bin, name), 0o755)
}

// Runs with exactly `env` (nothing inherited), stdout and stderr interleaved.
export function exec(command: string[], env: Record<string, string>): Ran {
  const result = Bun.spawnSync(command, { env, stdout: 'pipe', stderr: 'pipe' })
  return { code: result.exitCode ?? 1, out: result.stdout.toString() + result.stderr.toString() }
}

export const SYSTEM_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
