# Changelog

## 2026-09-15 02:20 [progress]

The first version of mica-system-base: the board-independent base system of
Mica OS, in the release lock format of mica:docs/design/release-lock.md (mica
ffbea5d). Its build environment is mica-build-env 20260915-0138
(`locks/mica-build-env.lock` and its pin); every third-party pin is a row of
`locks/upstream.lock`; its packages are `mica-system`, `mica-busybox`,
`mica-ca-trust` and `mica-systemd-boot`; and a release carries exactly
`mica-system-base.lock` and `SHA256SUMS`. Earlier history, releases, workflow
runs and records were removed on the user's instruction.
