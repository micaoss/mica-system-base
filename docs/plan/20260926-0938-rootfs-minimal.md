# 20260926-0938-rootfs-minimal One floor rootfs and optional packages

- **status**: completed
- **createdAt**: 2026-09-26 09:38
- **approvedAt**: 2026-09-26 10:06
- **relatedTask**: 20260926-0938-rootfs-minimal

## Context

Measured on the default root of release 20260920-0832 (amd64): 132 MB, 128 packages.

- **The root is a compose base, not the device root.** mica-build installs its packages into
  it with dpkg and runs their maintainer scripts, then its selection keeps only what its
  retention rules name and purges the package manager. So the minimal root must stay
  installable by dpkg.
- **What that forces.** The 22 Essential packages are 58.1 MB: coreutils 18, perl-base 8,
  bash 7, dpkg 6, util-linux 5, tar 3, diffutils 2, findutils 2, libc-bin 2 and small ones.
  dpkg depends on tar; dbus-system-bus-common's postinst calls adduser, a perl script; PAM,
  quota and tzdata need debconf, also perl. The Essential set stays in both roots, and
  replacing GNU tools with busybox on a device is the product's retention, in mica-build.
- **What a minimal root can shed and still install**, by dpkg path-exclude at bootstrap (the
  mechanism SLIM already uses for docs, man pages and locales):
  - glibc's gconv charset modules, 8.2 MB, which nothing in the root loads;
  - `/usr/share/zoneinfo` beyond UTC, 1.9 MB;
  - `/usr/share/i18n` and the locale data, 0.4 MB; terminfo beyond a handful of terminals, 0.2 MB.
- **What it can shed as packages.** mica-system depends on dmsetup, kmod, procps, nftables and
  dropbear-bin, and none of its payload scripts or units calls dmsetup, kmod, procps or nft;
  dropbear is SSH, nftables is micad's firewall. tzdata is pulled only for zoneinfo.
- **Publication.** The release-lock format already takes more than one image name per
  repository (mica-build-env publishes base, c, go and rust), so
  `image mica-system-base rootfs-minimal <platform> <reference>` rows need no format change;
  publish.ts writes `rootfs.<release>` and its three rows today.
- **Login shells.** root and mica log in with `/bin/bash`: pinned in ids.json, checked by
  mica-system's postinst, and rendered by micad's sshd reconciler. bash stays in both roots.

## Proposal

Base publishes one root, the **floor**, and everything a device may or may not need as
**optional packages** in its pool and upstream rows; mica-build composes each product from
the floor and the options it selects, through its feature manifests. The two-root design of
the first draft is dropped (Annotations).

### The floor

What every Mica device needs, and nothing else:

- systemd with systemd-sysv, udev and dbus; networkd, resolved and timesyncd (full network
  configuration, and no library PID1 does not already load);
- mica-system: the lifecycle helpers, mounts and DATA layout, with systemd-repart,
  e2fsck and resize2fs (e2fsprogs) and setquota (quota) that they call;
- mica-busybox as the one command set, `/bin/sh` included;
- mica-ca-trust, for the update transport;
- gconv, zoneinfo but UTC, i18n and most of terminfo excluded by dpkg path-exclude.

Whatever dpkg and the maintainer scripts need to install into it (dpkg, tar, perl-base,
debconf, adduser, passwd, init-system-helpers) is the compose toolchain: in the image,
removed by mica-build at pack as today.

### The options

| Option | Package | Carries |
|---|---|---|
| SSH | `mica-ssh` (new) | dropbear-bin, `dropbear.service`, `mica-dropbear-prestart`, the dropbear preset and gates, all moved out of mica-system |
| Console login | `mica-console` (new) | login, agetty and PAM for tty1 and the serial console, and the gate that asserts them; the floor has no getty |
| Firewall | nftables | the tool; mica-podman depends on it for containers |
| GNU tools | coreutils, findutils, grep, sed, diffutils, gzip | the GNU command set beside busybox |
| Shell | bash | an interactive shell; `/etc/profile.d/mica-shell.sh` stays inert without it |
| Operator tools | procps, dmsetup, kmod | ps and top, device-mapper, module loading |
| Time zones | tzdata | every zone beyond UTC |
| Wi-Fi | mica-wifi, mica-wifi-ap | already packages |

Options that are Debian packages stay pinned in the lock's upstream rows and are selected by
name; a Mica package exists only where the option carries payload.

### P0, before anything is committed

In containers, from the lock's snapshot and this repository's packages:

1. Bootstrap the floor and measure it (size, packages, the Essential set it still carries).
2. Strip it: purge bash, dash and the GNU command packages, install busybox applet links in
   `/usr/bin` and `/usr/sbin`, and install mica-system on it so that its postinst runs on
   busybox (the same `useradd` pattern as mica-core's mqtt packages).
3. Install every Debian option above into the stripped floor with `dpkg --unpack` and
   `dpkg --configure -a`, as mica-build does, and record what fails.
4. Boot the stripped floor under systemd-nspawn to `multi-user.target`, with networkd and
   resolved running.

The floor ships stripped: the image is the device's command set (Annotations, 7). What 2 to 4
find is fixed on this side, by an applet enabled in mica-busybox's config or a script made
busybox-clean, and a GNU binary is kept only where neither can be done, named in the plan.

### Then

- mica-system loses the Depends and payload the options take, and its version is bumped;
  `mica-ssh`, `mica-console` and, if the strip holds, `mica-busybox-applets` are added;
- the base-root gate asserts the floor, and each option package's own facts move to its
  package gate;
- `docs/floor-and-options.md`: what the floor carries, each option and what it carries, and
  what mica-build changes to compose today's products from them (retire `radio-wifi`, feature
  manifests for the options, retention rules, and the checks that assume SSH, nftables, a
  tty1 console or GNU tools in every image). The release that ships the floor names it.

## Risks

- **Every product changes.** A mica-build that pins the release with the floor and composes as
  today loses SSH, the console, nftables and the GNU tools. The migration document and the
  release note say so; mica-build moves in one change.
- **Maintainer scripts on busybox** (a stripped floor): P0 answers it for the options listed;
  a later package with a GNU-only script fails on install in mica-build.
- **Gates split**: base proves the floor and each option package alone, not their
  combinations.

## Scope

mica-system-base: bootstrap and selection, mica-system and the new option packages, gates and
tests, docs. mica-build follows the migration document.

## Alternatives

- Two roots, default and minimal (the first draft): rejected by the user.
- Keep the GNU tools in the floor as compose toolchain and let mica-build swap to busybox at
  pack: rejected by the user (Annotations, 7).

## Progress

### 2026-09-26: P0

amd64, in a privileged trixie container, from the lock's snapshot 20260905T000000Z and this
repository's mica-system, mica-busybox and mica-ca-trust; mica-system repacked with the floor's
Depends and `/bin/sh` as the operator shell. Harness and logs under `/srv/micaoss/.tmp/p0/`.

1. **The floor** (Essential set, systemd, udev, dbus, networkd, resolved, timesyncd, repart,
   e2fsprogs, quota, passwd, mica-busybox, mica-ca-trust; gconv, i18n, docs, man pages and
   locales excluded): **113.5 MB, 105 packages**, against the default root's 132 MB and 128.
2. **The strip**: bash, coreutils, findutils, grep, sed, diffutils and gzip purged with
   `--force-remove-essential`, busybox links bridged in `/usr/local/bin` meanwhile; **103.9 MB**
   after. busybox provides 99 of their commands; it lacks b2sum, basenc, chcon, csplit, dir,
   dircolors, fmt, join, numfmt, pathchk, pinky, pr, ptx, runcon, sha224sum, stdbuf, vdir,
   rgrep, diff3, sdiff, uncompress and the gz* helpers. Two findings:
   - dash cannot be purged in place: its postrm runs through `/bin/sh`, which the purge has
     just removed, and it is left half-removed with debianutils. `/usr/bin/sh` has to be
     diverted to busybox before dash goes.
   - debianutils' `update-shells` trigger calls `chmod --reference`, `chown --reference` and
     `mv -Z`, which busybox has not; it reports them and the trigger still completes.
3. **mica-system on busybox**: its postinst (`groupadd`, `useradd`, `chage`, `awk`) completes;
   `mica:x:1000:1000:mica operator:/home/mica:/bin/sh`.
4. **The options, by `dpkg --unpack` and `--configure -a`** on the stripped floor:
   dropbear-bin, nftables, procps, dmsetup, kmod, login, bash, iw, rfkill, mica-wifi and
   mica-wifi-ap configure. **tzdata does not**: its postinst parses a date with GNU `date`
   (`date: invalid date 'Sat Sep 26 09:57:23 UTC 2026'`).
5. **Boot** under `systemd-nspawn --boot` of the stripped floor: `multi-user.target` reached,
   no failed unit; systemd-networkd, systemd-resolved, dbus and systemd-journald active;
   timesyncd and udevd skipped by their container conditions, as systemd does in any container.

What A needs on this side, from P0:

- the strip diverts `/usr/bin/sh` to busybox before it removes dash;
- time zones as `mica-tzdata`, the zoneinfo of the pinned tzdata archive as payload and no
  maintainer script, the way mica-ca-trust carries ca-certificates;
- `/etc/profile.d/mica-shell.sh` runs `dircolors` only if it exists: with the bash option and
  no GNU tools it would print an error at every login;
- the missing commands listed in the migration document, for mica-core and mica-build scripts.

### 2026-09-26: the floor, built

Implemented as proposed. dmsetup was first kept in the floor for its udev rules, on the
belief that the verity root needed them; it does not (Annotations, 8) and it is an option.
The console option is Debian's `login`, not a package of
this repository: the floor's `getty@` and `serial-getty@` drop-ins wait for `/usr/bin/login`.
Busybox links are made only for the commands of the purged GNU packages, so no applet
busybox merely has (login, getty, telnetd, httpd) appears.

`bun src/container.ts rootfs --arch amd64`: 103 locked packages and mica-system,
mica-busybox and mica-ca-trust bootstrapped, stripped, `assertBase` passed; **104.3 MB, 98
packages installed, 100 busybox links**, `/usr/bin/sh` busybox, root and mica on `/bin/sh`,
no gconv module; 189 unowned paths, 0 without a named writer. On a copy, every option
(mica-ssh, login, nftables, kmod, procps, mica-tzdata, bash and the GNU command set, iw,
rfkill, mica-wifi, mica-wifi-ap) installed with `dpkg --unpack` and `--configure -a` and
`dpkg --audit` clean; coreutils replaced the busybox links at the paths it ships. Both the floor and the
composed copy boot under systemd-nspawn to `multi-user.target`, with the DATA units masked
in the copy (a container has no DATA): the one failed unit is mica-health, the deployment
gate; resolved, dbus and journald active; networkd waits for `var.mount`, masked there;
dropbear present and disabled. `bun run check`: 244 tests pass. arm64 is built by CI.

## Annotations

2026-09-26, the user's decisions on the first draft:

1. The minimal root carries no nftables. SSH is an optional package, not built in.
2. One command set: busybox, in place of the GNU tools, in the minimal root.
3. The minimal root carries no bash; mica-core is being changed not to depend on it.

2026-09-26, second round:

4. Everything beyond a floor becomes an optional package, and mica-build composes. One root,
   not two.
5. The console login is an option, not part of the floor.
6. Base writes the migration document; the mica-build side follows it.
7. The floor is stripped: busybox is its only command set, in the image as on the device.
8. dmsetup is an option too (2026-09-26). Checked before moving it: the kernel assembles the
   verity root itself from the `dm-mod.create=` table (`CONFIG_DM_INIT`, `root=/dev/dm-0`,
   no initramfs, mica-build `stages/compose/compose-install.sh`), and mica-deploy opens
   `/dev/mapper/control` and makes its `/dev/mapper` links itself
   (mica-core `crates/mica-deploy/src/boot/startup/verity.rs`); nothing in the floor calls
   dmsetup or needs its udev rules.
