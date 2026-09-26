# 20260926-1040-runtime-lock-security The runtime lock resolves without the security archive

- **status**: in_progress
- **priority**: P1
- **owner**: claude/lock-security
- **createdAt**: 2026-09-26 10:40

## Description

Found while pinning the build tools of mica-wifi (task 20260926-0904-mica-wifi).
At the lock's snapshot 20260905T000000Z, `pin-inputs` resolves build packages
from `trixie`, `trixie-updates` and `trixie-security`, and resolved
`libssl-dev 3.5.7-1~deb13u2` from debian-security. The runtime lock resolves from
`sources.json`'s mirror, `trixie main` only, and pins `libssl3t64` and
`openssl-provider-legacy` at `3.5.6-1~deb13u2`: the base root ships an OpenSSL
older than the security archive of its own snapshot.

To establish:

- which runtime packages have a newer version in `trixie-security` (or
  `trixie-updates`) at the lock's snapshot, and which security advisories that
  leaves unapplied;
- whether the runtime lock should resolve against the same three suites the
  build closure does, and what that changes in the lock.

## ActiveForm

Checking the runtime lock against the security archive

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

(none)

2026-09-26 11:30: scanned; 33 of 173 pinned names are behind, all current in trixie main at
20260926T000000Z. Plan: docs/plan/20260926-1130-snapshot-20260926.md.
