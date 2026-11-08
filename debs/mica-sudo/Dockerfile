# mica-deb: arches=all
# mica-sudo: debs/mica-sudo/payload and the copyright, sudo in Depends. Built by
# `bun src/container.ts debs` with the named contexts `debs` and `tooling` (the
# pinned mica-build-tools checkout).
ARG MICA_BUILD_IMAGE
FROM ${MICA_BUILD_IMAGE} AS pack
ARG MICA_DEB_ARCH
ARG MICA_DEB_SOURCE_REPO
ARG SOURCE_DATE_EPOCH
# The sudoers drop-in at the mode sudo asks of it, 0440, whatever the checkout's umask.
RUN --mount=type=bind,from=debs,target=/in/debs \
    --mount=type=bind,from=tooling,target=/tooling \
    set -eu; \
    S=/stage; \
    install -D -m 0440 /in/debs/mica-sudo/payload/etc/sudoers.d/mica-admins "$S/etc/sudoers.d/mica-admins"; \
    chmod 0755 "$S/etc" "$S/etc/sudoers.d"; \
    install -D -m 0644 /in/debs/copyright "$S/usr/share/doc/mica-sudo/copyright"; \
    bun /tooling/src/cli.ts deb pack --arch "$MICA_DEB_ARCH" --root "$S" --control /in/debs/mica-sudo/control --out /out
FROM scratch
COPY --from=pack /out/*.deb /
