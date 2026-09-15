# mica-deb: arches=amd64,arm64 build=gperf,libcap-dev,libmount-dev,meson,ninja-build,python3-jinja2,python3-pyelftools sources=systemd
# mica-systemd-boot: the systemd-boot EFI loader of the systemd release
# source.systemd of locks/upstream.lock, with persistence.patch: an entry whose
# attempts are exhausted is never selected, and a boot whose attempt counter
# cannot be written is refused. The source is fetched and checked natively,
# compiled in the build-env C image of the target architecture with the build
# tools pinned as build.mica-systemd-boot.* (emulated for a foreign one), and
# packed natively. Unsigned: the boot chain signs it.
ARG MICA_BUILD_IMAGE
ARG MICA_BUILD_C_IMAGE
ARG MICA_DEB_ARCH

FROM ${MICA_BUILD_IMAGE} AS source
ARG MICA_SOURCE_SYSTEMD_URL
ARG MICA_SOURCE_SYSTEMD_SHA256
RUN set -eu; \
    curl -fsSL --retry 3 -o /systemd.tar.gz "${MICA_SOURCE_SYSTEMD_URL}"; \
    echo "${MICA_SOURCE_SYSTEMD_SHA256}  /systemd.tar.gz" | sha256sum -c -; \
    mkdir /src; \
    tar -xzf /systemd.tar.gz -C /src --strip-components=1 --no-same-owner

FROM --platform=linux/${MICA_DEB_ARCH} ${MICA_BUILD_C_IMAGE} AS build
ARG MICA_DEB_ARCH
ARG MICA_BUILD_PINS
ARG MICA_SOURCE_SYSTEMD_VERSION
ARG SOURCE_DATE_EPOCH
COPY --from=source /src /src
COPY persistence.patch /persistence.patch
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
    case "${MICA_DEB_ARCH}" in amd64) efi=x64; machine=8664 ;; arm64) efi=aa64; machine=aa64 ;; *) exit 1 ;; esac; \
    cd /src; \
    patch -p1 --no-backup-if-mismatch </persistence.patch; \
    export SOURCE_DATE_EPOCH; \
    meson setup /build -Dmode=release -Dauto_features=disabled -Dbootloader=enabled \
        -Dman=disabled -Dhtml=disabled -Dtests=false -Dinstall-tests=false \
        -Dversion-tag="${MICA_SOURCE_SYSTEMD_VERSION}-mica1" -Dvcs-tag=false >/dev/null; \
    ninja -C /build "src/boot/systemd-boot${efi}.efi" >/dev/null; \
    loader="/build/src/boot/systemd-boot${efi}.efi"; \
    pe="$(od -An -tu4 -j60 -N4 "$loader" | tr -d ' ')"; \
    [ "$(od -An -tx2 -j$((pe + 4)) -N2 "$loader" | tr -d ' ')" = "$machine" ] || { echo "error: $loader is not a PE image for ${MICA_DEB_ARCH}" >&2; exit 1; }; \
    for text in 'Mica OS: deployment attempts exhausted' "systemd-boot ${MICA_SOURCE_SYSTEMD_VERSION}-mica1"; do \
        LC_ALL=C grep -a -c "$text" "$loader" >/dev/null || { echo "error: $loader does not carry '$text'" >&2; exit 1; }; \
    done; \
    mkdir /out; \
    cp "$loader" /out/

FROM ${MICA_BUILD_IMAGE} AS pack
ARG MICA_DEB_ARCH
ARG MICA_DEB_VERSION
ARG MICA_DEB_SOURCE_REPO
ARG MICA_DEB_SOURCE_COMMIT
ARG SOURCE_DATE_EPOCH
ARG MICA_SOURCE_SYSTEMD_VERSION
ARG MICA_SOURCE_SYSTEMD_URL
ARG MICA_SOURCE_SYSTEMD_SHA256
COPY --from=build /out/ /in/loader/
COPY --from=source /src/LICENSE.LGPL2.1 /in/LICENSE.LGPL2.1
RUN --mount=type=bind,from=debs,target=/in/debs \
    --mount=type=bind,from=tooling,target=/tooling \
    set -eu; \
    install -d -m 0755 /stage/usr/lib/mica/systemd-boot /stage/usr/share/doc/mica-systemd-boot; \
    install -m 0644 /in/loader/*.efi /stage/usr/lib/mica/systemd-boot/; \
    { \
        echo 'Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/'; \
        echo 'Upstream-Name: systemd'; \
        echo "Source: ${MICA_SOURCE_SYSTEMD_URL}"; \
        echo "Comment: The systemd-boot loader of systemd ${MICA_SOURCE_SYSTEMD_VERSION}, compiled from the release"; \
        echo ' archive above, sha256'; \
        echo " ${MICA_SOURCE_SYSTEMD_SHA256},"; \
        echo ' with debs/mica-systemd-boot/persistence.patch of'; \
        echo " https://github.com/micaoss/${MICA_DEB_SOURCE_REPO} at commit ${MICA_DEB_SOURCE_COMMIT}."; \
        echo ' That archive and that patch are its complete corresponding source.'; \
        echo ' The part authored by Mica OS is the patch, the packaging and this file.'; \
        echo ''; \
        echo 'Files: *'; \
        echo 'Copyright: the systemd authors'; \
        echo 'License: LGPL-2.1-or-later'; \
        echo ' The LICENSE.LGPL2.1 file of the release is reproduced below, verbatim.'; \
        echo ''; \
        echo '# --------------------------------------------------------------------------'; \
        echo "# Below: LICENSE.LGPL2.1 of systemd ${MICA_SOURCE_SYSTEMD_VERSION}. Reproduced verbatim."; \
        echo '# --------------------------------------------------------------------------'; \
        echo ''; \
        cat /in/LICENSE.LGPL2.1; \
    } >/stage/usr/share/doc/mica-systemd-boot/copyright; \
    chmod 0644 /stage/usr/share/doc/mica-systemd-boot/copyright; \
    bun /tooling/debs/pack-cli.ts --stage /stage --control /in/debs/mica-systemd-boot/control --out /out
FROM scratch
COPY --from=pack /out/*.deb /
