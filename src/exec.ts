import { fail } from './errors.ts'

export interface Output {
  code: number
  stdout: string
  stderr: string
}

export function capture(command: string[], env?: Record<string, string | undefined>): Output {
  const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'pipe', env: env ?? process.env })
  return { code: result.exitCode ?? 1, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}

export function output(command: string[], what: string): string {
  const result = capture(command)
  if (result.code !== 0)
    fail(`${what} failed: ${result.stderr.trim() || `${command[0]} exited ${result.code}`}`)
  return result.stdout
}

export function attached(command: string[], env?: Record<string, string | undefined>): number {
  const result = Bun.spawnSync(command, { stdio: ['inherit', 'inherit', 'inherit'], env: env ?? process.env })
  return result.exitCode ?? 1
}

export function need(tool: string): void {
  if (!Bun.which(tool))
    fail(`required tool is missing: ${tool}`)
}
