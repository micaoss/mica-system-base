# Changelog

## 2026-09-20 07:10 [progress]

README records the operator account and three decisions about it (coordinator,
2026-09-20): `/home/mica` is absent from the root on purpose and lives on DATA,
`uidmap` is absent on purpose and would be an `upstream.pkgs` row rather than a
base change if rootless were ever wanted, and `/etc/subuid` and `/etc/subgid`
are kept although inert, because suppressing a Debian default would be a policy
invented here. Documentation only: no package input changes, so no version bump.

## 2026-09-20 06:20 [progress]

Every base root is built with a list of the paths no package claims, beside it
as `_out/rootfs/<arch>.unowned.tsv`: one tab-separated row per path with what
wrote it, read out of the root itself (the generator, the maintainer script that
names the path, or this repository's own build). A composer proves a declaration
by package ownership and has nothing to prove a generated path with, and nothing
compared the set it declares against the set a root has; this is the set to diff
against (mica-build and the coordinator, 2026-09-20). 93 paths in the amd64 root
of this commit, 3 of them with a writer that could not be established, which say
`unknown` rather than a guess.

## 2026-09-20 05:40 [progress]

The console banner names the Base: /etc/issue reads `Mica OS Base <release>`
rather than `Mica OS <release>`, with the `ISSUE` regex and the base-root
validator. The release in it is a mica-system-base release, and a product is
composed later with a release of its own, so the unqualified line asserted a
version this root does not know (coordinator, 2026-09-20).

## 2026-09-19 08:30 [progress]

CI takes the pinned Debian archives from the res download host
(`MICA_BASE_MIRROR=pool:https://dl.res.micaos.dev/upstream/debian`), which
replaces the old `/d/` prefix on res.micaos.dev. Configuration only: the mirror
is tried before a row's snapshot URL, a miss answers 404 and falls back, and the
committed sha256 is checked either way.

## 2026-09-17 10:40 [progress]

mica-system 1.0.1-1 ships `/etc/profile.d/mica-shell.sh`: an interactive bash
on a color terminal gets a colored `user@host:cwd` prompt (red for root),
`LS_COLORS`, and `ls`, `grep` and `diff` aliased to `--color=auto`; any other
shell or terminal is left unchanged (`tests/payload/shell.test.ts`). It reaches
a device once mica-build pins this release and keeps `/etc/profile` and
`/etc/profile.d/*.sh` in the product root (task 20260917-0950-shell-colors).

## 2026-09-16 08:10 [progress]

The build environment moves to mica-build-env 20260916-0735, which rebuilt every
image (its pipefail fix touched the shared library the images are built with);
`locks/mica-build-env.lock` is replaced whole with the verified release asset and
its pin names that release and trust hash. The upstream rows are unchanged. The
four packages are version-locked, so the gate compares them with release
20260915-1102: they must rebuild byte-identically under the new images.

CI downloads the pinned Debian archives through the res mirror
(`MICA_BASE_MIRROR=pool:https://res.micaos.dev/d/upstream/debian`): an archive
the mirror does not have answers 404 and the row's own snapshot URL is used, and
the committed sha256 is checked either way, so the mirror can only make a
download faster.

## 2026-09-15 11:30 [progress]

The release lock readers follow mica main 19fbdce: scoped releases and pins
(`<scope>/<release>`, `SCOPE=`) for mica-boards and mica-build, board component
rows, and mica-build's input, product, bundle and asset rows, with their
refusal rules. `tests/vectors` is refreshed to that commit and every vector
passes.

## 2026-09-15 11:00 [progress]

Packages are locked by their own version (mica:docs/decisions/2026-09-15-package-versions.md):
each `debs/<package>/control` declares `Version` and `Source-Date-Epoch`
(mica-busybox 1.38.0-mica1, mica-systemd-boot 257.13-mica1, mica-ca-trust
20250419-mica1, mica-system 1.0.0-1). No package carries a commit or a release:
`Mica-Source-Commit` is gone and the copyright texts cite the sha256 of the
configuration and patch. Pool manifests name only the repository and the
architecture, and each layer records `mica.inputs`. The gate and the release
compare every package with the latest release: the same version must keep its
inputs and rebuild to the published bytes; a lower version is refused.

## 2026-09-15 02:20 [progress]

The first version of mica-system-base: the board-independent base system of
Mica OS, in the release lock format of mica:docs/design/release-lock.md (mica
ffbea5d). Its build environment is mica-build-env 20260915-0138
(`locks/mica-build-env.lock` and its pin); every third-party pin is a row of
`locks/upstream.lock`; its packages are `mica-system`, `mica-busybox`,
`mica-ca-trust` and `mica-systemd-boot`; and a release carries exactly
`mica-system-base.lock` and `SHA256SUMS`. Earlier history, releases, workflow
runs and records were removed on the user's instruction.
