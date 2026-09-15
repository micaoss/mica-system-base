# Changelog

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
