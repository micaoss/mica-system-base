# Changelog

## 2026-09-26 12:10 [progress]

The lock moves to snapshot 20260926T000000Z (plan 20260926-1130-snapshot-20260926). A scan of
every pinned Debian package against main, updates and security found 33 of 173 behind; at
20260926 all are in trixie main after the point release, with libc6 2.41-12+deb13u4, OpenSSL
3.5.7-1~deb13u2, libexpat1 2.8.3-1~deb13u1, util-linux 2.41.5-0+deb13u1 and its libraries,
perl-base, libsqlite3-0, gzip, libaudit, libglib2.0, alsa, libpcre2, base-files and binNMUs
of bash, e2fsprogs and libcap2. `pin-inputs` now resolves the runtime rows too: every name
pinned for the root again at the snapshot, refusing a version that would add a package the
selection does not name (`--check` at the old snapshot reproduced the lock row for row).
tzdata 2026c: mica-tzdata 2026c-mica1. The floor on amd64 is 104.5 MB, 98 packages. Between
point releases security fixes reach trixie-security first; resolving from it needs one
`apt` row per source, a release-lock format change planned in mica.

## 2026-09-26 11:05 [release]

Release 20260926-1045, built from 4cd1a12 on mica-build-env 20260916-0735: the first release
whose root is the floor. Breaking for composers; docs/floor-and-options.md says what to add.
Verified from the published artefacts: SHA256SUMS checks the lock; its package rows add
mica-ssh 1.0.0-1 and mica-tzdata 2026b-mica1 and move mica-system to 1.1.0-1 on both
architectures, and the rows of mica-busybox, mica-ca-trust, mica-systemd-boot, mica-wifi and
mica-wifi-ap are byte-identical to 20260926-0933; every option that is a Debian package
(login, nftables, kmod, procps, dmsetup, dropbear-bin, bash and the GNU command set) is an
upstream row tagged with its own name; both unowned-path assets list 189 paths, none without
a named writer.

## 2026-09-26 10:45 [progress]

The root is the floor (docs/floor-and-options.md, plan 20260926-0938-rootfs-minimal):
systemd, udev, dbus, networkd, resolved and timesyncd, mica-system, mica-ca-trust and
busybox as the only command set. bash, dash, coreutils, findutils, grep, sed, diffutils
and gzip are installed with the rest and purged by the bootstrap (`strip`), each of their
commands busybox has becoming a link to it; root and mica log in with `/bin/sh`; gconv and
i18n are path-excluded. Everything else is an option: mica-ssh (dropbear, its unit,
prestart and preset, and the PAM check, now of the pinned `input.dropbear-bin` at build),
mica-tzdata (the zoneinfo of the pinned tzdata as payload; tzdata's postinst needs GNU
date), and login, nftables, kmod, procps, dmsetup, bash and the GNU command set as `upstream` rows.
mica-system 1.1.0-1 depends on the floor only and holds every getty until `/usr/bin/login`
exists. `pin-inputs` tags a root of upstream.pkgs the base lock already pins, so the purged
GNU packages are published for the products that want them back. amd64 built, gated,
composed with every option and booted under systemd-nspawn; 104.3 MB and 98 packages.

## 2026-09-26 09:45 [release]

Release 20260926-0933, built from cb2d61b on mica-build-env 20260916-0735: the release of
mica-wifi and mica-wifi-ap 2.12-mica1. Verified from the published artefacts: SHA256SUMS
checks the lock; the lock adds a package row for each of mica-wifi and mica-wifi-ap on amd64
and arm64, and the eight package rows of mica-busybox, mica-ca-trust, mica-system and
mica-systemd-boot are byte-identical to 20260920-0832, reused by digest; the pool manifests
moved because they carry the two new layers; no upstream row names wpasupplicant, hostapd,
libnl-route-3-200 or libpcsclite1.

## 2026-09-26 11:00 [progress]

mica-wifi and mica-wifi-ap 2.12-mica1: wpa_supplicant, wpa_cli, hostapd and hostapd_cli
compiled from the upstream hostap 2.12 release archives (`source.wpa-supplicant`,
`source.hostapd`, tracked upstream as podman is) with nl80211 only and the root's libnl-3,
libnl-genl-3 and libcrypto; no D-Bus, PC/SC, readline, WPS, P2P, mesh or EAP. Each build
refuses a binary that loads any other library and one whose `-v` is not the pinned
release. Installed sizes are 1509 KiB and 980 KiB on amd64, against Debian's wpasupplicant
and hostapd with libnl-route and libpcsclite. The packages carry what mica-build's
`radio-wifi` producer shipped (the STATE binds of `/etc/wpa_supplicant` and `/etc/hostapd`,
the regulatory database reload) and `wpa_supplicant@.service` and `hostapd@.service` with
the names and paths micad drives, so Wi-Fi packaging lives here alone. upstream.pkgs no
longer pins wpasupplicant, hostapd, libnl-route-3-200 or libpcsclite1.

`pin-inputs` now reads `apt-get --print-uris` lines without an index hash, which the
security archive prints (`printedUri`, tests/pin-inputs.test.ts). The build closure of both
packages takes libssl-dev 3.5.7-1~deb13u2 from that archive while the runtime lock pins
libssl3t64 3.5.6-1~deb13u2; the tests hold the build headers to the runtime's ABI series,
the binaries were run with `LD_BIND_NOW=1` on the pinned root, and the lag itself is task
20260926-1040-runtime-lock-security (task 20260926-0904-mica-wifi).

## 2026-09-20 19:51 [progress]

The unowned-path artefact says what `/etc/subuid` and `/etc/subgid` are:
`base-passwd`'s postinst creates the files, `useradd` writes
`mica:100000:65536` from `login.defs`, and the range is inert because no
`uidmap` is in the root. It was attributed to `base-passwd.postinst` alone,
which is where the file comes from and not where the range comes from. The
cost of the imprecision is a reader grepping `/etc/subuid` and concluding
rootless containers are supported -- they are uniformly absent, here and in
the products, by decision.

## 2026-09-20 14:49 [progress]

The tty1 assertion names its subject (user decision via coordinator,
2026-09-20): the gate asserts that **the Base root ships**
`etc/systemd/system/getty.target.wants/getty@tty1.service`, not that a device
has a login console there. On a device tty1 stays idle for the boot logo and
the login is on tty2, uniform across boards, and the products disable
`getty@.service` to get it -- a stated removal one layer up, which is a
different thing from the link falling out because no package owns it. The
assertion, the refusal message, the test and the README all say which of the
two they are about.

Found because three repositories held three positions on one observable
behaviour -- this gate, the composer's silent drop, and cx3576's preset -- each
internally consistent and green, contradicting only in the composition, which is
the one place no repository's tests look.

## 2026-09-20 14:41 [progress]

The header, the gate line and the file are now one source read twice. The
unowned-path artefact carries its own counts: a `# mica-unowned v1` header
naming how many paths no package claims and how many had no named writer, which
a reader can check against the rows beneath it (coordinator, 2026-09-20). A
number that lives only in a CI log is attention; a number in the artefact is an
instrument, and the one unattributed row this file used to carry was found by
hand rather than by anything that read it. The root gate echoes the header
instead of counting the file itself. No consumer reads these assets yet, so the
format lands before anyone parses it; the next release's `data` rows carry the
new bytes and no package version changes.

## 2026-09-20 14:36 [progress]

The root gate counts the unowned paths it could not attribute and names them,
because the attribution rules are otherwise only ever exercised against a
synthetic root: a fixture cannot contradict the rules it was written for. The
built root is the one original that can, and what it costs them is now visible
in the run that produced it rather than measured by hand.

## 2026-09-20 14:31 [progress]

The unowned-path artefact attributes what `systemd-tmpfiles` creates, reading
the `tmpfiles.d` entry that names the path, and the last `unknown` writer is
gone: 93 rows, 0 unknown. The path that needed it is `/etc/vconsole.conf`, and
with it `/etc/default/locale` -- both are dangling compatibility symlinks
created by `/usr/lib/tmpfiles.d/debian.conf`, which is why a maintainer script
never names them and why a test for their existence reports absent: `[ -e ]`
follows the link and the target does not exist. A dangling symlink is neither a
present file nor an absent path, and it is exactly what a composer drops
without noticing.

## 2026-09-20 14:21 [progress]

The vectors pin and copy move together to mica `5ce4656f` (143 files, gate
green), which carries the repair of six `upstream/refused` fixtures that were
missing a comment line their sibling has -- found with this repository's
multiset argument, run against a set it was not written for. A copy check
answers "did this travel intact" and never "was it right when it left": the
gate here compared 133 and then 139 blobs correctly while every copy was wrong
together. The mechanism is not weakened by that; it is correctly sized.

The pin reader now accepts comment lines, because the spec adopted the form
this repository used to name a known defect above the keys
(`vectors-pin/valid/commented.pin`), and the listing test sweeps `vectors-pin/`
too, so an unlisted pin vector cannot hide there either.

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
