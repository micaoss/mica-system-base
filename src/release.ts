// The release this checkout builds and whether it is one.
//
// A release version is the UTC minute of the release, YYYYMMDD-HHMM, and is the
// git tag GitHub creates for it. A clean checkout whose HEAD carries exactly one
// such tag is that release and its label is the tag. Any other checkout is
// labelled <commit UTC minute>~git<commit12> (with .dirty for uncommitted
// changes). The label names the root and the published artifacts; packages carry
// their own declared versions (src/debs/pack.ts).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fail } from './errors.ts'
import { output } from './exec.ts'

export interface Release {
  repository: string
  label: string
  commit: string
  committed: string
  epoch: string
  released: boolean
}

function git(repo: string, ...args: string[]): string {
  return output(['git', '-C', repo, ...args], `git ${args.join(' ')}`).trim()
}

const RELEASE_TAG = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/

function minute(date: Date): string {
  return date.toISOString().replace(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}).*$/, '$1$2$3-$4$5')
}

export function releaseOf(repo: string): Release {
  const commit = git(repo, 'rev-parse', 'HEAD')
  const dirty = git(repo, 'status', '--porcelain') !== ''
  const tags = git(repo, 'tag', '--points-at', 'HEAD').split('\n').filter(tag => RELEASE_TAG.test(tag))
  for (const tag of tags) {
    const [year, month, day, hour, min] = RELEASE_TAG.exec(tag)!.slice(1).map(Number)
    if (minute(new Date(Date.UTC(year!, month! - 1, day!, hour!, min!))) !== tag)
      fail(`the git tag ${tag} is not a UTC time YYYYMMDD-HHMM`)
  }
  if (tags.length > 1)
    fail(`${commit.slice(0, 12)} carries more than one release tag (${tags.join(', ')}); one commit is one release`)
  const epoch = git(repo, 'log', '-1', '--format=%ct')
  const released = tags.length === 1 && !dirty
  const label = released ? tags[0]! : `${minute(new Date(Number(epoch) * 1000))}~git${commit.slice(0, 12)}${dirty ? '.dirty' : ''}`
  return {
    repository: (JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { name: string }).name,
    label,
    commit,
    committed: git(repo, 'show', '-s', '--format=%cI', commit),
    epoch,
    released,
  }
}

// /etc/issue of the base root: the release label, the build time and the commit.
export function issue(label: string, commit: string, built: string): string {
  return `Mica OS ${label} \\n \\l\nBuild: ${built}\nCommit: ${commit}\n\n`
}

export const ISSUE = /^Mica OS (\d{8}-\d{4}(?:~git[0-9a-f]{12}(?:\.dirty)?)?) \\n \\l\nBuild: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\nCommit: ([0-9a-f]{40})\n\n$/

export function buildTime(): string {
  const value = process.env.MICA_BUILD_TIME ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value))
    fail(`MICA_BUILD_TIME='${value}' is not a UTC time like 2026-09-13T21:40:00Z`)
  return value
}
