# mica-deb: arches=all
# mica-system: the payload/ tree, its empty mountpoints, the copyright and the
# postinst. Built by `bun src/container.ts debs` with the named contexts
# `payload`, `debs` and `tooling` (src/).
ARG MICA_BUILD_IMAGE
FROM ${MICA_BUILD_IMAGE} AS pack
ARG MICA_DEB_ARCH
ARG MICA_DEB_SOURCE_REPO
ARG SOURCE_DATE_EPOCH
# Files at git's modes (0755 executable, 0644 otherwise, 0755 directories),
# whatever the checkout's umask. The empty directories are mountpoints git
# cannot carry; /root is 0700.
RUN --mount=type=bind,from=payload,target=/in/payload \
    --mount=type=bind,from=debs,target=/in/debs \
    --mount=type=bind,from=tooling,target=/tooling \
    set -eu; \
    S=/stage; mkdir -p "$S"; \
    cp -a /in/payload/. "$S/"; \
    find "$S" -type d -exec chmod 0755 {} +; \
    find "$S" -type f -perm /111 -exec chmod 0755 {} +; \
    find "$S" -type f ! -perm /111 -exec chmod 0644 {} +; \
    for d in home mica mnt/data mnt/system srv usr/lib/firmware usr/lib/modules usr/local/lib/systemd/system var/lib/mica; do \
        install -d -m 0755 "$S/$d"; \
    done; \
    install -d -m 0700 "$S/root"; \
    install -D -m 0644 /in/debs/copyright "$S/usr/share/doc/mica-system/copyright"; \
    bun /tooling/debs/pack-cli.ts --stage "$S" --control /in/debs/mica-system/control \
        --postinst /in/debs/mica-system/postinst --out /out
FROM scratch
COPY --from=pack /out/*.deb /
