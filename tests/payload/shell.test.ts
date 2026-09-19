// The interactive shell profile: payload/etc/profile.d/mica-shell.sh, sourced by
// /etc/profile for every login shell.
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { exec, PAYLOAD, SYSTEM_PATH } from './harness.ts'

const PROFILE = join(PAYLOAD, 'etc/profile.d/mica-shell.sh')
const REPORT = 'printf "PS1=%s\\nLS_COLORS=%s\\n" "$PS1" "${LS_COLORS:+set}"; alias'

const source = (shell: string[], term: string): ReturnType<typeof exec> =>
  exec([...shell, `. "$1" && ${REPORT}`, 'sh', PROFILE], { PATH: SYSTEM_PATH, HOME: '/nonexistent', TERM: term })

describe('mica-shell.sh', () => {
  test('an interactive bash on a color terminal gets the colored prompt, LS_COLORS and the color aliases', () => {
    const r = source(['bash', '--norc', '--noprofile', '-i', '-c'], 'xterm-256color')
    expect(r.code).toBe(0)
    expect(r.out).toContain('\\u@\\h')
    expect(r.out).toContain('\\[\\e[1;34m\\]\\w')
    expect(r.out).toContain('LS_COLORS=set')
    for (const tool of ['ls', 'grep', 'diff'])
      expect(r.out).toContain(`alias ${tool}='${tool} --color=auto'`)
  })

  test('a dumb terminal keeps the prompt and gets no aliases', () => {
    const r = source(['bash', '--norc', '--noprofile', '-i', '-c'], 'dumb')
    expect(r.code).toBe(0)
    expect(r.out).not.toContain('\\u@\\h')
    expect(r.out).toContain('LS_COLORS=\n')
    expect(r.out).not.toContain('--color=auto')
  })

  test('a non-interactive bash is left alone', () => {
    const r = source(['bash', '--norc', '--noprofile', '-c'], 'xterm-256color')
    expect(r.code).toBe(0)
    expect(r.out).toContain('PS1=\n')
    expect(r.out).not.toContain('--color=auto')
  })

  test('dash sources it without error or change', () => {
    const r = source(['dash', '-i', '-c'], 'xterm-256color')
    expect(r.code).toBe(0)
    expect(r.out).not.toContain('\\u@\\h')
    expect(r.out).not.toContain('--color=auto')
  })
})
