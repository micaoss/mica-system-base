import { Refused, ToolError } from '@mica/build-tools'

// A refusal, this repository's or mica-build-tools', is an expected, user-facing
// stop; anything else is a bug.
export class Refusal extends Error {}

export function fail(message: string): never {
  throw new Refusal(message)
}

export function report(error: unknown): number {
  if (error instanceof Refusal || error instanceof Refused || error instanceof ToolError) {
    console.error(`debian-base: error: ${error.message}`)
    return 1
  }
  throw error
}
