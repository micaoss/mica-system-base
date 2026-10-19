# mica-deb: arches=amd64,arm64,armhf sources=busybox
# mica-busybox: /usr/bin/busybox compiled from the upstream BusyBox release
# source.busybox of locks/upstream.lock, statically, over its `make defconfig`
# with the settings in config, and one link per applet under /usr/libexec/busybox, which payload/etc/profile.d puts last in a
# login shell's PATH. The source is fetched and checked natively, compiled in the build-env C
# image of MICA_BUILD_PLATFORM -- the target architecture's own (emulated for a foreign one), or amd64's with
# its arm-linux-gnueabihf cross toolchain for armhf -- and packed natively. Nothing built runs here: the applets
# are listed in busybox.links, which the build writes from the configuration, and named from it.
ARG MICA_BUILD_IMAGE
ARG MICA_BUILD_C_IMAGE
ARG MICA_BUILD_PLATFORM
ARG MICA_DEB_ARCH

FROM ${MICA_BUILD_IMAGE} AS source
ARG MICA_SOURCE_BUSYBOX_URL
ARG MICA_SOURCE_BUSYBOX_SHA256
RUN set -eu; \
    curl -fsSL --retry 3 -o /busybox.tar.bz2 "${MICA_SOURCE_BUSYBOX_URL}"; \
    echo "${MICA_SOURCE_BUSYBOX_SHA256}  /busybox.tar.bz2" | sha256sum -c -; \
    mkdir /src; \
    tar -xjf /busybox.tar.bz2 -C /src --strip-components=1 --no-same-owner

FROM --platform=${MICA_BUILD_PLATFORM} ${MICA_BUILD_C_IMAGE} AS build
ARG MICA_DEB_ARCH
ARG SOURCE_DATE_EPOCH
COPY --from=source /src /src
COPY config /config
RUN set -eu; \
    cd /src; \
    export SOURCE_DATE_EPOCH; \
    case "${MICA_DEB_ARCH}" in armhf) export CROSS_COMPILE=arm-linux-gnueabihf- ;; esac; \
    make -s defconfig >/dev/null; \
    grep -E '^(CONFIG_[A-Z0-9_]+=.*|# CONFIG_[A-Z0-9_]+ is not set)$' /config >/settings; \
    while IFS= read -r line; do \
        name="$(printf '%s\n' "$line" | grep -oE 'CONFIG_[A-Z0-9_]+')"; \
        sed -i -E "/^(${name}=.*|# ${name} is not set)$/d" .config; \
        printf '%s\n' "$line" >>.config; \
    done </settings; \
    yes '' | make -s oldconfig >/dev/null; \
    while IFS= read -r line; do \
        grep -qxF "$line" .config || { echo "error: make oldconfig did not keep '$line'" >&2; exit 1; }; \
    done </settings; \
    make -s -j"$(nproc)" busybox busybox.links; \
    machine="$(od -An -tu2 -j18 -N2 busybox | tr -d ' ')"; \
    case "${MICA_DEB_ARCH}:${machine}" in amd64:62|arm64:183|armhf:40) ;; *) echo "error: busybox is ELF machine $machine, not ${MICA_DEB_ARCH}" >&2; exit 1 ;; esac; \
    if [ "${MICA_DEB_ARCH}" = armhf ] && ! readelf -h busybox | grep 'hard-float ABI' >/dev/null; then echo 'error: busybox is not hard-float EABI' >&2; exit 1; fi; \
    if readelf -l busybox | grep 'program interpreter' >/dev/null; then echo 'error: busybox is not statically linked' >&2; exit 1; fi; \
    applets="$(grep -c . busybox.links)"; \
    [ "$applets" -ge 100 ] || { echo "error: busybox lists only $applets applets" >&2; exit 1; }

FROM ${MICA_BUILD_IMAGE} AS pack
ARG MICA_DEB_ARCH
ARG MICA_DEB_SOURCE_REPO
ARG SOURCE_DATE_EPOCH
ARG MICA_SOURCE_BUSYBOX_VERSION
ARG MICA_SOURCE_BUSYBOX_URL
ARG MICA_SOURCE_BUSYBOX_SHA256
COPY --from=build /src/busybox /src/busybox.links /src/LICENSE /in/busybox/
RUN --mount=type=bind,from=debs,target=/in/debs \
    --mount=type=bind,from=tooling,target=/tooling \
    set -eu; \
    install -D -m 0755 /in/busybox/busybox /stage/usr/bin/busybox; \
    install -d -m 0755 /stage/usr/libexec/busybox; \
    for applet in $(sed 's|.*/||' /in/busybox/busybox.links | sort -u); do \
        ln -s /usr/bin/busybox "/stage/usr/libexec/busybox/$applet"; \
    done; \
    [ "$(ls /stage/usr/libexec/busybox | wc -l)" = "$(grep -c . /in/busybox/busybox.links)" ] || { echo 'error: busybox.links names an applet twice' >&2; exit 1; }; \
    cp -a /in/debs/mica-busybox/payload/. /stage/; \
    install -d -m 0755 /stage/usr/share/doc/mica-busybox; \
    { \
        echo 'Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/'; \
        echo 'Upstream-Name: BusyBox'; \
        echo "Source: ${MICA_SOURCE_BUSYBOX_URL}"; \
        echo "Comment: /usr/bin/busybox is BusyBox ${MICA_SOURCE_BUSYBOX_VERSION}, compiled unmodified from the"; \
        echo ' release archive above, sha256'; \
        echo " ${MICA_SOURCE_BUSYBOX_SHA256},"; \
        echo ' statically, over its make defconfig with the settings in'; \
        echo " debs/mica-busybox/config of https://github.com/micaoss/${MICA_DEB_SOURCE_REPO},"; \
        echo " sha256 $(sha256sum /in/debs/mica-busybox/config | cut -d' ' -f1)."; \
        echo ' That archive and that configuration are its complete corresponding source.'; \
        echo ' The part authored by Mica OS is the packaging and this file.'; \
        echo ''; \
        echo 'Files: *'; \
        echo 'Copyright: the BusyBox authors'; \
        echo 'License: GPL-2'; \
        echo ' The LICENSE file of the release is reproduced below, verbatim.'; \
        echo ''; \
        echo '# --------------------------------------------------------------------------'; \
        echo "# Below: LICENSE of busybox-${MICA_SOURCE_BUSYBOX_VERSION}. Reproduced verbatim."; \
        echo '# --------------------------------------------------------------------------'; \
        echo ''; \
        cat /in/busybox/LICENSE; \
    } >/stage/usr/share/doc/mica-busybox/copyright; \
    chmod 0644 /stage/usr/share/doc/mica-busybox/copyright; \
    bun /tooling/src/cli.ts deb pack --arch "$MICA_DEB_ARCH" --root /stage --control /in/debs/mica-busybox/control --out /out
FROM scratch
COPY --from=pack /out/*.deb /
