// The version a checkout builds and when it is a release.
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, expect, test } from 'bun:test'
import { ISSUE, issue, releaseOf } from '../src/release.ts'
import { run, workdir } from './fixture.ts'

const work = workdir('release')
afterAll(() => rmSync(work, { recursive: true, force: true }))

function git(...args: string[]): string {
  const result = run(['git', '-C', work, ...args], { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid', GIT_COMMITTER_DATE: '2026-09-14T01:02:59Z' })
  if (result.code !== 0)
    throw new Error(result.output)
  return result.output.trim()
}

test('a clean checkout whose HEAD carries one YYYYMMDD-HHMM tag is that release; anything else is a snapshot', () => {
  writeFileSync(join(work, 'package.json'), '{ "name": "mica-fixture" }\n')
  git('init', '-q')
  git('add', '.')
  git('commit', '-q', '-m', 'fixture')
  const commit = git('rev-parse', 'HEAD')
  const c12 = commit.slice(0, 12)

  // A snapshot is named by its commit's UTC minute.
  const snapshot = releaseOf(work)
  expect(snapshot).toMatchObject({ released: false, label: `20260914-0102~git${c12}`, commit })

  // Tags that are not release versions do not make a release.
  git('tag', 'v0.0.1')
  git('tag', '20260914-0110-rc')
  expect(releaseOf(work).released).toBe(false)

  git('tag', '20260914-0130')
  expect(releaseOf(work)).toMatchObject({ released: true, label: '20260914-0130', commit })

  writeFileSync(join(work, 'NOTES'), 'uncommitted\n')
  expect(releaseOf(work)).toMatchObject({ released: false, label: `20260914-0102~git${c12}.dirty` })
  rmSync(join(work, 'NOTES'))

  // One commit is one release; an impossible time is not a release version.
  git('tag', '20260915-0900')
  expect(() => releaseOf(work)).toThrow('more than one release tag')
  git('tag', '-d', '20260915-0900')
  git('tag', '20261301-0000')
  expect(() => releaseOf(work)).toThrow('20261301-0000 is not a UTC time')
})

// The banner names the Base, not a product: a product is composed later, so an
// unqualified "Mica OS <release>" would read as a product version it is not.
test('/etc/issue names the Base, its release, the build time and the commit', () => {
  const text = issue('20260914-0130', 'a'.repeat(40), '2026-09-14T01:40:00Z')
  expect(text).toBe(`Mica OS Base 20260914-0130 \\n \\l\nBuild: 2026-09-14T01:40:00Z\nCommit: ${'a'.repeat(40)}\n\n`)
  expect(ISSUE.exec(text)?.slice(1)).toEqual(['20260914-0130', '2026-09-14T01:40:00Z', 'a'.repeat(40)])
  expect(ISSUE.test(issue(`20260914-0102~git${'b'.repeat(12)}.dirty`, 'a'.repeat(40), '2026-09-14T01:40:00Z'))).toBe(true)
  expect(ISSUE.test(issue('v0.0.1', 'a'.repeat(40), '2026-09-14T01:40:00Z'))).toBe(false)
  expect(ISSUE.test(issue('20260914-0130', 'short', '2026-09-14T01:40:00Z'))).toBe(false)
  expect(text.startsWith('Mica OS Base ')).toBe(true)
  expect(ISSUE.test(text.replace('Mica OS Base ', 'Mica OS '))).toBe(false)
})
