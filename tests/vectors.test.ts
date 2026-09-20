// The vectors pin and the comparison that makes it load-bearing. The network
// half (reading mica's tree) is the CI step `bun src/container.ts vectors`; what
// is tested here is the parsing and every way the two trees can disagree.
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterAll, expect, test } from 'bun:test'
import { assertVectors, blob, localTree, vectorsPin } from '../src/vectors.ts'
import { REPO, workdir } from './fixture.ts'

const work = workdir('vectors')
afterAll(() => rmSync(work, { recursive: true, force: true }))

const pin = { repository: 'mica', commit: 'a'.repeat(40) }

function repo(name: string, lines: string): string {
  const path = join(work, name)
  mkdirSync(join(path, 'tests'), { recursive: true })
  writeFileSync(join(path, 'tests/vectors.pin'), lines)
  return path
}

function tree(name: string, files: Record<string, string>): Map<string, string> {
  const path = join(work, name)
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(path, file)), { recursive: true })
    writeFileSync(join(path, file), content)
  }
  return localTree(path)
}

test('this repository pins the commit its vectors came from', () => {
  const here = vectorsPin(REPO)
  expect(here.repository).toBe('mica')
  expect(here.commit).toMatch(/^[0-9a-f]{40}$/)
})

test('a pin is two keys in order and nothing else', () => {
  expect(vectorsPin(repo('ok', 'REPOSITORY=mica\nCOMMIT=b1c2d3e4f5061728394a5b6c7d8e9f0102030405\n'))).toEqual({ repository: 'mica', commit: 'b1c2d3e4f5061728394a5b6c7d8e9f0102030405' })
  // A short commit is the failure this pin exists to prevent: it names a
  // prefix, and a prefix is not a name a reader can compare a tree against.
  expect(() => vectorsPin(repo('short', 'REPOSITORY=mica\nCOMMIT=735ebaa\n'))).toThrow('line 2 is not a valid COMMIT=')
  expect(() => vectorsPin(repo('swapped', 'COMMIT=b1c2d3e4f5061728394a5b6c7d8e9f0102030405\nREPOSITORY=mica\n'))).toThrow('line 1 is not a valid REPOSITORY=')
  expect(() => vectorsPin(repo('extra', 'REPOSITORY=mica\nCOMMIT=b1c2d3e4f5061728394a5b6c7d8e9f0102030405\nRELEASE=20260920-0832\n'))).toThrow('expected exactly REPOSITORY= and COMMIT=')
})

test('a file hashes to its git blob name', () => {
  expect(blob(new TextEncoder().encode('what is up, doc?'))).toBe('bd9dbf5aae1a3862dd1526723246b20206e5fc37')
})

test('the local tree is every file, by path, and refuses a link', () => {
  expect([...tree('flat', { 'expected.tsv': 'a\n', 'lock/valid/x.lock': 'b\n' }).keys()]).toEqual(['expected.tsv', 'lock/valid/x.lock'])
  const linked = join(work, 'linked')
  mkdirSync(linked, { recursive: true })
  writeFileSync(join(linked, 'expected.tsv'), 'a\n')
  symlinkSync('expected.tsv', join(linked, 'alias.tsv'))
  expect(() => localTree(linked)).toThrow('alias.tsv is not a regular file')
})

test('a difference is refused in either direction and named', () => {
  const upstream = tree('upstream', { 'expected.tsv': 'a\n', 'lock/valid/x.lock': 'b\n', 'lock/refused/data-file.lock': 'c\n' })
  expect(() => assertVectors(upstream, upstream, pin)).not.toThrow()

  const short = tree('short-copy', { 'expected.tsv': 'a\n', 'lock/valid/x.lock': 'b\n' })
  expect(() => assertVectors(short, upstream, pin)).toThrow('1 vector missing from mica')

  // The half that hides: a fixture the canonical no longer has. The reader and
  // the fixture agree with each other, so nothing else would ever notice.
  const stale = tree('stale-copy', { 'expected.tsv': 'a\n', 'lock/valid/x.lock': 'b\n', 'lock/refused/data-file.lock': 'c\n', 'lock/valid/mica-boards.x64.lock': 'd\n' })
  expect(() => assertVectors(stale, upstream, pin)).toThrow('1 vector not in mica')

  const edited = tree('edited-copy', { 'expected.tsv': 'a\n', 'lock/valid/x.lock': 'edited\n', 'lock/refused/data-file.lock': 'c\n' })
  expect(() => assertVectors(edited, upstream, pin)).toThrow('1 vector differing from mica')
})
