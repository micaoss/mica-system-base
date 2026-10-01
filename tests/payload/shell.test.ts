// The interactive shell profile: payload/etc/profile.d/mica-shell.sh, sourced by
// /etc/profile for every login shell.
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { exec, fake, PAYLOAD, sandbox, SYSTEM_PATH } from './harness.ts'

const PROFILE = join(PAYLOAD, 'etc/profile.d/mica-shell.sh')
const box = sandbox('shell')
afterAll(box.done)
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

  // Without the GNU tools there is no dircolors; a login must not print an error for it.
  test('bash without dircolors still gets the prompt and the aliases, silently', () => {
    const bin = join(box.dir, 'no-dircolors')
    fake(bin, 'id', 'echo 0')
    const r = exec(['/usr/bin/bash', '--norc', '--noprofile', '-i', '-c', `. "$1" && ${REPORT}`, 'sh', PROFILE], { PATH: bin, HOME: '/nonexistent', TERM: 'xterm-256color' })
    expect(r.code).toBe(0)
    expect(r.out).not.toContain('dircolors')
    expect(r.out).toContain('\\u@\\h')
    expect(r.out).toContain('alias ls=\'ls --color=auto\'')
  })
})
