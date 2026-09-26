// Download missing archives into the source cache (mica:docs/design/release-lock.md
// section 5): <cache>/sha256/<sha256>, fetched by mica-build-tools' `repos get`,
// which tries MICA_MIRROR first, falls back to the row's URL, holds each download
// to MICA_FETCH_DEADLINE and checks the sha256 whichever source served.

import type { Row } from './lock.ts'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reposGet } from '@mica/build-tools'
import { archivePath, verifyRows } from './verify.ts'

export async function populate(cacheDir: string, archives: Row[], selectedCount: number): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), 'mica-cache-'))
  let fromMirror = 0
  let fromPin = 0
  try {
    for (const row of archives) {
      if (existsSync(archivePath(cacheDir, row.sha256)))
        continue
      const source = await reposGet(cacheDir, row.sha256, row.url, join(work, row.sha256))
      rmSync(join(work, row.sha256))
      if (source === row.url)
        fromPin++
      else
        fromMirror++
    }
  }
  finally {
    rmSync(work, { recursive: true, force: true })
  }
  await verifyRows(cacheDir, archives)
  const split = process.env.MICA_MIRROR ? ` (${fromMirror} from the mirror, ${fromPin} from the pinned URL)` : ''
  console.log(`debian-base: verified ${selectedCount} packages; downloaded ${fromMirror + fromPin} archives${split}; cache ${cacheDir}`)
  if (process.env.MICA_MIRROR && fromMirror === 0 && fromPin > 0)
    console.error(`debian-base: warning: ${process.env.MICA_MIRROR} served none of the ${fromPin} archive(s) downloaded; it is configured and doing nothing`)
}
