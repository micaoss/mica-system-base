# The floor and its options

`image mica-system-base rootfs` is the **floor**: what every Mica OS device needs and nothing
else. It does not boot by itself. A product composes its root from the floor, one **init**
and the **options** it wants, all taken from the same release: the packages of this
repository from the release's `pool` rows, and Debian packages from its `upstream` rows.

This document is the contract for a composer (mica-build). `src/rootfs.ts` asserts every
promise below on each build (`assertFloor`, `assertSystemd`, `assertOpenrc`).

## The floor

On amd64 the floor is 72 packages and 51 MB (11.8 MB with xz).

| What | How |
| --- | --- |
| Command set | **busybox only** (mica-busybox). bash, dash, coreutils, findutils, grep, sed, diffutils and gzip are installed during the bootstrap, so every maintainer script runs with the tools it was written for, then purged. The libraries only they load (libgmp10, libssl3t64, openssl-provider-legacy) go with them unless a package the root keeps depends on them. Each purged command that busybox has becomes a link to `/usr/bin/busybox` at the same path, `/usr/bin/sh` among them; no other applet is linked (no busybox `login`, `getty`, `telnetd` or `httpd`). |
| System policy | **mica-system**: the lifecycle helpers under `/usr/lib/mica`, the DATA layout and its mountpoints, the operator account, the interactive shell profile. Beside busybox the helpers call e2fsck and resize2fs (e2fsprogs) and findmnt (util-linux). They ask the init only through `/usr/lib/mica/mica-init`, which the init package provides, and reach micad with `dbus-send`. |
| System bus | dbus, whichever init runs it, with adduser to create its account. |
| Trust | **mica-ca-trust**, the TLS anchors of the update transport. |
| Accounts | `root` and `mica` (uid and gid 1000), both locked, both on `/bin/sh`. The system IDs of `config/ids.json` are fixed. |
| Compose toolchain | dpkg, tar, perl-base, debconf, passwd and init-system-helpers, so a composer can install into the root with dpkg. They are not device content; the composer purges the package manager at pack. |
| Not carried | an init; gconv modules, i18n data, time zones beyond UTC (`/etc/localtime` is absent), man pages, documentation beyond copyright files; OpenSSH, curl, iptables; Debian's `quota` (DATA's project quotas are set by mica-deploy's runkit, on the boards that want them). |

Every path of the root that no package owns is listed, with what wrote it, in the release's
`mica-system-base-unowned.<arch>.tsv` (165 paths, none unattributed).

## The packages

| Package | Arch | Role | Depends |
| --- | --- | --- | --- |
| `mica-system` | all | floor: system policy for either init | dbus, passwd, e2fsprogs |
| `mica-busybox` | amd64, arm64 | floor: static BusyBox from the pinned upstream release | |
| `mica-ca-trust` | all | floor: the anchors of the pinned `ca-certificates`, as data | |
| `mica-systemd` | all | init: Mica OS on systemd | mica-system, systemd, systemd-sysv, systemd-resolved, systemd-repart, systemd-timesyncd, udev |
| `mica-openrc` | all | init: Mica OS on OpenRC | mica-system, mica-mdev, openrc, fdisk |
| `mica-mdev` | all | init: device nodes without udev, for mica-openrc | mica-busybox |
| `mica-systemd-boot` | amd64, arm64 | boot: the systemd-boot EFI loader of the pinned systemd, with persisted boot attempts | |
| `mica-ssh` | all | option: SSH (dropbear), started by micad | dropbear-bin, mica-system |
| `mica-wifi` | amd64, arm64 | option: a minimal `wpa_supplicant` from upstream hostap | libnl, libssl3t64, iw, rfkill |
| `mica-wifi-ap` | amd64, arm64 | option: a minimal `hostapd` from upstream hostap | libnl, libssl3t64, iw, rfkill |
| `mica-bluetooth` | all | option: the HCI attach and the pairing keys on STATE | bluez, rfkill |
| `mica-tzdata` | all | option: the zoneinfo of the pinned `tzdata`, as data | |

Every package carries the start-up files of its own services, for both inits, and none of
another package's. A script for an init the root does not run is inert.

## The init

Every product installs exactly one.

| | systemd | OpenRC |
| --- | --- | --- |
| From the pool | `mica-systemd` | `mica-openrc`, `mica-mdev` |
| Roots of `upstream` rows | `systemd`, `systemd-sysv`, `udev`, `systemd-resolved`, `systemd-timesyncd`, `systemd-repart` | `openrc`, `fdisk` |
| PID 1 | systemd | `openrc-init` |
| Devices | udev | busybox `mdev -d`; `/etc/mdev.conf` gives udev's owners and modes; no `/dev/*/by-*` names |
| DATA | grown with `systemd-repart` (`mica-grow-data`), checked and mounted from `/etc/fstab`, laid out | grown with `sfdisk` (`mica-grow-data`), checked (`fsck -M`: not the DATA the runkit mounted), mounted from `/etc/fstab`, `x-systemd.growfs` honoured, laid out |
| Binds and seeds | mount units: `/mica`, `/mica/containers`, `/srv`, STATE's hostname, `/var`, `/var/lib/mica`, `/root`, `/home` | `mica-mounts`, in the same order, then the `tmpfiles.d` entries |
| Network | networkd, DHCP by default; resolved | `/etc/network/interfaces` (a link to `/var/lib/mica/network/interfaces`, which micad writes) applied by busybox `ifup -a`; until it exists, DHCP on every `eth*` with busybox `udhcpc`; DNS in `/run/mica/resolv.conf` |
| Time | timesyncd | busybox `ntpd` (`mica-ntpd`) on the `ntp_servers` micad renders in `/run/mica/ntpd.conf`, Debian's pool until then |
| Log | journald, volatile | busybox `syslogd` and `klogd` in RAM, read with `logread` |
| Watchdog | systemd's hardware watchdog | busybox `watchdog`, 90 s |
| Health gate | `mica-health.service`, `mica-boot-failure` on failure | `mica-health`, last, the same |
| Resource limits | no service keeps `CAP_SYS_RESOURCE` (DATA's project quotas hold) | the same, `/etc/rc.conf.d/mica.conf` |
| Console | no getty until the console option installs `/usr/bin/login`; `getty@tty1` masked, so the VT the boot logo lands on stays idle; logind's one login VT is tty2 | no getty; a product that installs the console adds one |
| Enablement | links in the packages' payload | runlevel links in the packages' payload |

`/etc/mtab` links to `/proc/self/mounts` under both. The kernel file systems under OpenRC
are `mica-kernfs`'s; securityfs is mounted only where the kernel has it.

**Runlevel membership is payload.** mica-openrc's postinst removes the runlevel links no
package owns -- what openrc imported from the SysV links, such as Debian's `dbus` -- and keeps
every link a package ships, and OpenRC's `cgroups`. A package configured after it that runs
update-rc.d (bluez) can still add an unowned link; the composer removes those at pack.

## Services and who ships them

| Service | Package | systemd | OpenRC | Started by |
| --- | --- | --- | --- | --- |
| SSH | mica-ssh | `dropbear.service`, disabled by preset | `mica-dropbear`, in no runlevel | micad, after writing `/run/mica/dropbear.env` |
| Wi-Fi station | mica-wifi | `wpa_supplicant@<if>.service`, the STATE bind of `/etc/wpa_supplicant`, the regulatory database reload | `mica-wifi-client`, in no runlevel | micad, after writing `/run/mica/wifi-client.env` |
| Wi-Fi access point | mica-wifi-ap | `hostapd@<if>.service`, the STATE bind of `/etc/hostapd` | `mica-wifi-ap`, in no runlevel | micad, after writing `/run/mica/wifi-ap.env` |
| Bluetooth HCI attach | mica-bluetooth | `mica-bt.service`, enabled, inert without `/etc/mica/bt.conf` | `mica-bt`, in no runlevel, starts nothing without `/etc/mica/bt.conf` | boot (systemd); the product links it into `default` (OpenRC) |
| Bluetooth daemon | mica-bluetooth (bluez) | bluez's `bluetooth.service`, `var-lib-bluetooth.mount` | `mica-bluetoothd`: the STATE bind, then bluetoothd | micad |
| Network time | mica-systemd, mica-openrc | timesyncd | `mica-ntpd`, in `default` | boot; micad restarts it for new servers |
| micad, apid, MQTT | mica-core's packages | their units | their scripts | their packages |

The board facts these services read -- `/etc/mica/bt.conf`, the radio modules and firmware,
the hwinit programs -- are the board's package (its BSP).

## The options

| Option | What a product installs | Where it is pinned |
| --- | --- | --- |
| SSH | `mica-ssh` | pool; dropbear-bin is an `upstream` row |
| Console login | `login` (gettys start once it is there) | `upstream` row |
| Firewall | `nftables`, never enabled at boot (`50-mica-nftables.preset`) | `upstream` row |
| Module loading | `kmod` (udev loads modules through libkmod without it) | `upstream` row |
| Process tools | `procps` (the floor has `busybox ps`) | `upstream` row |
| Device-mapper tools | `dmsetup` (the verity root needs none of it: the kernel assembles it from `dm-mod.create=`) | `upstream` row |
| Time zones | `mica-tzdata` (provides and conflicts with `tzdata`, whose postinst needs GNU `date`) | pool |
| GNU command set | `coreutils`, `findutils`, `grep`, `sed`, `diffutils`, `gzip` (they replace the busybox links at their paths) | `upstream` rows |
| Shell | `bash`; `/etc/profile.d/mica-shell.sh` colors its prompt and stays inert under busybox | `upstream` row |
| Wi-Fi station | `mica-wifi` | pool |
| Wi-Fi access point | `mica-wifi-ap` | pool |
| Bluetooth | `mica-bluetooth` | pool; bluez is an `upstream` row |

An option that is a Debian package, and every other Debian package a later stage installs,
comes from the release's `upstream` rows (below).

## The upstream rows

The `upstream` rows of `mica-system-base.lock` are Base's contract for every Debian package
beyond the floor. Their form, `upstream <name> <arch> <version> <sha256> <url> <roots>`, is
the release lock's (mica-build-tools `docs/spec/release-lock.md`); what they promise is set
here.

- **What is pinned.** Every package of `locks/upstream.pkgs` -- the inits' roots, and
  **options**: the options above and what boards and engines install (the radio tools,
  board audio, mica-podman's libraries) -- with its closure beyond the floor as published.
  That closure includes what the floor purged: systemd's rows carry libssl3t64, coreutils'
  libgmp10.
- **Roots attribute a row; they do not gate it.** `<roots>` names the roots of
  `locks/upstream.pkgs` whose closure holds the row. A later stage takes **any** row by its
  package name and architecture, a root or not.
- **The rows are closed.** Every row's dependencies are rows of the same release or in the
  floor, and CI bootstraps all of them together with the floor on both architectures
  (`test-bootstrap`).
- **One archive per package.** A later stage installs a listed package from its row and never
  pins it itself, so every consumer of a release runs the same archives.
- **A package the lock does not pin** is resolved by the consumer from the release's `apt`
  row alone and recorded in its own lock, or asked of Base, which adds it under options in
  `locks/upstream.pkgs`. From then on the monthly update keeps it current with the rest.
- **Rows move with releases.** The monthly update moves versions and snapshot URLs; a
  consumer's rows are the ones of the release it pins.

## Composing a product

- **Choose the init** and install its pool packages and `upstream` roots. Then the options.
- **Render the board's facts**: the fstab line of `/mnt/data`; under systemd the repart
  drop-in, under OpenRC `/etc/conf.d/mica-data-layout` with `grow_system_uuid` and
  `grow_disk_uuid` (DATA is the last partition of its disk).
- **Composition runs on busybox.** Later maintainer scripts see busybox and `/bin/sh`.
  dropbear-bin, nftables, procps, dmsetup, kmod, login, bash, iw, rfkill and this
  repository's packages configure on it; Debian's tzdata does not (hence mica-tzdata).
  debianutils' `update-shells` trigger reports `chmod --reference`, `chown --reference` and
  `mv -Z`, and still completes. A package whose scripts need a GNU flag installs after the
  GNU command set, or not at all.
- **Scripts that run on the device** use `/bin/sh` and busybox: no bash, and none of the
  commands busybox lacks (b2sum, basenc, chcon, csplit, dir, dircolors, fmt, join, numfmt,
  pathchk, pinky, pr, ptx, runcon, sha224sum, stdbuf, vdir, rgrep, diff3, sdiff, uncompress,
  the gz* helpers; zcat is an applet).
- **Remove what the build left** before pack: the package manager, and runlevel links no
  package owns.

## Verified on every build

CI, on native amd64 and arm64 runners:

- every locked package, the `upstream` ones included, bootstraps together;
- the packages build; the floor, the floor with mica-systemd and the floor with mica-openrc
  are composed and held to the promises above;
- the x64 OpenRC root boots under QEMU with the Debian kernel pinned as `source.test-kernel`:
  DATA laid out on a fresh disk, every service started, a DHCP lease and its DNS server,
  the health gate confirming, the shutdown unbinding DATA, and no daemon keeping
  `CAP_SYS_RESOURCE`;
- the pools pass the pool gate and guard: a version already published rebuilds to the same
  bytes.

The verity root, DATA on real media, and the lifecycle on QEMU or hardware with mica-core's
runkit are the products' lifecycle suites.
