# 20260926-0938-rootfs-minimal Publish a minimal rootfs beside the default one

- **status**: in_progress
- **priority**: P2
- **owner**: claude/rootfs-minimal
- **createdAt**: 2026-09-26 09:38

## Description

The user asked (2026-09-26) that Base publish two roots: the default one, as today, and a
minimal one for the mini products (mica:docs/plan/20260926-0930-mini-images-on-128-mb.md):
systemd, full network configuration and the Mica lifecycle, and as little else as the root
can carry while mica-build still installs into it.

Acceptance: a release carries `rootfs-minimal.<release>` for amd64 and arm64 beside
`rootfs.<release>`, with its lock rows; the minimal root passes the base-root gate and its
own assertions; the default root is unchanged.

## ActiveForm

Adding the minimal rootfs

## Dependencies

- **blocked by**: (none)
- **blocks**: the mini products in mica-build

## Notes

Plan: docs/plan/20260926-0938-rootfs-minimal.md

2026-09-26 10:45: implemented and verified on amd64 (plan Progress). Remaining: commit,
the release (CI builds arm64), and mica-build following docs/floor-and-options.md.

2026-09-26 11:20: dmsetup made an option at the user's request (plan Annotations, 8);
rebuilt on amd64: 104.3 MB, 98 packages, `bun run check` 244 pass. Released next.
