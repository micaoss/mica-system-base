# mica-deb: arches=all inputs=tzdata
# mica-tzdata: the time zones as data. tzdata's postinst parses a date with GNU
# date, which the floor does not have -- busybox is its command set -- so the zones
# are taken out of the pinned tzdata archive and carried with no maintainer script.
# The control's version and its Provides name the pinned archive's; a moved pin
# fails here until both are updated with it.
ARG MICA_BUILD_IMAGE
FROM ${MICA_BUILD_IMAGE} AS pack
ARG MICA_DEB_ARCH
ARG MICA_DEB_SOURCE_REPO
ARG SOURCE_DATE_EPOCH
ARG MICA_INPUT_TZDATA
RUN --mount=type=bind,from=cache,target=/cache \
    --mount=type=bind,from=debs,target=/in/debs \
    --mount=type=bind,from=tooling,target=/tooling \
    set -eu; \
    deb="/cache/sha256/${MICA_INPUT_TZDATA}"; \
    [ "$(sha256sum "$deb" | cut -d' ' -f1)" = "${MICA_INPUT_TZDATA}" ] || { echo "error: $deb is not the pinned tzdata" >&2; exit 1; }; \
    version="$(dpkg-deb -f "$deb" Version)"; \
    declared="$(sed -n 's/^Version: //p' /in/debs/mica-tzdata/control)"; \
    [ "${declared%-mica*}" = "${version%-*}" ] || { echo "error: input.tzdata pins $version and debs/mica-tzdata/control declares $declared" >&2; exit 1; }; \
    grep -qx "Provides: tzdata (= ${version})" /in/debs/mica-tzdata/control || { echo "error: debs/mica-tzdata/control does not provide tzdata (= $version)" >&2; exit 1; }; \
    dpkg-deb -x "$deb" /tz; \
    [ -f /tz/usr/share/zoneinfo/UTC ] && [ -f /tz/usr/share/zoneinfo/Europe/Berlin ] || { echo 'error: the pinned tzdata carries no zoneinfo' >&2; exit 1; }; \
    install -d -m 0755 /stage/usr/share /stage/usr/share/doc/mica-tzdata; \
    cp -a /tz/usr/share/zoneinfo /stage/usr/share/; \
    { \
        echo 'Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/'; \
        echo 'Upstream-Name: mica-tzdata'; \
        echo "Comment: The payload of this package is /usr/share/zoneinfo of Debian's tzdata $version,"; \
        echo ' taken unmodified from the pinned archive (input.tzdata of locks/upstream.lock).'; \
        echo ' The part authored by Mica OS is the packaging and this file.'; \
        echo " Debian's own /usr/share/doc/tzdata/copyright is reproduced below, verbatim."; \
        echo ''; \
        echo '# --------------------------------------------------------------------------'; \
        echo '# Below: /usr/share/doc/tzdata/copyright, as shipped by the pinned tzdata.'; \
        echo '# --------------------------------------------------------------------------'; \
        echo ''; \
        cat /tz/usr/share/doc/tzdata/copyright; \
    } >/stage/usr/share/doc/mica-tzdata/copyright; \
    chmod 0644 /stage/usr/share/doc/mica-tzdata/copyright; \
    bun /tooling/src/cli.ts deb pack --arch "$MICA_DEB_ARCH" --root /stage --control /in/debs/mica-tzdata/control --out /out
FROM scratch
COPY --from=pack /out/*.deb /
