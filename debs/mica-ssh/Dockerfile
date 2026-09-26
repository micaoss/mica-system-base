# mica-deb: arches=all inputs=dropbear-bin
# mica-ssh: SSH as an option on the floor -- dropbear.service, its prestart and
# the preset that keeps it disabled, with dropbear-bin in Depends. The pinned
# dropbear-bin is read here, not installed: dropbear authenticates through crypt(3)
# against /etc/shadow, and a dropbear-bin that depends on PAM, or whose binary names
# libpam, would move every device onto the PAM stack silently, so the build
# refuses both. The Depends half and the binary half are separate checks: the
# binary is the one that still fails when libpam merely appears in a build image.
ARG MICA_BUILD_IMAGE
FROM ${MICA_BUILD_IMAGE} AS pack
ARG MICA_DEB_ARCH
ARG MICA_DEB_SOURCE_REPO
ARG SOURCE_DATE_EPOCH
ARG MICA_INPUT_DROPBEAR_BIN
COPY dropbear.service mica-dropbear-prestart 50-mica-dropbear.preset /in/ssh/
COPY postinst /in/scripts/
RUN --mount=type=bind,from=cache,target=/cache \
    --mount=type=bind,from=debs,target=/in/debs \
    --mount=type=bind,from=tooling,target=/tooling \
    set -eu; \
    deb="/cache/sha256/${MICA_INPUT_DROPBEAR_BIN}"; \
    [ "$(sha256sum "$deb" | cut -d' ' -f1)" = "${MICA_INPUT_DROPBEAR_BIN}" ] || { echo "error: $deb is not the pinned dropbear-bin" >&2; exit 1; }; \
    depends="$(dpkg-deb -f "$deb" Depends)"; \
    case "$depends" in *libpam*) echo "error: dropbear-bin depends on PAM: $depends. SSH authenticates through crypt(3) against /etc/shadow, and this would move every device onto the PAM stack" >&2; exit 1 ;; esac; \
    dpkg-deb -x "$deb" /dropbear; \
    [ -f /dropbear/usr/sbin/dropbear ] || { echo 'error: the pinned dropbear-bin has no /usr/sbin/dropbear' >&2; exit 1; }; \
    if grep -q libpam /dropbear/usr/sbin/dropbear; then echo 'error: /usr/sbin/dropbear names libpam: it was built against PAM, and SSH is the only route into a fielded device' >&2; exit 1; fi; \
    install -D -m 0644 /in/ssh/dropbear.service /stage/etc/systemd/system/dropbear.service; \
    install -D -m 0755 /in/ssh/mica-dropbear-prestart /stage/usr/lib/mica/mica-dropbear-prestart; \
    install -D -m 0644 /in/ssh/50-mica-dropbear.preset /stage/usr/lib/systemd/system-preset/50-mica-dropbear.preset; \
    install -D -m 0644 /in/debs/copyright /stage/usr/share/doc/mica-ssh/copyright; \
    bun /tooling/src/cli.ts deb pack --arch "$MICA_DEB_ARCH" --root /stage --control /in/debs/mica-ssh/control --maintainer-scripts /in/scripts --out /out
FROM scratch
COPY --from=pack /out/*.deb /
