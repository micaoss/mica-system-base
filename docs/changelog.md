# Changelog

## 2026-09-20 14:12 [progress]

The vectors pin moves to mica `ddf4edc8`, the commit that repairs the
`bun-linux-uefi-x64.zip` rename artefact, and `tests/vectors` is refreshed with
it (139 files, gate green). The pin file is now the specified
`mica-vectors-pin v1` -- header, `REPOSITORY=`, `COMMIT=`, final newline -- and
its six canonical vectors run beside the lock vectors, so the reader of the pin
is held to the same standard as the reader of the lock: 220 tests.

The first pin, `735ebaa`, was cut two minutes before the repair landed. That is
the mechanism working rather than failing: four days of drift went unnoticed
because nothing named a commit, and two minutes of it was visible immediately
because something did.

## 2026-09-20 14:05 [release]

Release `20260920-0832` at `cc21cd9`, the first carrying producer data: four
assets exactly -- `mica-system-base.lock`, `SHA256SUMS` listing only the lock,
and `mica-system-base-unowned.{amd64,arm64}.tsv` named by the lock's two `data`
rows. Trust hash `a57a2a1e746f5231c918bf521d15a8688c6f646ca3c0ddff23d5d7567376a5c1`.

All four packages reused by digest, none rebuilt -- and **both pool manifest
digests are unchanged from `20260919-1959`**, which is the first observable
proof of the package-version rule rather than a promise of it: ten commits of
root policy landed between the two releases, none touched a package version,
and the pool manifest carries only `mica.source-repo` and `mica.arch`, so a
release that changes no package changes no pool byte. The rootfs images did
move, because the banner names the release; that asymmetry is the correct one.

Verified from the published artefacts and not from the run log: pool manifests
and the rootfs index fetched by tag and re-hashed to the digests the lock
names, per-arch manifests by digest, the index's two children equal to the two
`image` rows, four pool layer blobs with their package titles, and the amd64
rootfs layer downloaded and re-hashed, with `/etc/issue` reading `Mica OS Base
20260920-0832`, all 23 shadow entries locked at day 18262 and
`getty.target.wants/getty@tty1.service` present, read out of that layer.

## 2026-09-20 09:30 [progress]

README records what the container graphroot's mount options are not (user,
2026-09-20): `nosuid` and `nodev` on `/mica/containers` are a default with no
security claim, because the engine is rootful and podman access implies root.
They stay as they are, `noexec` is not added, and the reason to check them on a
booted guest is uniformity across boards rather than confinement. The access
model is recorded with it: there is no unprivileged-user story on these devices.

## 2026-09-20 09:05 [progress]

A release carries the unowned-path lists as producer data
(mica:docs/design/release-lock.md 1.2.4, user 2026-09-20): two assets,
`mica-system-base-unowned.<arch>.tsv`, named by `data unowned.<arch> <file>
<sha256>` rows of the lock, with `SHA256SUMS` still listing only the lock. A
consumer that composes a root reads them from a pinned release instead of
rediscovering them; a CI artifact could not be pinned. The readers follow mica
25ee36b: the `data` row, the version-index rows (`origin`, `built`, `index`)
with their refusals, and the scope separator, which is now `<scope>.<release>`.

## 2026-09-20 08:45 [progress]

The release-lock vectors are read out of mica at a pinned commit and a
difference is refused (coordinator ruling, 2026-09-20): `tests/vectors.pin`
names the repository and the full commit, `src/vectors.ts` compares every
vector's git blob name against mica's tree there, and the gate
`bun src/container.ts vectors` runs it in CI beside the build-env pin check.
Set equality both directions, because the fixture the canonical no longer has
is the one that stays green forever. This copy had been byte-identical to
canonical while its provenance comment named a commit at which `expected.tsv`
had 69 rows, and that comment is now gone; the pin is checked. Recorded with
it: a current fixture set does not imply a current reader -- the reader here
was four days stale on the scope separator while these same 133 blobs were
current.

## 2026-09-20 08:40 [progress]

The base-root gate asserts the tty1 login console: systemd's preset enables
`getty@tty1.service` and the root ships
`etc/systemd/system/getty.target.wants/getty@tty1.service`, which is an unowned
path and therefore one a composer drops. A base root has a console on tty1 by
intent; a product that wants a logo VT states that itself (the `NAutoVTs=0` and
`ReserveVT=2` drop-in is `mica-boards`' cx3576 overlay, not a Base file).

## 2026-09-20 08:05 [progress]

A released root may not carry a snapshot banner: `assertBanner` (the identity
half of `assertRootFrom`, which packs every root layer) refuses an `/etc/issue`
naming a `~git` or `.dirty` label when the build is a release build. A release
builds from its tag, so this is defence in depth -- but the banner is the one
identity a person reads off a running device, and a published root saying
`.dirty` would be an identity defect of its own (coordinator, 2026-09-20).

## 2026-09-20 07:40 [progress]

The base-root gate asserts that SSH does not authenticate through PAM: the
installed `dropbear-bin` may name no `libpam` in its Depends, and
`/usr/sbin/dropbear` may not name `libpam` in its bytes. dropbear reaches an
account through `crypt(3)` against `/etc/shadow`, which is Debian's packaging
default rather than a choice anyone made, and it is the only route into a
fielded device (measured by mica-core from this repository's own pin,
2026-09-20). The binary half is the one that still fails when libpam merely
appears in a build image. README records it, with the evidence that this root
carries the PAM libraries on purpose, so a missing PAM configuration is a loss
and not a design.

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
