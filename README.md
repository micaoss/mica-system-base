# mica-system-base

The board-independent base of Mica OS: a pinned Debian lock, the packages built from this
repository, and the **floor** root assembled from both.

The floor is what every device needs and nothing else: busybox as the only command set,
the system policy, the system bus and the trust anchors, and no init. A product adds one
init (`mica-systemd` or `mica-openrc`) and the options it wants -- SSH, the console, the
firewall, Wi-Fi, Bluetooth, time zones -- from the same release.
**[docs/floor-and-options.md](docs/floor-and-options.md)** describes the floor, every
package, both inits and the options.

Building and publishing run on [mica-build-tools](https://github.com/micaoss/mica-build-tools)
(`locks/mica-build-tools.pin`) inside the images of
[mica-build-env](https://github.com/micaoss/mica-build-env) (`locks/mica-build-env.lock`).

## Packages

| Package | Arch | What it is |
| --- | --- | --- |
| `mica-system` | all | the system policy, for either init: `payload/` |
| `mica-busybox` | amd64, arm64 | static BusyBox, the floor's command set |
| `mica-ca-trust` | all | the TLS anchors of the pinned `ca-certificates` |
| `mica-systemd` | all | Mica OS on systemd |
| `mica-openrc` | all | Mica OS on OpenRC |
| `mica-mdev` | all | device nodes without udev, for `mica-openrc` |
| `mica-systemd-boot` | amd64, arm64 | the systemd-boot EFI loader, with persisted boot attempts |
| `mica-ssh` | all | SSH: dropbear, started by micad |
| `mica-wifi` | amd64, arm64 | a minimal `wpa_supplicant` |
| `mica-wifi-ap` | amd64, arm64 | a minimal `hostapd` |
| `mica-bluetooth` | all | the Bluetooth HCI attach and the pairing keys on STATE |
| `mica-tzdata` | all | the zoneinfo of the pinned `tzdata` |

Each package carries the start-up files of its own services, for systemd and OpenRC.

## Releases

A release is named by its UTC minute, `YYYYMMDD-HHMM`. It is cut with
`gh release create <YYYYMMDD-HHMM> --target <commit of main>`; publishing it runs
`release.yml`, which builds the tag on both architectures, gates it and publishes it.
`ci.yml` runs the same build and gates on every push and publishes nothing.

In `ghcr.io/micaoss/mica-system-base`:

| Tag | Content |
| --- | --- |
| `pool.<arch>.<release>` | the packages for amd64 or arm64, one layer per `.deb`, annotated with its `mica.inputs`; an unchanged pool keeps its digest |
| `rootfs.<release>` | the floor, an OCI image index over `linux/amd64` and `linux/arm64` |

On the GitHub release, never replaced (format: mica-build-tools `docs/spec/release-lock.md`):

| Asset | Content |
| --- | --- |
| `mica-system-base.lock` | `mica-lock v1`: the `release` row; `image` rows for the rootfs index and its manifests; a `pool` row per architecture; a `package` row per package and architecture; an `upstream` row per Debian package pinned for later stages (version, sha256, snapshot URL, and the roots it is pinned for); the `apt` row, the Debian snapshot the root was built from; a `data` row per unowned-path file |
| `mica-system-base-unowned.<arch>.tsv` | every path of the root no package owns, with what wrote it |
| `SHA256SUMS` | the sha256 of `mica-system-base.lock` |

### Monthly update

`update.yml` runs at 03:00 UTC on the first of each month (and on demand). `src/update.ts`
moves mica-build-tools to the head of its main, mica-build-env to its latest release, the
Debian snapshot to the day, busybox, hostapd, wpa_supplicant, systemd and the test kernel to
their latest, re-resolves the lock (`pin-inputs`), re-records the ca-certificates anchors and
tzdata, and bumps every package whose inputs or build moved (a new upstream restarts at
`-mica1`). The commit is built and gated on `update/<date>`; when it passes, main moves to it
and the release is cut and published. A month with nothing new makes no commit. A manual run
with `publish` off stops after the build.

## Consuming a release

1. **Pin it.** Commit the release's `mica-system-base.lock` unchanged as
   `locks/mica-system-base.lock` with its pin `locks/pins/mica-system-base.pin`
   (`# mica-pin v1`, `REPOSITORY`, `RELEASE`, and the sha256 of the release's
   `SHA256SUMS`), checked with `mica-tools locks verify`. Move both together.
2. **Take the floor** from the `image mica-system-base rootfs <arch>` row by digest, and
   this repository's packages from the `package` rows: the layer of that architecture's
   `pool` whose digest is the row's sha256.
3. **Take a Debian package pinned for later stages** from the `upstream` rows, by its
   package name, root or not: every row's dependencies are rows too, or in the floor. Refuse
   any download whose sha256 differs from the row, and install them with dpkg. CI bootstraps
   every row together with the root.
4. **Resolve any other Debian package from the `apt` row alone**, so it matches the root's
   libraries -- or ask for it under options ([the upstream rows](docs/floor-and-options.md#the-upstream-rows)). Run apt in a build container with
   the row as its only source (`Check-Valid-Until: no`) and `Dir::State::status` set to the
   root's `/var/lib/dpkg/status`; verify each archive against the signed index; record it in
   the consumer's own lock and test it in the consumer's CI.
5. **Keep the system IDs.** The groups and users of `config/ids.json` exist in the root; a
   package that creates any other is the consumer's to pin first, or Base's.

## Design decisions

### Accounts

`root` (`*`) and the operator `mica` (uid and gid 1000, `!`) cannot log in with a password.
A signed root is identical on every device, so a password in it would be one secret for
the fleet; `mica-shadow-reconcile` rebuilds the shadow file in RAM at every boot and locks
anything that is not locked. The only password that can exist is a transient root password
set through micad, gone at the next boot. Both log in with `/bin/sh`. There is no
unprivileged-user story: podman access implies root, and root implies SSH; the operator
account exists for a person, not as a privilege boundary.

- `/home/mica` is not in the root: `mica-seed-home` creates it on DATA (1000:1000, 0700)
  and the init binds it onto `/home`. The fixed uid and gid are what let a home outlive
  the image.
- No user namespaces: `uidmap` is not installed and rootless containers are unsupported.
  `/etc/subuid` and `/etc/subgid` keep the ranges `useradd` writes; with no `uidmap` they
  are inert.

### SSH does not go through PAM

dropbear reaches an account through `crypt(3)` against `/etc/shadow`. SSH is the only route
into a fielded device, so the build of mica-ssh refuses a pinned `dropbear-bin` that depends
on PAM or whose binary names `libpam` (a byte check: it can only err towards refusing).

### The container graphroot's mount options are a default, not a boundary

`/mica/containers` is bound `nosuid,nodev` without `noexec`, and mica-podman's
`storage.conf` agrees. The engine is rootful, so these options are not a security boundary;
keep them, and do not add `noexec`, which would stop containers executing from the
graphroot. DATA's own file system and options are the product's.

## Repository layout

| Path | Content |
| --- | --- |
| `locks/mica-build-tools.pin`, `bin/mica-tools` | the mica-build-tools commit this repository runs, and its bootstrap (checked out under `repos/mica-build-tools/`, imported as `@mica/build-tools`) |
| `locks/mica-build-env.lock`, `locks/pins/mica-build-env.pin` | the build environment release and its pin |
| `locks/upstream.lock` | every third-party pin: the Debian archives, the inputs and build tools of the packages, the upstream sources they compile |
| `locks/sources.json` | the Debian snapshot and suite (the release's `apt` row) |
| `locks/packages.tsv` | the consumers of each Debian package: `base`, a package of `debs/consumers.pkgs`, or `upstream-<root>` |
| `locks/upstream.pkgs` | the Debian packages later stages install (the `upstream` rows) |
| `config/ids.json` | the fixed system IDs |
| `debs/<package>/` | a package: `control`, `Dockerfile`, `mica-inputs`, and as needed a `postinst`, a `payload/`, `build-sources.json` |
| `debs/consumers.pkgs` | the local packages a selection may name |
| `payload/` | the files of `mica-system` |
| `src/`, `tests/` | the build tooling and its tests (Bun, TypeScript) |
| `docs/floor-and-options.md` | the floor, the packages, the inits and the options |
| `repos/`, `_out/` | untracked: the tools checkout, the archive cache, build outputs |

## Building

Everything runs in the environment images; the host needs Docker, Bun and git.

```sh
bun install
bin/mica-tools sync                     # check out the pinned mica-build-tools
bun src/container.ts environment        # verify locks/ and pull the environment images
bun run check                           # lint, typecheck and tests
```

One architecture at a time (the other builds under emulation):

```sh
bun src/container.ts cache --arch amd64 --all        # pinned archives into repos/sha256
bun src/container.ts test-bootstrap --arch amd64     # every locked package bootstraps together
bun src/container.ts debs --arch amd64               # packages into _out/debs/<arch>/pool
bun src/container.ts rootfs --arch amd64             # the floor, asserted
bun src/container.ts rootfs --arch amd64 --init systemd|openrc   # the floor with an init, asserted
bun src/container.ts boot-test --init openrc         # boot the x64 OpenRC root under QEMU
bun src/publish.ts gate                              # both pools: pool gate and guard
bun src/publish.ts lock --dry-run --tag <YYYYMMDD-HHMM>   # the lock a release would carry
```

Re-pinning: `bun src/container.ts pin-inputs` rewrites the resolved rows of
`locks/upstream.lock` from the snapshot of `locks/sources.json` (`--check` only compares);
`bin/mica-tools locks move mica-build-env <release>` moves the build environment.

CI builds each architecture on its native runner (`ubuntu-26.04`, `ubuntu-26.04-arm`). The
workflows cache only downloads, and every archive is verified against its pin.

## Package versions

Every package's version is its upstream's: `<upstream>-mica<N>`, the upstream being
the lock row of what it builds, carries or wires in (`UPSTREAM` in `src/update.ts`): busybox
for mica-busybox and mica-mdev, base-files (the Debian point release) for mica-system, systemd
for mica-systemd and mica-systemd-boot, openrc, dropbear, bluez, hostapd, wpa_supplicant,
ca-certificates and tzdata for theirs. A new upstream restarts at `-mica1`; a change of
packaging, inputs or build moves `N`. No version carries an epoch. Each `debs/<package>/control`
declares its `Version` and `Source-Date-Epoch`, bumped together, and no package carries a
commit or a release. The gate and every release compare each package with the latest release:
the same version must record the same `mica.inputs` and rebuild to the published bytes; a
lower version is refused.

## Adding a package

Create `debs/<package>/` with a `control` template (`Version`, `Source-Date-Epoch`,
`Architecture: @ARCH@`), a `mica-inputs` naming everything that decides its bytes, and a
`Dockerfile` whose first line is
`# mica-deb: arches=all|amd64,arm64 [inputs=...] [build=...] [sources=...]` and which packs
with `bun /tooling/src/cli.ts deb pack`. If a product selects it, add it to
`debs/consumers.pkgs`; name the upstream its version follows in `src/update.ts`. If it runs a service, ship its systemd unit and its OpenRC script.
