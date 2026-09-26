// Check selected rows at the archive boundary: bytes and control fields.

import type { Row } from './lock.ts'
import { existsSync, statSync } from 'node:fs'
import { fail } from './errors.ts'
import { capture } from './exec.ts'

export async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256')
  for await (const chunk of Bun.file(path).stream())
    hasher.update(chunk)
  return hasher.digest('hex')
}

export function archivePath(cacheDir: string, sha256: string): string {
  return `${cacheDir}/sha256/${sha256}`
}

export async function verifyRows(cacheDir: string, rows: Row[]): Promise<void> {
  for (const row of rows) {
    if (!/^[a-f0-9]{64}$/.test(row.sha256))
      fail('invalid rendered archive checksum')
    const file = archivePath(cacheDir, row.sha256)
    if (!existsSync(file) || statSync(file).size === 0)
      fail(`cache is missing: ${file}`)
    if (await sha256File(file) !== row.sha256)
      fail(`SHA256 mismatch: ${file}`)
    const fields = capture(['dpkg-deb', '-W', '--showformat=${Package}\t${Version}\t${Architecture}', file])
    if (fields.code !== 0 || fields.stdout !== `${row.name}\t${row.version}\t${row.architecture}`)
      fail(`package metadata mismatch: ${file}`)
  }
  if (!rows.length)
    fail('rendered package selection is empty')
}
