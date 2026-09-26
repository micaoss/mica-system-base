# mica-deb: arches=amd64,arm64 build=libnl-3-dev,libnl-genl-3-dev,libssl-dev,pkg-config sources=wpa-supplicant
# mica-wifi: wpa_supplicant and wpa_cli compiled from the upstream hostap release
# source.wpa-supplicant of locks/upstream.lock with config as the whole .config:
# nl80211 only, the root's libnl-3, libnl-genl-3 and libcrypto, and nothing else.
# With them, wpa_supplicant@.service rendered by the release's Makefile, the STATE
# bind of /etc/wpa_supplicant and the regulatory database reload. The source is
# fetched and checked natively, compiled in the build-env C image of the target
# architecture with the build tools pinned as build.mica-wifi.* (emulated for a
# foreign one), and packed natively.
ARG MICA_BUILD_IMAGE
ARG MICA_BUILD_C_IMAGE
ARG MICA_DEB_ARCH

FROM ${MICA_BUILD_IMAGE} AS source
ARG MICA_SOURCE_WPA_SUPPLICANT_URL
ARG MICA_SOURCE_WPA_SUPPLICANT_SHA256
RUN set -eu; \
    curl -fsSL --retry 3 -o /wpa_supplicant.tar.gz "${MICA_SOURCE_WPA_SUPPLICANT_URL}"; \
    echo "${MICA_SOURCE_WPA_SUPPLICANT_SHA256}  /wpa_supplicant.tar.gz" | sha256sum -c -; \
    mkdir /src; \
    tar -xzf /wpa_supplicant.tar.gz -C /src --strip-components=1 --no-same-owner

# The binaries may load libc, libcrypto and the two libnl libraries the root
# already has, and nothing else: no libnl-route, D-Bus, PC/SC or readline.
FROM --platform=linux/${MICA_DEB_ARCH} ${MICA_BUILD_C_IMAGE} AS build
ARG MICA_DEB_ARCH
ARG MICA_BUILD_PINS
ARG MICA_SOURCE_WPA_SUPPLICANT_VERSION
ARG SOURCE_DATE_EPOCH
COPY --from=source /src /src
COPY config /src/wpa_supplicant/.config
RUN --mount=type=bind,from=cache,target=/cache \
    set -eu; \
    [ -n "${MICA_BUILD_PINS}" ] || { echo 'error: no build packages were passed' >&2; exit 1; }; \
    set --; \
    for sha in ${MICA_BUILD_PINS}; do \
        deb="/cache/sha256/${sha}"; \
        [ "$(sha256sum "$deb" | cut -d' ' -f1)" = "$sha" ] || { echo "error: $deb is not the pinned build package" >&2; exit 1; }; \
        set -- "$@" "$deb"; \
    done; \
    DEBIAN_FRONTEND=noninteractive dpkg -i "$@" >/dev/null; \
    cd /src/wpa_supplicant; \
    export SOURCE_DATE_EPOCH; \
    make -s -j"$(nproc)" wpa_supplicant wpa_cli; \
    make -s BINDIR=/usr/sbin systemd/wpa_supplicant@.service; \
    strip wpa_supplicant wpa_cli; \
    for bin in wpa_supplicant wpa_cli; do \
        machine="$(od -An -tu2 -j18 -N2 "$bin" | tr -d ' ')"; \
        case "${MICA_DEB_ARCH}:${machine}" in amd64:62|arm64:183) ;; *) echo "error: $bin is ELF machine $machine, not ${MICA_DEB_ARCH}" >&2; exit 1 ;; esac; \
        for lib in $(readelf -d "$bin" | sed -n 's/.*(NEEDED).*\[\(.*\)\]$/\1/p'); do \
            case "$lib" in libc.so.6 | libcrypto.so.3 | libnl-3.so.200 | libnl-genl-3.so.200) ;; *) echo "error: $bin loads $lib" >&2; exit 1 ;; esac; \
        done; \
    done; \
    version="$(./wpa_supplicant -v 2>&1 || true)"; \
    case "$version" in *"wpa_supplicant v${MICA_SOURCE_WPA_SUPPLICANT_VERSION}"*) ;; *) echo "error: wpa_supplicant -v says: $version" >&2; exit 1 ;; esac; \
    grep -qx 'ExecStart=/usr/sbin/wpa_supplicant -c/etc/wpa_supplicant/wpa_supplicant-%I.conf -i%I' systemd/wpa_supplicant@.service \
        || { echo 'error: wpa_supplicant@.service does not start /usr/sbin/wpa_supplicant on wpa_supplicant-%I.conf' >&2; exit 1; }; \
    mkdir /out; \
    cp wpa_supplicant wpa_cli systemd/wpa_supplicant@.service /out/

FROM ${MICA_BUILD_IMAGE} AS pack
ARG MICA_DEB_ARCH
ARG MICA_DEB_SOURCE_REPO
ARG SOURCE_DATE_EPOCH
ARG MICA_SOURCE_WPA_SUPPLICANT_VERSION
ARG MICA_SOURCE_WPA_SUPPLICANT_URL
ARG MICA_SOURCE_WPA_SUPPLICANT_SHA256
COPY --from=build /out/ /in/build/
COPY --from=source /src/COPYING /src/README /in/license/
COPY etc-wpa_supplicant.mount mica-regdb-reload.service /in/units/
RUN --mount=type=bind,from=debs,target=/in/debs \
    --mount=type=bind,from=tooling,target=/tooling \
    set -eu; \
    install -D -m 0755 /in/build/wpa_supplicant /stage/usr/sbin/wpa_supplicant; \
    install -m 0755 /in/build/wpa_cli /stage/usr/sbin/wpa_cli; \
    install -D -m 0644 /in/build/wpa_supplicant@.service /stage/usr/lib/systemd/system/wpa_supplicant@.service; \
    install -d -m 0755 /stage/etc/systemd/system/local-fs.target.wants /stage/etc/systemd/system/multi-user.target.wants; \
    install -m 0644 /in/units/etc-wpa_supplicant.mount /in/units/mica-regdb-reload.service /stage/etc/systemd/system/; \
    ln -s /etc/systemd/system/etc-wpa_supplicant.mount /stage/etc/systemd/system/local-fs.target.wants/etc-wpa_supplicant.mount; \
    ln -s /etc/systemd/system/mica-regdb-reload.service /stage/etc/systemd/system/multi-user.target.wants/mica-regdb-reload.service; \
    license="$(sed -n '/^License$/,/SUCH DAMAGE\.$/p' /in/license/README)"; \
    case "$license" in *'Redistribution and use in source and binary forms'*) ;; *) echo 'error: the release README has no BSD license section' >&2; exit 1 ;; esac; \
    install -d -m 0755 /stage/usr/share/doc/mica-wifi; \
    { \
        echo 'Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/'; \
        echo 'Upstream-Name: wpa_supplicant'; \
        echo "Source: ${MICA_SOURCE_WPA_SUPPLICANT_URL}"; \
        echo "Comment: /usr/sbin/wpa_supplicant and /usr/sbin/wpa_cli are wpa_supplicant ${MICA_SOURCE_WPA_SUPPLICANT_VERSION}, compiled"; \
        echo ' unmodified from the release archive above, sha256'; \
        echo " ${MICA_SOURCE_WPA_SUPPLICANT_SHA256},"; \
        echo ' with debs/mica-wifi/config of'; \
        echo " https://github.com/micaoss/${MICA_DEB_SOURCE_REPO}, sha256 $(sha256sum /in/debs/mica-wifi/config | cut -d' ' -f1),"; \
        echo ' as its build configuration; wpa_supplicant@.service is rendered by the'; \
        echo ' release Makefile. That archive and that configuration are its complete'; \
        echo ' corresponding source. The part authored by Mica OS is the packaging, the'; \
        echo ' mount and reload units and this file.'; \
        echo ''; \
        echo 'Files: *'; \
        echo 'Copyright: Jouni Malinen <j@w1.fi> and contributors'; \
        echo 'License: BSD-3-clause'; \
        echo ' The COPYING file and the License section of the README of the release are'; \
        echo ' reproduced below, verbatim.'; \
        echo ''; \
        echo '# --------------------------------------------------------------------------'; \
        echo "# Below: COPYING of wpa_supplicant-${MICA_SOURCE_WPA_SUPPLICANT_VERSION}. Reproduced verbatim."; \
        echo '# --------------------------------------------------------------------------'; \
        echo ''; \
        cat /in/license/COPYING; \
        echo ''; \
        echo '# --------------------------------------------------------------------------'; \
        echo "# Below: the License section of README of wpa_supplicant-${MICA_SOURCE_WPA_SUPPLICANT_VERSION}. Reproduced verbatim."; \
        echo '# --------------------------------------------------------------------------'; \
        echo ''; \
        printf '%s\n' "$license"; \
    } >/stage/usr/share/doc/mica-wifi/copyright; \
    chmod 0644 /stage/usr/share/doc/mica-wifi/copyright; \
    bun /tooling/src/cli.ts deb pack --arch "$MICA_DEB_ARCH" --root /stage --control /in/debs/mica-wifi/control --out /out
FROM scratch
COPY --from=pack /out/*.deb /
