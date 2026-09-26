# 20260926-2122-switch-to-mica-build-tools Switch to mica-build-tools and mica-build-env 20260926-2110

- **status**: completed
- **priority**: P1
- **owner**: claude/build-tools-switch
- **createdAt**: 2026-09-26 21:22

## Description

Run the release-lock and build rules through mica-build-tools and delete this repository's own
implementation, per `mica-build-tools:docs/design.md` section 8, and pin mica-build-env
20260926-2110. Plan: docs/plan/20260926-2122-switch-to-mica-build-tools.md.

## ActiveForm

Switching to mica-build-tools

## Dependencies

- **blocked by**: (none; mica-build-tools `5d0a5d9` carries tasks 2126, 2129 and 2215)
- **blocks**: Base publishing three `apt` rows (mica plan 20260926-1125-apt-row-per-source)

## Notes

(none)

- complete: Released 20260926-2254 on mica-build-tools 5467dbc and mica-build-env 20260926-2110
