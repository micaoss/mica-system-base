// tests/vectors is not ours. It is a copy of mica's release-lock vectors, and a
// copy of somebody else's truth is worth exactly what it can prove about where
// it came from: a comment naming a commit is an assertion, and this repository
// has already shipped one that was fifteen vectors out of date while the files
// beside it were current. So the commit is pinned in tests/vectors.pin
// (`mica-vectors-pin v1`) and this reads mica's tree at that commit and refuses
// any difference.
//
// Both directions. A missing file and a differing file are the obvious halves;
// the extra file is the half that hides, because a fixture the canonical no
// longer has stays green forever -- the reader and the fixture agree with each
// other and neither of them has been told the format moved.
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fail } from './errors.ts'
import { REPO } from './pins.ts'
import { LockRefusal } from './release-lock.ts'

export interface VectorsPin { repository: string, commit: string }

// Where the vectors live in the producing repository.
const UPSTREAM = 'docs/design/release-lock/vectors/'
export const PIN = 'tests/vectors.pin'
export const VECTORS = 'tests/vectors'

// The pin itself (spec 5): the header, then REPOSITORY and COMMIT in that
// order and nothing else, then a final newline. Comment lines are allowed and
// are where a pin carries its reasoning -- a known defect at the pinned commit
// belongs above the keys, because a defect named under a gate beats one carried
// silently. The commit is the full 40 hex: a prefix is not a name a tree can be
// compared against.
const HEADER = '# mica-vectors-pin v1'

export function parseVectorsPin(text: string, file: string): VectorsPin {
  const refuse = (rule: string, detail: string): never => {
    throw new LockRefusal(rule, file, detail)
  }
  if (!text.endsWith('\n') || text.includes('\r') || text.includes('\n\n'))
    refuse('encoding', 'not lines each ending in one newline')
  const [header, ...rest] = text.slice(0, -1).split('\n')
  if (header !== HEADER)
    refuse('header', `first line ${header}, not ${HEADER}`)
  const lines = rest.filter(line => !line.startsWith('#'))
  if (lines.length !== 2 || !lines[0]!.startsWith('REPOSITORY=') || !lines[1]!.startsWith('COMMIT='))
    refuse('pin-format', 'not exactly REPOSITORY= then COMMIT=')
  const [repository, commit] = [lines[0]!.slice('REPOSITORY='.length), lines[1]!.slice('COMMIT='.length)]
  if (!/^[a-z0-9][\w-]*$/.test(repository))
    refuse('field-value', `REPOSITORY=${repository}`)
  if (!/^[0-9a-f]{40}$/.test(commit))
    refuse('field-value', `COMMIT=${commit}`)
  return { repository, commit }
}

export function vectorsPin(repo = REPO): VectorsPin {
  return parseVectorsPin(readFileSync(join(repo, PIN), 'utf8'), PIN)
}

// A file's git blob name, so a local file and a tree entry of the GitHub API are
// the same string without downloading the upstream bytes.
export function blob(bytes: Uint8Array): string {
  return new Bun.CryptoHasher('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}

// Every vector on disk, by path relative to the vectors directory. A symbolic
// link would hash as its target's content here and as a link upstream, so it is
// refused rather than compared.
export function localTree(dir: string): Map<string, string> {
  const tree = new Map<string, string>()
  const walk = (prefix: string): void => {
    for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory())
        walk(path)
      else if (entry.isFile())
        tree.set(path, blob(readFileSync(join(dir, path))))
      else
        fail(`${VECTORS}/${path} is not a regular file`)
    }
  }
  walk('')
  return tree
}

// mica's vectors at the pinned commit, read as git blob names from the tree API.
// The repository is public, so this needs no credential; a token only raises the
// rate limit and GITHUB_TOKEN is used when the runner has one.
export async function upstreamTree(pin: VectorsPin): Promise<Map<string, string>> {
  const url = `https://api.github.com/repos/micaoss/${pin.repository}/git/trees/${pin.commit}?recursive=1`
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  const response = await fetch(url, {
    signal: AbortSignal.timeout(60_000),
    headers: { accept: 'application/vnd.github+json', ...token ? { authorization: `Bearer ${token}` } : {} },
  }).catch(() => undefined)
  if (!response?.ok)
    fail(`reading ${pin.repository} ${pin.commit} failed${response ? ` (HTTP ${response.status})` : ''}`)
  const body = await response.json() as { truncated?: boolean, tree?: { path: string, type: string, sha: string }[] }
  if (body.truncated)
    fail(`the tree of ${pin.repository} ${pin.commit} came back truncated`)
  const tree = new Map<string, string>()
  for (const entry of body.tree ?? []) {
    if (entry.type === 'blob' && entry.path.startsWith(UPSTREAM))
      tree.set(entry.path.slice(UPSTREAM.length), entry.sha)
  }
  if (!tree.size)
    fail(`${pin.repository} ${pin.commit} has no ${UPSTREAM}`)
  return tree
}

// Set equality both ways, then content. Every difference is named, because the
// first thing anyone asks of a refusal like this is which file.
export function assertVectors(local: Map<string, string>, upstream: Map<string, string>, pin: VectorsPin): void {
  const missing = [...upstream.keys()].filter(path => !local.has(path))
  const extra = [...local.keys()].filter(path => !upstream.has(path))
  const differing = [...upstream].filter(([path, sha]) => local.get(path) && local.get(path) !== sha).map(([path]) => path)
  const at = `${pin.repository} ${pin.commit}`
  for (const [what, paths] of [['missing from', missing], ['not in', extra], ['differing from', differing]] as const) {
    if (paths.length)
      fail(`${VECTORS}: ${paths.length} ${paths.length === 1 ? 'vector' : 'vectors'} ${what} ${at}: ${paths.slice(0, 10).join(', ')}${paths.length > 10 ? ', ...' : ''}`)
  }
}

export async function checkVectors(repo = REPO): Promise<number> {
  const pin = vectorsPin(repo)
  const local = localTree(resolve(repo, VECTORS))
  assertVectors(local, await upstreamTree(pin), pin)
  console.log(`vectors: ${local.size} files identical to ${pin.repository} ${pin.commit} ${UPSTREAM}`)
  return 0
}
