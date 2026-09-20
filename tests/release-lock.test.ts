// The release lock readers against the spec's vectors: every lock, upstream and
// pins vector gives the result and rule expected.tsv lists. tests/vectors is a
// copy of mica:docs/design/release-lock/vectors and the commit it was taken
// from is tests/vectors.pin, checked against mica's own tree by the gate
// `bun src/container.ts vectors` rather than asserted in a comment here -- a
// provenance line nobody checks is how this copy came to name a commit at which
// expected.tsv had 69 rows while the files beside it had 84. The repos vectors
// are the offline source cache's (tools/repos.sh), which this repository does
// not have.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { LockRefusal, parseLock, parseUpstream, readInputs } from '../src/release-lock.ts'
import { parseVectorsPin } from '../src/vectors.ts'
import { REPO } from './fixture.ts'

const VECTORS = join(REPO, 'tests/vectors')
const expected = readFileSync(join(VECTORS, 'expected.tsv'), 'utf8').split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split('\t') as [string, string, string, string])

function result(check: () => unknown): string {
  try {
    check()
    return 'valid'
  }
  catch (error) {
    if (error instanceof LockRefusal)
      return `refused ${error.rule}`
    throw error
  }
}

const read = (path: string): string => readFileSync(join(VECTORS, path), 'utf8')

test.each(expected.filter(([path]) => !path.startsWith('repos/')))('%s is %s (%s, mode %s)', (path, outcome, rule, mode) => {
  const want = outcome === 'refused' ? `refused ${rule}` : 'valid'
  if (path.startsWith('lock/'))
    expect(result(() => parseLock(read(path), path))).toBe(want)
  else if (path.startsWith('upstream/'))
    expect(result(() => parseUpstream(read(path), path))).toBe(want)
  else if (path.startsWith('vectors-pin/'))
    expect(result(() => parseVectorsPin(read(path), path))).toBe(want)
  else
    expect(result(() => readInputs(join(VECTORS, path), mode === 'ci'))).toBe(want)
})

test('every vector on disk is listed', () => {
  const listed = new Set(expected.map(([path]) => path))
  const walk = (directory: string): string[] => readdirSync(join(VECTORS, directory)).flatMap(entry => statSync(join(VECTORS, directory, entry)).isDirectory() ? walk(join(directory, entry)) : [join(directory, entry)])
  const files = [...walk('lock'), ...walk('upstream')].filter(path => path.endsWith('.lock'))
  const cases = ['pins/valid', 'pins/refused'].flatMap(directory => readdirSync(join(VECTORS, directory)).map(entry => join(directory, entry)))
  expect([...files, ...cases].filter(path => !listed.has(path))).toEqual([])
  expect(expected.length).toBeGreaterThan(40)
})

test('the committed locks pass: the build-env input with its pin, and locks/upstream.lock', () => {
  const inputs = readInputs(join(REPO, 'locks'), true)
  expect([...inputs.keys()]).toEqual(['mica-build-env'])
  expect(() => parseUpstream(readFileSync(join(REPO, 'locks/upstream.lock'), 'utf8'), 'locks/upstream.lock')).not.toThrow()
})
