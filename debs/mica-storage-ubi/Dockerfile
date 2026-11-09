# mica-deb: arches=armhf
# mica-storage-ubi: debs/mica-storage-ubi/payload, the control file and the
# copyright. Built by
# `bun src/container.ts debs` with the named contexts `debs` and `tooling` (the
# pinned mica-build-tools checkout).
ARG MICA_BUILD_IMAGE
FROM ${MICA_BUILD_IMAGE} AS pack
ARG MICA_DEB_ARCH
ARG MICA_DEB_SOURCE_REPO
ARG SOURCE_DATE_EPOCH
RUN --mount=type=bind,from=debs,target=/in/debs \
    --mount=type=bind,from=tooling,target=/tooling \
    set -eu; \
    S=/stage; mkdir -p "$S"; \
    cp -a /in/debs/mica-storage-ubi/payload/. "$S/"; \
    find "$S" -type d -exec chmod 0755 {} +; \
    find "$S" -type f -exec chmod 0644 {} +; \
    install -D -m 0644 /in/debs/copyright "$S/usr/share/doc/mica-storage-ubi/copyright"; \
    bun /tooling/src/cli.ts deb pack --arch "$MICA_DEB_ARCH" --root "$S" --control /in/debs/mica-storage-ubi/control --out /out
FROM scratch
COPY --from=pack /out/*.deb /
