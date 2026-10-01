# mica-deb: arches=all
# mica-openrc: debs/mica-openrc/payload, the copyright and the postinst. Built by
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
    cp -a /in/debs/mica-openrc/payload/. "$S/"; \
    find "$S" -type d -exec chmod 0755 {} +; \
    find "$S" -type f -perm /111 -exec chmod 0755 {} +; \
    find "$S" -type f ! -perm /111 -exec chmod 0644 {} +; \
    for hook in if-pre-up.d if-up.d if-down.d if-post-down.d; do install -d -m 0755 "$S/etc/network/$hook"; done; \
    install -D -m 0644 /in/debs/copyright "$S/usr/share/doc/mica-openrc/copyright"; \
    install -D -m 0755 /in/debs/mica-openrc/postinst /in/scripts/postinst; \
    bun /tooling/src/cli.ts deb pack --arch "$MICA_DEB_ARCH" --root "$S" --control /in/debs/mica-openrc/control \
        --maintainer-scripts /in/scripts --out /out
FROM scratch
COPY --from=pack /out/*.deb /
