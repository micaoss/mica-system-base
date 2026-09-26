# The floor and its options

From the release that ships this document, `image mica-system-base rootfs` is the
**floor**: what every Mica device needs and nothing else. Everything beyond it is
an **option** a product adds when it composes its root. This is the contract for
a composer (mica-build) and what it has to change to compose today's products
from it. Decided by the user on 2026-09-26 (plan
`docs/plan/20260926-0938-rootfs-minimal.md`).

## What the floor carries

- **systemd** as PID 1 (systemd-sysv), **udev**, **dbus**, and full network
  configuration: systemd-networkd, systemd-resolved, systemd-timesyncd, with
  networkctl and resolvectl. networkd loads no library PID 1 does not already
  load.
- **mica-system**: the lifecycle helpers under `/usr/lib/mica`, the mounts and
  the DATA layout, with what they call beside busybox: systemd-repart, e2fsck
  and resize2fs (e2fsprogs), setquota (quota), findmnt (util-linux).
- **mica-busybox as the only command set.** bash, dash, coreutils, findutils,
  grep, sed, diffutils and gzip are installed during the bootstrap, so every
  maintainer script runs with the tools it was written for, and then purged.
  Each command of theirs that busybox has is a link to `/usr/bin/busybox` at the
  path the package had it, `/usr/bin/sh` among them. No other applet is linked:
  busybox's `login`, `getty`, `telnetd` or `httpd` do not appear.
- **mica-ca-trust**, for the update transport.
- **Accounts**: `root` and `mica` log in with `/bin/sh`; both are locked.
- **No getty.** `getty@.service` and `serial-getty@.service` start only once
  `/usr/bin/login` exists (the console option).
- **Nothing of**: gconv charset modules, i18n data, time zones beyond UTC (the
  system is on UTC while `/etc/localtime` is absent), man pages, docs beyond
  copyright files.
- **The compose toolchain**: dpkg, tar, perl-base, debconf, passwd and
  init-system-helpers stay in the image so a composer can install into it with
  dpkg. They are not device content; a composer purges the package manager at
  pack, as mica-build does today.

The base-root gate (`src/rootfs.ts` `assertBase`) asserts each of these.

## The options

| Option | What a product installs | Where it is pinned |
| --- | --- | --- |
| SSH | `mica-ssh` (dropbear-bin, `dropbear.service`, `mica-dropbear-prestart`, the preset that keeps it disabled; micad enables it at runtime) | pool package; dropbear-bin is an `upstream` row |
| Console login | `login` (with the drop-ins above, gettys start once it is there) | `upstream` row |
| Firewall | `nftables` (never enabled at boot: `50-mica-nftables.preset` stays in mica-system) | `upstream` row; mica-podman depends on it |
| Module loading | `kmod` (`modprobe`; systemd-udevd loads modules through libkmod without it) | `upstream` row |
| Process tools | `procps` (ps, top, free, kill; the floor has only `busybox ps`) | `upstream` row |
| Device-mapper tools | `dmsetup` (dmsetup, dmstats, and the udev rules that name dm devices; the verity root needs none of it: the kernel assembles it from the `dm-mod.create=` table, and mica-deploy names `/dev/mapper` itself) | `upstream` row |
| Time zones | `mica-tzdata` (the zoneinfo of the pinned tzdata as payload; provides, conflicts with and replaces `tzdata`, whose postinst needs GNU `date`) | pool package |
| GNU command set | `coreutils`, `findutils`, `grep`, `sed`, `diffutils`, `gzip` | `upstream` rows (they are the archives the floor installed and purged) |
| Shell | `bash`; `/etc/profile.d/mica-shell.sh` colors its prompt and stays inert under busybox | `upstream` row |
| Wi-Fi station | `mica-wifi` | pool package (since 20260926-0933) |
| Wi-Fi access point | `mica-wifi-ap` | pool package (since 20260926-0933) |

An option that is a Debian package is an `upstream` row of the release lock,
tagged with its own name; an option with payload of its own is a package of the
pool.

## What changes in mica-build

1. **Pin the release with the floor and add the options each product had.** A
   product composed as before loses SSH, the console, nftables, procps, kmod,
   dmsetup, time zones and the GNU tools. The products that had all of them add
   `mica-ssh login nftables kmod procps dmsetup mica-tzdata` and, where scripts or
   operators rely on them, the GNU command set and `bash`; a mini product adds
   only what it uses. The feature manifests (`rootfs/packages/*.pkgs`) are where
   those names go.
2. **Wi-Fi**: retire `producers/radio-wifi`. Base's `mica-wifi` and
   `mica-wifi-ap` carry what it shipped (the STATE binds, the regulatory
   database reload) and the daemons themselves.
3. **Retention rules** (`src/rootfs/runtime/consumers.json`) that name packages
   no longer in the floor move to the option they belong to or go:
   - mica-system's "retained operator and service tools" names bash, dash,
     coreutils, findutils, grep, sed, gzip, diffutils, procps, kmod, login,
     dmsetup, dropbear-bin and nftables; on the floor the commands are busybox links,
     unowned paths written by the bootstrap and listed in
     `mica-system-base-unowned.<arch>.tsv` with the writer
     `src/bootstrap.ts strip (a command of a purged GNU package, now busybox)`;
   - the dropbear paths are mica-ssh's; the zoneinfo rules are mica-tzdata's,
     and the floor has no `/usr/share/zoneinfo/UTC`;
   - the gconv rule has nothing to keep;
   - the libpcsclite shim rule is gone with Debian's wpa_supplicant.
4. **Checks that assume an option in every image** become checks of that option:
   `packed-nft-present` (firewall), the tty1 console, dropbear and its
   PAM-freedom (now asserted by mica-ssh's build), and anything that expects a
   GNU tool or bash.
5. **Composition runs on busybox.** A later package's maintainer scripts see
   busybox. Measured on the floor with `dpkg --unpack` and `--configure -a`:
   dropbear-bin, nftables, procps, dmsetup, kmod, login, bash, iw, rfkill,
   mica-wifi and mica-wifi-ap configure; Debian's tzdata does not (hence
   mica-tzdata). debianutils' `update-shells` trigger reports `chmod
   --reference`, `chown --reference` and `mv -Z`, which busybox lacks, and still
   completes. A package whose scripts need a GNU flag installs after the GNU
   command set, or not at all.
6. **Scripts in mica-core and mica-build** run on busybox and `/bin/sh`: no bash,
   and none of the commands busybox lacks: b2sum, basenc, chcon, csplit, dir,
   dircolors, fmt, join, numfmt, pathchk, pinky, pr, ptx, runcon, sha224sum,
   stdbuf, vdir, rgrep, diff3, sdiff, uncompress and the gz* helpers (zcat is an
   applet). micad's sshd reconciler renders `/bin/sh` for root and mica.

## Verified, and not yet

On amd64 (2026-09-26), the floor as `bun src/container.ts rootfs` builds it: 104.3 MB, 98
packages, 100 busybox links, 189 unowned paths all attributed. Every option above installs
on it with `dpkg --unpack` and `--configure -a` and leaves `dpkg --audit` clean; coreutils
replaces the busybox links at the paths it ships. The floor and the composed root boot under
systemd-nspawn to `multi-user.target` with resolved, dbus and journald active (the DATA
units masked, as a container has no DATA; networkd waits for `var.mount`). The verity root,
the DATA units and the lifecycle on QEMU or hardware are the products' lifecycle suite
(mica:docs/plan/20260926-0930-mini-images-on-128-mb.md, P3).
