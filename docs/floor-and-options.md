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
| Command set | **busybox only** (mica-busybox). bash, dash, coreutils, findutils, grep, sed, diffutils and gzip are installed during the bootstrap, so every maintainer script runs with the tools it was written for, then purged. The libraries only they load (libgmp10, libssl3t64, openssl-provider-legacy) go with them unless a package the root keeps depends on them. Each purged command that busybox has becomes a link to `/usr/bin/busybox` at the same path, `/usr/bin/sh` among them; no other applet is linked there (no busybox `login`, `getty`, `telnetd` or `httpd`). Every applet has a link under `/usr/libexec/busybox`, which `/etc/profile.d/mica-busybox.sh` puts last in a login shell's `PATH` (getty and SSH, either init): `ping` or `vi` answer by name, and every command the root ships keeps priority. Services' `PATH` is unchanged. |
| System policy | **mica-system**: the lifecycle helpers under `/usr/lib/mica`, the DATA layout and its mountpoints, the operator account, the interactive shell profile. Beside busybox the helpers call e2fsck and resize2fs (e2fsprogs) and findmnt (util-linux). They ask the init only through `/usr/lib/mica/mica-init`, which the init package provides, and reach micad with `dbus-send`. |
| System bus | dbus, whichever init runs it, with adduser to create its account. |
| Trust | **mica-ca-trust**, the TLS anchors of the update transport. |
| Accounts | `root` and `mica` (uid and gid 1000), both locked, both on `/bin/sh`. The system IDs of `config/ids.json` are fixed. The apps' accounts, 30000..39999, are micad's, through `mica-accounts` (below). |
| Compose toolchain | dpkg, tar, perl-base, debconf, passwd and init-system-helpers, so a composer can install into the root with dpkg. They are not device content; the composer purges the package manager at pack. |
| Not carried | an init; gconv modules, i18n data, time zones beyond UTC (`/etc/localtime` is absent), man pages, documentation beyond copyright files; OpenSSH, curl, iptables; Debian's `quota` (DATA's project quotas are set by mica-deploy's runkit, on the boards that want them). |

Every path of the root that no package owns is listed, with what wrote it, in the release's
`mica-system-base-unowned.<arch>.tsv` (165 paths, none unattributed).

### armhf: DATA in UBI

The armhf floor is for boards that keep their system in UBI volumes on raw NAND, DATA on
UBIFS: there is no ext4 file system to check or grow and no partition table to grow. Its lock
pins nothing of e2fsprogs (`e2fsprogs`, `libext2fs2t64`, `libss2`, `logsave`; `DROPPED` in
`src/rootfs.ts`), and its floor carries **mica-storage-ubi**, which provides and conflicts with
`e2fsprogs` (mica-system's Depends) and `fdisk` (mica-openrc's): the OpenRC init on armhf
takes `openrc` alone as its upstream root. Nothing on such a board runs them -- mica-openrc
grows DATA only where the board names its partitions, checks only the file systems
`/etc/fstab` gives a pass number and grows only those marked `x-systemd.growfs` -- and the
packages of amd64 and arm64 are unchanged. A product that wants the tools installs them in
place of mica-storage-ubi; `fdisk` stays an `upstream` row on armhf.

On armhf the floor is 69 packages, about 40 MB, and 9.8 MB as an xz squashfs; with
mica-openrc 78 packages and 10.3 MB (the archives unpacked and measured; amd64 measured the
same way is 43.2 MB and 12.1 MB). The compose toolchain is in those figures: perl-base alone
is 3.6 MB.

## The packages

| Package | Arch | Role | Depends |
| --- | --- | --- | --- |
| `mica-system` | all | floor: system policy for either init | dbus, passwd, e2fsprogs |
| `mica-busybox` | amd64, arm64, armhf | floor: static BusyBox from the pinned upstream release, its applets under `/usr/libexec/busybox`, last in a login shell's `PATH` | |
| `mica-ca-trust` | all | floor: the anchors of the pinned `ca-certificates`, as data | |
| `mica-systemd` | all | init: Mica OS on systemd | mica-system, systemd, systemd-sysv, systemd-resolved, systemd-repart, systemd-timesyncd, udev |
| `mica-openrc` | all | init: Mica OS on OpenRC | mica-system, mica-mdev, openrc, fdisk |
| `mica-mdev` | all | init: device nodes without udev, for mica-openrc | mica-busybox |
| `mica-systemd-boot` | amd64, arm64 | boot: the systemd-boot EFI loader of the pinned systemd, with persisted boot attempts | |
| `mica-ssh` | all | option: SSH (dropbear), started at boot from micad's saved settings | dropbear-bin, mica-system |
| `mica-openssh` | amd64, arm64, armhf | option: SSH (OpenSSH's sshd of the pinned openssh-server), started at boot from micad's saved settings; conflicts with mica-ssh | mica-system, the libraries of sshd |
| `mica-storage-ubi` | armhf | floor on armhf: stands in for e2fsprogs and fdisk where DATA is UBIFS | |
| `mica-wifi` | amd64, arm64 | option: a minimal `wpa_supplicant` from upstream hostap | libnl, libssl3t64, iw, rfkill |
| `mica-wifi-ap` | amd64, arm64 | option: a minimal `hostapd` from upstream hostap, with ACS | libnl, libssl3t64, iw, rfkill |
| `mica-bluetooth` | all | option: the HCI attach and the pairing keys on STATE | bluez, rfkill |
| `mica-tzdata` | all | option: the zoneinfo of the pinned `tzdata`, as data | |

Every package carries the start-up files of its own services, for both inits, and none of
another package's. A script for an init the root does not run is inert.

## The init

Every product installs exactly one.

| | systemd | OpenRC |
| --- | --- | --- |
| From the pool | `mica-systemd` | `mica-openrc`, `mica-mdev` |
| Roots of `upstream` rows | `systemd`, `systemd-sysv`, `udev`, `systemd-resolved`, `systemd-timesyncd`, `systemd-repart` | `openrc`, `fdisk` (armhf: `openrc`) |
| PID 1 | systemd | `openrc-init` |
| Devices | udev | busybox `mdev -d`; `/etc/mdev.conf` gives udev's owners and modes; no `/dev/*/by-*` names |
| DATA | grown with `systemd-repart` (`mica-grow-data`), checked and mounted from `/etc/fstab`, laid out | grown with `sfdisk` (`mica-grow-data`), checked (`fsck -M`: not the DATA the runkit mounted), mounted from `/etc/fstab`, `x-systemd.growfs` honoured, laid out |
| Binds and seeds | mount units: `/mica`, `/mica/containers`, `/srv`, STATE's hostname, `/var`, `/var/lib/mica`, `/root`, `/home` | `mica-mounts`, in the same order, then the `tmpfiles.d` entries |
| Network | networkd, DHCP by default; resolved; `systemd-networkd-wait-online` masked, so nothing waits for a link and `network-online.target` comes with `network.target` | `/etc/network/interfaces` (a link to `/var/lib/mica/network/interfaces`, which micad writes) applied by busybox `ifup -a`; until it exists, DHCP on every `eth*` with busybox `udhcpc`; DNS in `/run/mica/resolv.conf` |
| Time | timesyncd, on the NTP servers micad saves in `/var/lib/mica/time/timesyncd.conf` (linked as `/etc/systemd/timesyncd.conf.d/60-mica-servers.conf`) | busybox `ntpd` (`mica-ntpd`) on the `ntp_servers` micad saves in `/var/lib/mica/time/ntpd.conf`, Debian's pool until then |
| Log | journald, volatile | busybox `syslogd` and `klogd` in RAM, read with `logread` |
| Watchdog | systemd's hardware watchdog | busybox `watchdog`, 90 s |
| Health gate | `mica-health.service`, `mica-boot-failure` on failure, both writing to the journal, their verdict echoed to the console best effort (two seconds at most); `/etc/mica/health.conf` requires the init up and not in `maintenance` or `stopping`, and `micad` answering where the image carries it (`if-installed=micad`), with no wait for the boot or the network to settle | `mica-health`, last, the same, in the foreground: its lines reach the console |
| Resource limits | no service keeps `CAP_SYS_RESOURCE` (DATA's project quotas hold) | the same, `/etc/rc.conf.d/mica.conf` |
| Console | no getty until the console option installs `/usr/bin/login`; every getty after `micad.service`, never requiring it; `getty@tty1` masked, so the VT the boot logo lands on stays idle; logind's one login VT is tty2 | `mica-getty`, in `default`, after `micad`: no prompt until the console option installs `/usr/bin/login`; then agetty on every serial console of the kernel command line and, where a display exists, on tty2; tty1 stays idle |
| Enablement | links in the packages' payload; what micad enables is saved in `/var/lib/mica/units/enabled` on DATA, and `mica-units.service` starts each listed unit at boot | runlevel links in the packages' payload; `mica-units`, in `default`, the same |

The login prompt shows micad's device code under both: `/etc/issue.d/50-mica-device-code.issue`
(mica-system) links to `/run/mica/device-code.issue`, which micad writes, and agetty prints
`/etc/issue.d/*.issue` after `/etc/issue`. While micad has written none the link dangles and
the prompt shows nothing of it.

`/etc/mtab` links to `/proc/self/mounts` under both. The kernel file systems under OpenRC
are `mica-kernfs`'s; securityfs is mounted only where the kernel has it.

**Names.** micad writes the files below; the root stays read-only.

- `/etc/hosts` (mica-system) links to `/run/mica/hosts`. Base's `/usr/lib/mica/mica-hosts`
  writes it at every boot, once the persisted hostname is applied and before any service
  resolves a name: `mica-hosts.service` under systemd (after `mica-apply-hostname.service`,
  before `sysinit.target`, `systemd-resolved.service` and `nss-lookup.target`), `mica-mounts`
  under OpenRC (right after `hostname -F /etc/hostname`, before `mica-network`, `mica-dbus`
  and every service that needs `mica-mounts`). It holds
  `127.0.0.1<TAB>localhost`, `::1<TAB>localhost` and `127.0.1.1<TAB><hostname>`, mode 0644,
  then the static records micad saved in `/var/lib/mica/dns/hosts`, read on STATE
  (`/mnt/data/state/mica/dns/hosts`) because `/var/lib/mica` is not bound yet.
  micad replaces the whole file with those three lines, for the hostname of the moment,
  followed by the user's static records, written to a temporary name in `/run/mica` and
  renamed over it. Its readers -- glibc's `files` lookup (dropbear, `hostname -f`, every
  program) and systemd-resolved, which reloads it when it changes -- read it on each lookup,
  so no reader holds a stale copy and none starts before the first one is in place.
- OpenRC: `/etc/resolv.conf` links to `/run/mica/resolv.conf`, which `/usr/lib/mica/mica-resolv`
  builds from `/run/mica/resolv.d`. When `/var/lib/mica/dns/resolv.global` exists on DATA,
  it alone is `resolv.conf` and every interface's file is ignored; when it does not, the
  interfaces' files (`resolv.d/<interface>`, mica-udhcpc's) make it up. A name starting with
  a dot in `resolv.d` is never read. micad writes the global file or removes it, and runs
  `mica-resolv`; mica-udhcpc runs it after every lease change. Under systemd the global DNS
  is resolved's.
- systemd: `/run/systemd/network` and `/run/systemd/resolved.conf.d`, where micad writes
  networkd's units and resolved's drop-in, are links to `/var/lib/mica/network/networkd` and
  `/var/lib/mica/dns/resolved.conf.d` on DATA (mica-systemd's `mica-network.conf`, made by
  `systemd-tmpfiles-setup`, which networkd and resolved start after), so the init applies
  the network micad last configured at boot, with or without micad.
- OpenRC default routes: mica-udhcpc installs a lease's first router as the default route
  with `metric $IF_METRIC` when `IF_METRIC` is set and not empty, and without a metric
  otherwise. busybox ifupdown exports a DHCP stanza's `metric <n>` line as `IF_METRIC`;
  `mica-wifi-client` passes `metric=` of `/var/lib/mica/wifi/client.env`. With a metric per
  interface, two uplinks keep a default route each. With `IF_INTERNET=0` (a stanza's
  `internet 0`, an interface micad keeps off the internet) it sets the lease's address and
  subnet route and its DNS servers, and no default route; any other value, or none, keeps the
  default route. A DHCP stanza's static routes (`route_1`, `route_2`, ..., exported as
  `IF_ROUTE_<n>`, each `<destination> [via <gateway>] [metric <m>]`) are set after the lease's
  address and default route with `ip -4 route replace <value> dev <interface>`, whatever
  `IF_INTERNET` says, and deleted on `deconfig`; a route that fails is logged (syslog tag
  `mica-udhcpc`) and the others still apply. With no lease (`leasefail`; udhcpc runs with
  `-b` and goes on asking) mica-udhcpc starts BusyBox `zcip` on the interface, one per
  interface, which claims and defends a `169.254.0.0/16` address with its subnet route and no
  default route; `bound` stops it, and the address flush removes the address. Under systemd micad renders the metric, the
  gateway and the routes into the networkd units.

**Accounts.** micad runs each of the user's apps under an account of its own. The image's
`/etc/passwd` and `/etc/group` stay in place; `/usr/lib/mica/mica-accounts build` (mica-system)
binds built copies over them, `/run/mica/accounts/{passwd,group}`: the image's lines, then the
app accounts kept on STATE, `DATA/state/accounts/{passwd,group}`. It runs once STATE is bound
and before micad: `mica-accounts.service` under systemd (after `mica-seed-state.service`,
before `local-fs.target`, `micad.service` and `mica-shadow-reconcile.service`), `mica-mounts`
under OpenRC (after the hostname). The early boot -- udev or mdev, journald, D-Bus -- reads the
image's files. Without a build, or when it fails, the image's files are what everyone reads:
root, mica and every system account work, and only the app names are unknown.

micad calls it, and never edits the files:

- `mica-accounts add <name> <uid> [<gid>]` adds an app account, `gid` defaulting to `uid`. The
  name is `[a-z_][a-z0-9_-]{0,31}`, uid and gid are in `30000..39999`, and neither the name nor
  an id may belong to the image or another app account. STATE then holds
  `<name>:x:<uid>:<gid>:mica app <name>:/nonexistent:/usr/sbin/nologin` in `passwd` and
  `<name>:x:<gid>:` in `group`; `/etc/passwd` and `/etc/group` are rebound, and
  `/run/mica/shadow` gains a locked entry. The same account again succeeds and changes nothing.
- `mica-accounts remove <name>` drops it from STATE and the shadow and rebinds; an unknown
  name succeeds.
- `mica-accounts list` prints the app accounts, one a line: `<name>` TAB `<uid>` TAB `<gid>`.
- `mica-accounts build` rebinds from STATE as it is, after micad's reset has cleared it.

Each exits 0 on success; a refusal or a failure exits 1 with one `mica-accounts: ...` line on
stderr, and bad arguments exit 2 with the usage line. A malformed, out-of-range or clashing
STATE line is skipped with a `mica-accounts: skipping ...` line, never fatal. A rebind
unmounts and binds again: for that moment a reader sees the image's accounts, never half a
file. glibc's `files` lookup and the static busybox read the files on each lookup, so `ls`,
`ps` and `id` name an app account as soon as it is added.

**Device access groups.** An app runs unprivileged and reaches devices through a group, which
micad gives its account:

| Group | gid | Nodes, mode 0660 |
| --- | --- | --- |
| `gpio` | 984 | `/dev/gpiochip*` |
| `i2c` | 987 | `/dev/i2c-*` |
| `spi` | 983 | `/dev/spidev*.*` |
| `dialout` | 20 | serial ports, as Debian's udev gives them: `/dev/tty[A-Z]*[0-9]` (`ttyS`, `ttyUSB`, `ttyACM`, `ttyAMA`, `ttyFIQ`...) and `/dev/ttymxc*` |

The gids are pinned in `config/ids.json` (`dialout` is base-passwd's) and exist in the floor.
Under systemd, mica-systemd's `/usr/lib/udev/rules.d/60-mica-devices.rules` gives the nodes to
`gpio`, `i2c` and `spi`, and udev's `50-udev-default.rules` gives the serial ports to
`dialout`; under OpenRC, mica-mdev's `/etc/mdev.conf` does both.

**Runlevel membership is payload.** mica-openrc's postinst removes the runlevel links no
package owns -- what openrc imported from the SysV links, such as Debian's `dbus` -- and keeps
every link a package ships, and OpenRC's `cgroups`. A package configured after it that runs
update-rc.d (bluez) can still add an unowned link; the composer removes those at pack.

## Services and who ships them

| Service | Package | systemd | OpenRC | Started by |
| --- | --- | --- | --- | --- |
| SSH | mica-ssh or mica-openssh | `mica-sshd.service`, enabled, skipped while SSH is off | `mica-sshd`, in no runlevel; `mica-sshd-boot`, in `default`, starts it while SSH is on | boot, from the settings micad saves in `/var/lib/mica/ssh/sshd.env` on DATA (`SSH_ENABLED`, `SSH_LISTEN`, `SSH_PASSWORD`, `SSH_ROOT_LOGIN`), with or without micad, and until micad has saved them from the image's `/usr/lib/mica/ssh/sshd.env`, which mica-build writes on or off as the product's `SSH=` says; password logins only while a transient root password is set. Without micad, `mica-add-keys` adds the keys of a provisioning medium's `mica-authorized-keys` to root's and mica's `authorized_keys`. micad restarts it for new settings and stops it; both packages provide `mica-ssh-server` |
| SSH, dropbear's own | mica-ssh | `dropbear.service`, disabled by preset | `mica-dropbear`, in no runlevel | micad, after writing `/run/mica/dropbear.env` |
| Wi-Fi station | mica-wifi | `wpa_supplicant@<if>.service`, the STATE bind of `/etc/wpa_supplicant`, the regulatory database reload | `mica-wifi-client`, in no runlevel | micad, after writing `/var/lib/mica/wifi/client.env`; at boot, `mica-units` while micad has it enabled |
| Wi-Fi access point | mica-wifi-ap | `hostapd@<if>.service`, the STATE bind of `/etc/hostapd` | `mica-wifi-ap`, in no runlevel | micad, after writing `/var/lib/mica/wifi/ap.env`; at boot, `mica-units` while micad has it enabled |
| Bluetooth HCI attach | mica-bluetooth | `mica-bt.service`, enabled, inert without `/etc/mica/bt.conf` | `mica-bt`, in no runlevel, starts nothing without `/etc/mica/bt.conf` | boot (systemd); the product links it into `default` (OpenRC) |
| Bluetooth daemon | mica-bluetooth (bluez) | bluez's `bluetooth.service` with mica-bluetooth's drop-in, `var-lib-bluetooth.mount`, enabled | `mica-bluetoothd`: the STATE bind, then bluetoothd | boot where the adapter exists (systemd); micad (OpenRC) |
| Network time | mica-systemd, mica-openrc | timesyncd | `mica-ntpd`, in `default` | boot; micad restarts it for new servers |
| micad, apid | mica-core's packages | their units | their scripts | their packages |
| MQTT broker and bridge | mica-pkgs' packages | `mica-mqtt-broker.service`, `mica-mqttd.service`, reading `/var/lib/mica/mqtt/broker.toml` and `/var/lib/mica/mqtt/mqttd-device.env` | `mica-mqtt-broker`, `mica-mqttd` | micad; at boot, `mica-units` while micad has them enabled |

The board facts these services read -- `/etc/mica/bt.conf`, the radio modules and firmware,
the hwinit programs -- are the board's package (its BSP).

bluetoothd reads `/usr/lib/mica/bluetooth/main.conf` (`-f`) under both inits, not bluez's
conffile `/etc/bluetooth/main.conf`. It sets the LE connection interval to 11.25-15 ms
(`MinConnectionInterval=9`, `MaxConnectionInterval=12`, in 1.25 ms units) for BLE
provisioning; every other setting is bluetoothd's default.

## The user's own services

The root is read-only, so `systemctl enable` (which links into `/etc/systemd/system`) and
`/etc/runlevels` cannot hold a service a user adds. `mica-unit`, in either init, keeps it on
DATA state instead: it survives reboot and every update, and micad's reset clears it.

| | systemd (mica-systemd) | OpenRC (mica-openrc) |
| --- | --- | --- |
| Where | `/usr/local/lib/systemd/system`, a bind of `DATA/state/systemd-units` | `/usr/local/etc` (`init.d`, `conf.d`, `enabled`), a bind of `DATA/state/openrc-local` (mica-mounts) |
| Enabled by | links there, as the unit's `[Install]` says (`WantedBy=`, `RequiredBy=`, `Alias=`) | a link in `enabled/` |
| At boot | `mica-load-extensions` reloads systemd once the bind is up and starts `multi-user.target` again | `mica-local`, in `default`, starts every enabled script |

`mica-unit install <file>...`, `enable [--now] <unit>`, `disable [--now] <unit>`, `remove <unit>`
and `list` are the same under both. A name the root ships (in `/etc` or `/usr/lib`, or
`/etc/init.d`) is refused, so a user service can never replace or mask one of Mica's. For
example, a Tailscale node agent with its binaries in `/srv/tailscaled`:

```sh
# systemd: a unit with [Install] WantedBy=multi-user.target
mica-unit install /srv/tailscaled/tailscaled.service
mica-unit enable --now tailscaled

# OpenRC: an openrc-run script, and its settings for conf.d if it has any
mica-unit install /srv/tailscaled/tailscaled
mica-unit install --conf /srv/tailscaled/tailscaled.conf
mica-unit enable --now tailscaled
```

A user service starts after micad (and after the D-Bus micad answers on), never needing it: it
starts even when micad does not. It cannot be ordered before micad or into the early boot; the
units on DATA are loaded only once DATA is bound.

micad declares user services too: the settings `services.units`, `micad unit` on the device,
`/api/v1/units` and the console (mica-core `docs/mica-core.md` section 3.10). It applies them
through `mica-unit`, into the same directories, and removes only the units it applied; a service
installed with `mica-unit` by hand stays, and `mica-unit` remains for that hand use. micad relies
on this contract of `mica-unit`, under both inits:

- `list` prints one line per service, `<name>` TAB `enabled` or `disabled`.
- `install <file>` names the service after the file's basename.
- `install --conf <file>` (OpenRC) names the settings after the basename without `.conf`.
- `enable`, `disable` and `remove <name>` exit 0 on success; a refusal exits 1 with a
  `mica-unit: ...` line on stderr, bad arguments exit 2 with the usage line on stderr, and a
  failing `systemctl` or `rc-service` passes on its own exit status and message.

## The options

| Option | What a product installs | Where it is pinned |
| --- | --- | --- |
| SSH | `mica-ssh` (dropbear) or `mica-openssh` (OpenSSH) | pool; dropbear-bin and the libraries of sshd are `upstream` rows, openssh-server and openssh-client `input` rows per architecture |
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
| System tools | any of the **tools** section of `locks/upstream.pkgs`: `iproute2`, `iputils-ping`, `ethtool`, `tcpdump`, `curl`, `bind9-dnsutils`, `strace`, `lsof`, `htop`, `less`, `vim-tiny`, `pciutils`, `usbutils`, `i2c-tools`, `gpiod`, `can-utils`, `parted`, `rsync`, `jq`, ... | `upstream` rows |

An option that is a Debian package, and every other Debian package a later stage installs,
comes from the release's `upstream` rows (below).

## The upstream rows

The `upstream` rows of `mica-system-base.lock` are Base's contract for every Debian package
beyond the floor. Their form, `upstream <name> <arch> <version> <sha256> <url> <roots>`, is
the release lock's (mica-build-tools `docs/spec/release-lock.md`); what they promise is set
here.

- **What is pinned.** Every package of `locks/upstream.pkgs` -- the inits' roots, and
  **options**: the options above and what boards and engines install (the radio tools,
  board audio, mica-podman's libraries), and **tools**: system tools an image may install
  without a change to Base -- with its closure beyond the floor as published.
  That closure includes what the floor purged: systemd's rows carry libssl3t64, coreutils'
  libgmp10.
- **Roots attribute a row; they do not gate it.** `<roots>` names the roots of
  `locks/upstream.pkgs` whose closure holds the row. A later stage takes **any** row by its
  package name and architecture, a root or not.
- **The rows are closed.** Every row's dependencies are rows of the same release or in the
  floor, and CI bootstraps all of them together with the floor on every architecture
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

CI, on native amd64 and arm64 runners, and for armhf on the amd64 runner with its maintainer
scripts under QEMU:

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
