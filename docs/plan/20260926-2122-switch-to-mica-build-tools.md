# 20260926-2122-switch-to-mica-build-tools Switch to mica-build-tools and mica-build-env 20260926-2110

- **status**: implementing
- **createdAt**: 2026-09-26 21:22
- **approvedAt**: 2026-09-26 21:25
- **relatedTask**: 20260926-2122-switch-to-mica-build-tools

## Context

- `mica-build-tools` (`mica:docs/decisions/2026-09-26-mica-build-tools.md`, design
  `mica-build-tools:docs/design.md`) is the one implementation of the release lock, the
  consumer's `locks/`, the source cache and the build rules of `mica-build-env:RULES.md`.
  Latest commit `bc39b39` (release `20260926-2057`); it passes every vector of `mica:6d2d756`,
  so it already reads the three `apt` rows of lock 1.2.5. Each repository switches in one
  change and deletes its own implementation; nothing here is evolved further.
- `mica-build-env` switched (`d1ec6ef`) and released `20260926-2110`: the same five images and
  upstream rows as the `20260916-0735` this repository pins, rebuilt on pinned snapshots. Its
  lock passes `mica-tools lock check`.
- What the design deletes here (section 8) and what this repository keeps, by module:

  | Module | Lines | After the switch |
  |---|---|---|
  | `src/release-lock.ts` | 458 | gone: `lock check`, `locks verify`, the library's `checkLock` |
  | `src/vectors.ts`, `tests/vectors.pin`, the vectors tests | 128 | gone: the tool is the one reader |
  | `src/registry.ts` | 128 | gone: the library's OCI client and `Pusher` |
  | `src/cache.ts`, `src/fetch.ts`, `src/verify.ts` | 164 | gone: `repos get`, the source cache `repos/sha256/` (lock 5) replaces `_out/debian-base/debs/` |
  | `src/release.ts` | 72 | split: tag and clean-tree checks are `release check`; the `/etc/issue` banner and `assertBanner` stay |
  | `src/pins.ts` | 155 | split: the build-env lock and pin are `locks verify` and `from`; `ids.json`, `sources.json` and the environment image assertion stay |
  | `src/lock.ts` | 205 | split: parsing `locks/upstream.lock` is `upstream rows`; the runtime selection (`packages.tsv`, consumers, `selectRuntime`) stays |
  | `src/debs/pack.ts`, `pack-cli.ts` | 269 | gone: `deb pack` is this packer, moved |
  | `src/debs/docker.ts` | 201 | stays, rewired: `inputs` from each producer's `mica-inputs`, `deb pack` from the tool's checkout as the `tooling` context |
  | `src/publish.ts` | 693 | split: pools and packages are `release pool` and `pool guard`/`pool gate`; the lock and `SHA256SUMS` are `release attach`; the rootfs publisher, the Base rows (`image`, `upstream`, `apt`, `data`) and the unowned data stay |
  | `src/bootstrap.ts`, `rootfs.ts`, `unowned.ts`, `pin-inputs.ts`, `repo.ts` | | stay |

- **A gap in the tool.** `release attach` uploads the lock and `SHA256SUMS` only. This
  repository also publishes `mica-system-base-unowned.<arch>.tsv`, named by `data` rows (lock
  1.2.4), which any repository may publish.
- The design's consequence for the packages: `mica.inputs` is taken over a `mica-inputs`
  declaration per producer (design 3.3.1) and the pool manifests become indented JSON (3.4), so
  every package's recorded inputs and both pool digests move once: the first release after the
  switch bumps the revision of every package.

## Proposal

1. **mica-build-tools first**: `release attach` takes the `data` assets a lock names
   (`--data <file>...`, each hashed against its row, never replaced, read back) -- proposed to
   and done in `mica-build-tools`, since `data` is a lock kind of every repository. This
   repository pins the commit that has it.
2. **Pin the build environment**: `locks/mica-build-env.lock` and its pin move to
   `20260926-2110` with `mica-tools locks move`; `environment.json`'s images follow; the
   environment assertion is checked against the new images.
3. **The switch, one change** (design section 8): add `bin/mica-tools` and
   `locks/mica-build-tools.pin`, the path alias `@mica/build-tools` for the library; a
   `mica-inputs` in each of `debs/mica-*`; the Dockerfiles pack with the tool's `deb pack`;
   `container.ts` routes cache, verify, pools, gates and attach through the commands; the
   modules above are deleted or split, `tests/vectors/` and `tests/vectors.pin` removed, and
   the tests that exercised deleted code go with it. The source cache moves to `repos/`.
4. **Bump every package** (`mica-*` revision `+1`), since each `mica.inputs` value changes;
   `pool guard` confirms nothing else moved.
5. Build both roots, `bun run check`, CI, then one release; verified from the published
   artefacts: pool manifests in the new form, every package bumped once, the root unchanged
   but for the rebuilt images.

Step 3 of mica plan `20260926-1125-apt-row-per-source` (three `apt` rows) is not in this plan:
after the switch this repository reads them, but mica-build, mica-podman, mica-core and
mica-res must pin a mica-build-tools commit first.

## Risks

- The switch is one large change (about 1,300 lines deleted, the Dockerfiles and CI
  rewired); its only proof is the gates, a full build of both architectures and the release.
- New build-env images can change the bytes of compiled packages (mica-busybox,
  mica-systemd-boot, mica-wifi, mica-wifi-ap); the bump of step 4 covers them in the same
  release.
- Consumers pinning Base see new pool digests and a new revision of every package at once.

## Scope

mica-system-base: `bin/`, `locks/`, `environment.json`, `debs/*/mica-inputs`, the
Dockerfiles, `src/`, `tests/`, CI, README and docs. mica-build-tools: `release attach`
with data assets.

## Alternatives

- Upload the `data` assets from here and let `release attach` carry only the lock: keeps a
  piece of the publishing path this repository was to hand over.
- Move the build environment in its own release first: one more release, and the packages
  would be bumped twice.

## Annotations

2026-09-26, the user: go; the build environment moves in the same release as the switch;
this repository writes what it needs of mica-build-tools as requests there rather than
changing it. Requested: `20260926-2126-release-attach-data` (the `data` assets of a lock,
needed for the release) and `20260926-2129-repos-get-mirror` (a download mirror for
`repos get`, needed for CI to keep the res download host). The switch lands when both are
in a mica-build-tools commit this repository pins.

2026-09-26, progress: the vectors copy and its gate are gone; `src/pins.ts` takes the
build-env images through `checkLocks` and `resolveImage`, `environment` verifies every
pinned lock with `verifyLocks`, and `src/release-lock.ts` is replaced by `checkLock` and
`checkUpstream`; the BuildKit stages and the test fixture carry `tsconfig.json` and
`repos/mica-build-tools/src` so the alias resolves there. Tests pass (149); the typecheck
fails on one line of the library under this repository's `exactOptionalPropertyTypes`,
requested as `20260926-2215-strict-consumer-typecheck`. `20260926-2126-release-attach-data`
landed in mica-build-tools `96a5f8b`, and `locks/mica-build-tools.pin` moves there.

2026-09-26, mica-build-tools `5d0a5d9` carries all three requests (`repos get` with
`MICA_MIRROR` and `MICA_FETCH_DEADLINE`; the library under `exactOptionalPropertyTypes`);
`locks/mica-build-tools.pin` moves there and `bun run check` passes in full.

2026-09-26, the switch is implemented and built locally, not committed:
`mica-inputs` per producer and `deb pack` from the tooling context (`src/debs/pack.ts` and
`pack-cli.ts` gone); the source cache is `repos/sha256/` through `repos get`
(`MICA_MIRROR`, `MICA_FETCH_DEADLINE`; `src/fetch.ts` gone, `src/verify.ts` kept for the
package metadata check); `src/registry.ts` gone, `src/publish.ts` keeps the root, the lock
rows and the declared-package gate and runs `pool gate`, `pool guard` and `release attach`;
`release pool` publishes the pools; the workflows run `bin/mica-tools sync` first. Every
package bumped once (epoch 1790460000); mica-tzdata drops `Replaces: tzdata`, which RULES
section 6 refuses. A foreign root built under BuildKit's emulator now mounts `/dev` and a
`/proc` while it is stripped: its chroot could not run busybox (never seen in CI, which
builds natively). Both roots, both pools, `pool gate` (16 archives), `pool guard` (every
package new) and a dry-run lock that passes `lock check`.
