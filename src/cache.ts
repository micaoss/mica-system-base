// Download missing archives: the only network path and the only mirror reader.

import type { Row } from './lock.ts'
import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fail } from './errors.ts'
import { archivePath, sha256File, verifyRows } from './verify.ts'

interface Mirror { kind: 'pool' | 'snapshot', base: string }

export function parseMirror(value: string | undefined): Mirror | undefined {
  if (!value)
    return undefined
  const match = /^(?:(pool|snapshot):)?(https:\/\/.*)$/.exec(value)
  if (!match)
    fail(`MICA_BASE_MIRROR must be an https:// base, optionally prefixed with pool: or snapshot: -- got ${value}`)
  return { kind: match[1] === 'snapshot' ? 'snapshot' : 'pool', base: match[2]!.replace(/\/$/, '') }
}

// pool: <base>/pool/<path>, where superseded pins 404 and fall back; snapshot: host replaced.
export function mirrorUrl(mirror: Mirror, url: string): string | undefined {
  if (mirror.kind === 'pool') {
    const index = url.indexOf('/pool/')
    return index < 0 ? undefined : `${mirror.base}/pool/${url.slice(index + '/pool/'.length)}`
  }
  const host = 'https://snapshot.debian.org/'
  return url.startsWith(host) ? `${mirror.base}/${url.slice(host.length)}` : undefined
}

const ABSENT = 44

function deadlineSeconds(): number {
  const value = process.env.MICA_BASE_FETCH_DEADLINE ?? '600'
  if (!/^[1-9]\d*$/.test(value))
    fail(`MICA_BASE_FETCH_DEADLINE must be a whole number of seconds -- got ${value}`)
  return Number(value)
}

// The hard ceiling is a SIGKILL from outside: a wedged event loop cannot fire fetch.ts's timer.
async function fetchTo(url: string, destination: string, deadline: number): Promise<number> {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fetch.ts'), url, destination], {
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: deadline * 1000,
    killSignal: 'SIGKILL',
  })
  const code = await child.exited
  if (child.signalCode === 'SIGKILL')
    fail(`download exceeded the ${deadline}s ceiling and was killed: ${url}`)
  return code
}

export async function populate(cacheDir: string, archives: Row[], selectedCount: number): Promise<void> {
  const mirror = parseMirror(process.env.MICA_BASE_MIRROR)
  const deadline = deadlineSeconds()
  mkdirSync(join(cacheDir, 'debs'), { recursive: true })
  const work = mkdtempSync(join(cacheDir, '.download.'))
  let downloaded = 0
  let fromMirror = 0
  let fromPin = 0
  try {
    for (const row of archives) {
      const target = archivePath(cacheDir, row.sha256)
      if (await Bun.file(target).exists())
        continue
      const partial = join(work, `${row.sha256}.deb`)
      let source: string | undefined
      const alternate = mirror && mirrorUrl(mirror, row.url)
      if (alternate) {
        const code = await fetchTo(alternate, partial, deadline)
        if (code === 0) {
          source = alternate
          fromMirror++
        }
        else if (code !== ABSENT) {
          fail(`mirror download failed for ${row.name}: ${alternate}`)
        }
      }
      if (!source) {
        if (await fetchTo(row.url, partial, deadline) !== 0)
          fail(`download failed for ${row.name}: ${row.url}`)
        source = row.url
        fromPin++
      }
      // Wrong bytes mean a wrong mirror, never a reason to fall back.
      if (await sha256File(partial) !== row.sha256)
        fail(`SHA256 mismatch downloading ${row.name} from ${source}`)
      renameSync(partial, target)
      downloaded++
    }
  }
  finally {
    rmSync(work, { recursive: true, force: true })
  }
  await verifyRows(cacheDir, archives)
  const split = mirror ? ` (${fromMirror} from the mirror, ${fromPin} from the pinned URL)` : ''
  console.log(`debian-base: verified ${selectedCount} packages; downloaded ${downloaded} archives${split}; cache ${cacheDir}`)
  if (mirror && fromMirror === 0 && fromPin > 0)
    console.error(`debian-base: warning: ${mirror.base} served none of the ${fromPin} archive(s) downloaded; it is configured and doing nothing`)
}
