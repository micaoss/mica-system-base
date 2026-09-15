# 20260915-1145-pipefail-shapes Harden the three pipefail-fragile shell shapes with their next package bump

- **status**: pending
- **priority**: P3
- **owner**: issue 5jfipe3b
- **createdAt**: 2026-09-15 11:45

## Description

Under `set -o pipefail`, a pipeline into a consumer that exits early (`grep -q`,
`head`) fails when the producer is killed by SIGPIPE, so a membership test
passes or fails depending on where the match sits (found by mica docs in its own
gate, fixed there as 3fd60fa).

No script of this repository sets `pipefail`: every device script under
`payload/usr/lib/mica`, `debs/mica-system/postinst` and the package Dockerfiles
run `#!/bin/sh` with `set -eu`, the workflows run no pipelines, and the Bun
tooling runs argv arrays. The three sites below are therefore latent, not
defects, and hardening them now would cost a package version bump and a release
for no change in behaviour (coordinator, 2026-09-15).

| Site | Today | Fix |
| --- | --- | --- |
| `payload/usr/lib/mica/mica-health` line 48 | `printf '%s\n' "$BOOTED" \| grep -qx '[0-9a-f]\{64\}'` | `grep -x '[0-9a-f]\{64\}' >/dev/null` |
| `payload/usr/lib/mica/mica-health` line 16 | `sed -n "s/^$1=//p" "$CONF" \| head -n1` | one `awk` over `$CONF` with `{ print; exit }`, no pipe |
| `debs/mica-busybox/Dockerfile` line 41 | `readelf -l busybox \| grep -q 'program interpreter'` | `grep 'program interpreter' >/dev/null` (under `pipefail` the `if` would fail open, not closed) |

Rules:

- each fix rides the next bump of its package (`mica-system`, `mica-busybox`)
  and never causes a bump of its own;
- if `pipefail` is ever added to one of those scripts, harden it in the same
  commit.

## ActiveForm

Waiting for the next bump of mica-system and mica-busybox

## Dependencies

- **blocked by**: nothing; it rides the next version bump of each package
- **blocks**: nothing
