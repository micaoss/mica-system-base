# mica-deb: arches=all
# mica-mdev: debs/mica-mdev/payload and the copyright. Built by
# `bun src/container.ts debs` with the named contexts `debs` and `tooling` (the
# pinned mica-build-tools checkout).
ARG MICA_BUILD_IMAGE
FROM ${MICA_BUILD_IMAGE} AS pack
ARG MICA_DEB_ARCH
ARG MICA_DEB_SOURCE_REPO
ARG SOURCE_DATE_EPOCH
# Files at git's modes (0755 executable, 0644 otherwise, 0755 directories),
# whatever the checkout's umask; symbolic links as they are.
RUN --mount=type=bind,from=debs,target=/in/debs \
    --mount=type=bind,from=tooling,target=/tooling \
    set -eu; \
    S=/stage; mkdir -p "$S"; \
    cp -a /in/debs/mica-mdev/payload/. "$S/"; \
    find "$S" -type d -exec chmod 0755 {} +; \
    find "$S" -type f -perm /111 -exec chmod 0755 {} +; \
    find "$S" -type f ! -perm /111 -exec chmod 0644 {} +; \
    install -D -m 0644 /in/debs/copyright "$S/usr/share/doc/mica-mdev/copyright"; \
    bun /tooling/src/cli.ts deb pack --arch "$MICA_DEB_ARCH" --root "$S" --control /in/debs/mica-mdev/control --out /out
FROM scratch
COPY --from=pack /out/*.deb /
