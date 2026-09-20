# mica-system-base

The board-independent base system of Mica OS: the pinned Debian lock, the
packages built from this repository, and the base root assembled from both.

## Published artifacts

A release is named by its UTC minute, `YYYYMMDD-HHMM` (for example
`20260914-0130`), with no prefix or suffix. It is cut with
`gh release create 20260914-0130 --target <commit>`, which creates the git tag;
publishing that GitHub release runs `release.yml`, which builds the tag and
publishes it to `ghcr.io/micaoss/mica-system-base` (`ci.yml` runs the gates on
pushes and pull requests and publishes nothing):

| Tag | Content |
| --- | --- |
| `pool.<arch>.20260914-0130` | this repository's packages for amd64 or arm64, one layer per `.deb` titled with its file name and annotated `mica.inputs`; the manifest names only the repository and the architecture, so an unchanged pool is the same digest under the next release's tag |
| `rootfs.20260914-0130` | the base root, an OCI image index for `linux/amd64` and `linux/arm64` |

The GitHub Release carries exactly two assets, never replaced, in the release
lock format of `mica:docs/design/release-lock.md`:

| Asset | Content |
| --- | --- |
| `mica-system-base.lock` | `mica-lock v1`: the `release` row; `image mica-system-base rootfs` rows for the index and its amd64 and arm64 manifests; a `pool` row per architecture; a `package` row per package of this repository and architecture (the pool layer with that sha256); an `upstream` row per Debian package pinned for later stages and architecture (version, sha256, snapshot URL and the `upstream.pkgs` roots it is pinned for); and one `apt` row, the Debian snapshot the root was built from |
| `SHA256SUMS` | the sha256 of `mica-system-base.lock`, its only line |

## Consuming a release

A later stage (a board, a product) that builds on a Base release follows these
rules:

1. Pin the release (release lock section 4): commit the release's
   `mica-system-base.lock` unchanged as `locks/mica-system-base.lock` and its pin
   `locks/pins/mica-system-base.pin` (`# mica-pin v1`, `REPOSITORY`, `RELEASE`,
   and `SHA256SUMS`, the sha256 of the release's `SHA256SUMS`). Download
   `SHA256SUMS`, refuse it unless it hashes to the pinned value, and refuse the
   lock unless `sha256sum -c SHA256SUMS` passes. Moving to another release
   replaces the lock and the pin together.
2. The root is the `image mica-system-base rootfs <arch>` row, taken by digest. Base's own
   packages, such as `mica-systemd-boot`, are the `package` rows: the layer of
   that architecture's `pool` whose digest is the row's sha256.
3. A Debian package pinned for later stages is taken from the `upstream` rows:
   the rows for the root's architecture whose roots column names the package
   are it and its closure beyond the base root. Download each URL, refuse it
   unless it hashes to the row's sha256, and `dpkg --install` them into the root.
   Base bootstraps these packages together with the root in CI.
4. A Debian package that is not pinned there is either asked of Base (it is
   added to `upstream.pkgs` and pinned in the next release) or resolved by the
   consumer from the `apt` row alone, never with another source or suite, so it
   matches the libraries in the root:
   - render the row as an apt source (`Types: deb`, `URIs`, `Suites` and
     `Components` from the row, `Signed-By` its keyring path,
     `Check-Valid-Until: no`) and run apt in a build container, not in the root,
     with that as its only source and `Dir::State::status` set to the root's own
     `/var/lib/dpkg/status`, taken from the rootfs image of that architecture;
   - `apt-get install --print-uris --no-install-recommends <packages>` names the
     archives the root lacks; download them and refuse any whose sha256 differs
     from the signed index (`apt-cache show <package>=<version>`);
   - record the resolved package, architecture, version, sha256 and URL in the
     consumer's own `locks/upstream.lock`, install them with dpkg onto the root,
     and test the result in the consumer's CI, since Base has not bootstrapped
     them.
5. System IDs: the groups and users Base pins (`ids.json`) already exist in the
   root. A package that creates any other is the consumer's to pin before it is
   installed, or to ask Base to pin.

## The operator account

The root has two accounts and neither can log in with a password: `root` is
`*` and the operator `mica` (uid and gid 1000) is `!` in `/etc/shadow`. A signed
root is byte-identical on every device, so a password inside it would be one
secret shared by the fleet; `mica-shadow-reconcile` rebuilds the shadow file in
RAM at every boot and re-locks anything that is not locked. The only password
that can exist is a transient root password set through micad, and it is gone at
the next boot. The console is for reading; interactive access is micad's to
grant, and it is also what enables `dropbear` at runtime.

Three consequences of that account, decided on 2026-09-20 and recorded here
because a reader cannot reconstruct them from the files:

- **`/home/mica` is not in the root, deliberately.** The postinst creates the
  account with `useradd --no-create-home`, `mica-seed-home` creates
  `/mica/home/mica` on DATA owned 1000:1000 mode 0700 and leaves an existing one
  alone, and `home.mount` binds it onto `/home` after that service. A home in the
  image would be a home nobody can keep, which is also why the uid and gid are
  fixed. If the home is ever missing on a device, the fault is
  `mica-seed-home.service` or `home.mount`, not the account.
- **`uidmap` is absent on purpose.** `newuidmap` and `newgidmap` are not
  installed: nothing this repository ships maps a user namespace, and rootless
  containers are deliberately unsupported (`mica-podman`). If a later stage ever
  wants rootless, `uidmap` is a row of `upstream.pkgs` -- pinned for later stages
  and not installed in the root -- rather than a change to the base root.
- **`/etc/subuid` and `/etc/subgid` are kept, inert by design.** `mica:100000:65536`
  is what `useradd` writes from `login.defs`; no code here asks for it. With no
  `uidmap` in the root the ranges do nothing, and they stay because suppressing
  them would be this repository inventing a policy to undo a Debian default.

## Layout

| Path | Content |
| --- | --- |
| `locks/mica-build-env.lock`, `locks/pins/mica-build-env.pin` | the build environment: the lock asset of a mica-build-env release, committed unchanged, and its pin; every image is taken from its rows: its base and C images, and from its `upstream` rows the Dockerfile frontend and the BuildKit the builder runs |
| `locks/upstream.lock` | every third-party pin, as `source` rows: the Debian archives of the runtime lock, `input.<name>` and `build.<package>.<name>` archives of the packages under `debs/`, and the `source.<name>` upstream source archives they compile |
| `packages.tsv` | the consumers that select each Debian package of the runtime lock: `base`, a package of `debs/consumers.pkgs`, or `upstream-<root>` |
| `sources.json`, `ids.json` | the Debian snapshot and suite the lock is resolved from (the release's `apt` row), and fixed system IDs |
| `upstream.pkgs` | the Debian packages later stages install, pinned as the release lock's `upstream` rows |
| `debs/consumers.pkgs` | the consumer registry: the local packages a selection may name |
| `debs/<package>/` | a package: `control`, `Dockerfile`, optional `postinst`, and `build-sources.json` for the snapshot its build tools are resolved from |
| `payload/` | the files `mica-system` installs |
| `src/`, `tests/` | the build tooling and its tests (Bun + TypeScript); `tests/vectors/` is a copy of the release lock test vectors |
| `environment.json` | the local environment image tag and the Bun of the base image |

## Commands

```sh
bun install
bun src/container.ts environment             # check locks/ against the mica-build-env release, pull its base image
bun run check                                # lint, typecheck, tests in the environment image
bun src/container.ts cache --arch amd64 --all   # download and verify the pinned archives
bun src/container.ts debs [--arch amd64]    # build the packages into _out/debs/<arch>/pool
bun src/container.ts rootfs --arch amd64     # assemble and gate _out/rootfs/<arch>
bun src/publish.ts layer --arch amd64        # pack that root into _out/layers/<arch>
bun src/publish.ts gate                      # both pools as one build (all archives identical)
bun src/container.ts pin-inputs              # re-pin the input, build and upstream rows of locks/upstream.lock
bun src/publish.ts lock --dry-run --tag 20260914-0130  # the release lock of this build
bun src/publish.ts pool | rootfs | lock      # publish the pools, the layers and the lock (CI)
```

CI builds each architecture on its own native runner (`ubuntu-latest`,
`ubuntu-24.04-arm`) through `.github/workflows/build.yml`: packages, root and
layer per architecture, then `gate` over both pools; `release.yml` publishes
those artifacts. The workflows cache only downloads, the Bun install cache and the
pinned Debian archives, keyed on the files that pin them and saved only by pushes
to main; the packages always build without a cache and every archive is
verified against its pin. Locally, a foreign architecture builds under the
BuildKit builder's emulation.

Packages are locked by their own version (mica:docs/decisions/2026-09-15-package-versions.md).
Each `debs/<package>/control` declares its `Version` and, beside it,
`Source-Date-Epoch`, the SOURCE_DATE_EPOCH of that version; a release never
changes either, and no package carries a commit or a release. A packaging-only
change bumps the Debian revision, an upstream change the upstream part; both
bump the epoch. `bun src/publish.ts gate` (CI) and the release compare every
package with the latest release: the same version must record the same
`mica.inputs` (the sha256 over its files, the packer, its lock rows and its
architecture; build-env images excluded) and rebuild to the published bytes,
which the release then reuses; a lower version is refused.

A package is added by creating `debs/<package>/` with a `control` template and a
`Dockerfile` whose first line declares `# mica-deb: arches=all|amd64,arm64
[inputs=...] [build=...] [sources=...]`.
