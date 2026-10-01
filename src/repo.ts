// A flat file:// repository holding exactly the selected archives.

import type { Row } from './lock.ts'
import { copyFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { output } from './exec.ts'
import { archivePath } from './verify.ts'

export function renderRepo(directory: string, cacheDir: string, rows: Row[], local: Map<string, string> = new Map()): void {
  mkdirSync(join(directory, 'debs'), { recursive: true })
  const stanzas = rows.map((row) => {
    const source = local.get(row.sha256) ?? archivePath(cacheDir, row.sha256)
    copyFileSync(source, join(directory, 'debs', `${row.sha256}.deb`))
    const control = output(['dpkg-deb', '-f', source], `reading the control fields of ${row.name}`).trimEnd()
    return `${control}\nFilename: debs/${row.sha256}.deb\nSize: ${statSync(source).size}\nSHA256: ${row.sha256}\n`
  })
  writeFileSync(join(directory, 'Packages'), stanzas.join('\n'))
}
