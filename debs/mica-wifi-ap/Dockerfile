# mica-deb: arches=amd64,arm64 build=libnl-3-dev,libnl-genl-3-dev,libssl-dev,pkg-config sources=hostapd
# mica-wifi-ap: hostapd and hostapd_cli compiled from the upstream hostap release
# source.hostapd of locks/upstream.lock with config as the whole .config: nl80211
# only, the root's libnl-3, libnl-genl-3 and libcrypto, and nothing else. With
# them, hostapd@.service and the STATE bind of /etc/hostapd. The source is fetched
# and checked natively, compiled in the build-env C image of the target
# architecture with the build tools pinned as build.mica-wifi-ap.* (emulated for a
# foreign one), and packed natively.
ARG MICA_BUILD_IMAGE
ARG MICA_BUILD_C_IMAGE
ARG MICA_DEB_ARCH

FROM ${MICA_BUILD_IMAGE} AS source
ARG MICA_SOURCE_HOSTAPD_URL
ARG MICA_SOURCE_HOSTAPD_SHA256
RUN set -eu; \
    curl -fsSL --retry 3 -o /hostapd.tar.gz "${MICA_SOURCE_HOSTAPD_URL}"; \
    echo "${MICA_SOURCE_HOSTAPD_SHA256}  /hostapd.tar.gz" | sha256sum -c -; \
    mkdir /src; \
    tar -xzf /hostapd.tar.gz -C /src --strip-components=1 --no-same-owner

# The binaries may load libc, libcrypto and the two libnl libraries the root
# already has, and nothing else: no libnl-route, D-Bus, PC/SC or readline.
FROM --platform=linux/${MICA_DEB_ARCH} ${MICA_BUILD_C_IMAGE} AS build
ARG MICA_DEB_ARCH
ARG MICA_BUILD_PINS
ARG MICA_SOURCE_HOSTAPD_VERSION
ARG SOURCE_DATE_EPOCH
COPY --from=source /src /src
COPY config /src/hostapd/.config
RUN --mount=type=bind,from=cache,target=/cache \
    set -eu; \
    [ -n "${MICA_BUILD_PINS}" ] || { echo 'error: no build packages were passed' >&2; exit 1; }; \
    set --; \
    for sha in ${MICA_BUILD_PINS}; do \
        deb="/cache/debs/${sha}.deb"; \
        [ "$(sha256sum "$deb" | cut -d' ' -f1)" = "$sha" ] || { echo "error: $deb is not the pinned build package" >&2; exit 1; }; \
        set -- "$@" "$deb"; \
    done; \
    DEBIAN_FRONTEND=noninteractive dpkg -i "$@" >/dev/null; \
    cd /src/hostapd; \
    export SOURCE_DATE_EPOCH; \
    make -s -j"$(nproc)" hostapd hostapd_cli; \
    strip hostapd hostapd_cli; \
    for bin in hostapd hostapd_cli; do \
        machine="$(od -An -tu2 -j18 -N2 "$bin" | tr -d ' ')"; \
        case "${MICA_DEB_ARCH}:${machine}" in amd64:62|arm64:183) ;; *) echo "error: $bin is ELF machine $machine, not ${MICA_DEB_ARCH}" >&2; exit 1 ;; esac; \
        for lib in $(readelf -d "$bin" | sed -n 's/.*(NEEDED).*\[\(.*\)\]$/\1/p'); do \
            case "$lib" in libc.so.6 | libcrypto.so.3 | libnl-3.so.200 | libnl-genl-3.so.200) ;; *) echo "error: $bin loads $lib" >&2; exit 1 ;; esac; \
        done; \
    done; \
    version="$(./hostapd -v 2>&1 || true)"; \
    case "$version" in *"hostapd v${MICA_SOURCE_HOSTAPD_VERSION}"*) ;; *) echo "error: hostapd -v says: $version" >&2; exit 1 ;; esac; \
    mkdir /out; \
    cp hostapd hostapd_cli /out/

FROM ${MICA_BUILD_IMAGE} AS pack
ARG MICA_DEB_ARCH
ARG MICA_DEB_SOURCE_REPO
ARG SOURCE_DATE_EPOCH
ARG MICA_SOURCE_HOSTAPD_VERSION
ARG MICA_SOURCE_HOSTAPD_URL
ARG MICA_SOURCE_HOSTAPD_SHA256
COPY --from=build /out/ /in/build/
COPY --from=source /src/COPYING /src/README /in/license/
COPY hostapd@.service etc-hostapd.mount /in/units/
RUN --mount=type=bind,from=debs,target=/in/debs \
    --mount=type=bind,from=tooling,target=/tooling \
    set -eu; \
    install -D -m 0755 /in/build/hostapd /stage/usr/sbin/hostapd; \
    install -m 0755 /in/build/hostapd_cli /stage/usr/sbin/hostapd_cli; \
    install -D -m 0644 /in/units/hostapd@.service /stage/usr/lib/systemd/system/hostapd@.service; \
    install -d -m 0755 /stage/etc/systemd/system/local-fs.target.wants; \
    install -m 0644 /in/units/etc-hostapd.mount /stage/etc/systemd/system/; \
    ln -s /etc/systemd/system/etc-hostapd.mount /stage/etc/systemd/system/local-fs.target.wants/etc-hostapd.mount; \
    license="$(sed -n '/^License$/,/SUCH DAMAGE\.$/p' /in/license/README)"; \
    case "$license" in *'Redistribution and use in source and binary forms'*) ;; *) echo 'error: the release README has no BSD license section' >&2; exit 1 ;; esac; \
    install -d -m 0755 /stage/usr/share/doc/mica-wifi-ap; \
    { \
        echo 'Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/'; \
        echo 'Upstream-Name: hostapd'; \
        echo "Source: ${MICA_SOURCE_HOSTAPD_URL}"; \
        echo "Comment: /usr/sbin/hostapd and /usr/sbin/hostapd_cli are hostapd ${MICA_SOURCE_HOSTAPD_VERSION}, compiled"; \
        echo ' unmodified from the release archive above, sha256'; \
        echo " ${MICA_SOURCE_HOSTAPD_SHA256},"; \
        echo ' with debs/mica-wifi-ap/config of'; \
        echo " https://github.com/micaoss/${MICA_DEB_SOURCE_REPO}, sha256 $(sha256sum /in/debs/mica-wifi-ap/config | cut -d' ' -f1),"; \
        echo ' as its build configuration. That archive and that configuration are its'; \
        echo ' complete corresponding source. The part authored by Mica OS is the'; \
        echo ' packaging, the units and this file.'; \
        echo ''; \
        echo 'Files: *'; \
        echo 'Copyright: Jouni Malinen <j@w1.fi> and contributors'; \
        echo 'License: BSD-3-clause'; \
        echo ' The COPYING file and the License section of the README of the release are'; \
        echo ' reproduced below, verbatim.'; \
        echo ''; \
        echo '# --------------------------------------------------------------------------'; \
        echo "# Below: COPYING of hostapd-${MICA_SOURCE_HOSTAPD_VERSION}. Reproduced verbatim."; \
        echo '# --------------------------------------------------------------------------'; \
        echo ''; \
        cat /in/license/COPYING; \
        echo ''; \
        echo '# --------------------------------------------------------------------------'; \
        echo "# Below: the License section of README of hostapd-${MICA_SOURCE_HOSTAPD_VERSION}. Reproduced verbatim."; \
        echo '# --------------------------------------------------------------------------'; \
        echo ''; \
        printf '%s\n' "$license"; \
    } >/stage/usr/share/doc/mica-wifi-ap/copyright; \
    chmod 0644 /stage/usr/share/doc/mica-wifi-ap/copyright; \
    bun /tooling/debs/pack-cli.ts --stage /stage --control /in/debs/mica-wifi-ap/control --out /out
FROM scratch
COPY --from=pack /out/*.deb /
