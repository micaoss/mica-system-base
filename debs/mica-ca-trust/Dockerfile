# mica-deb: arches=all inputs=ca-certificates
# mica-ca-trust: the trust store as data. The pinned ca-certificates is installed
# into this throwaway stage so its own postinst generates the store, and only the
# generated files are taken: openssl, c_rehash and update-ca-certificates are the
# tooling that makes the store and never reach the image. recorded.env is the
# review surface: an anchor set that moves fails here by name.
ARG MICA_BUILD_IMAGE
FROM ${MICA_BUILD_IMAGE} AS pack
ARG MICA_DEB_ARCH
ARG MICA_DEB_SOURCE_REPO
ARG SOURCE_DATE_EPOCH
ARG MICA_INPUT_CA_CERTIFICATES
RUN --mount=type=bind,from=cache,target=/cache \
    --mount=type=bind,from=debs,target=/in/debs \
    --mount=type=bind,from=tooling,target=/tooling \
    set -eu; \
    deb="/cache/debs/${MICA_INPUT_CA_CERTIFICATES}.deb"; \
    [ "$(sha256sum "$deb" | cut -d' ' -f1)" = "${MICA_INPUT_CA_CERTIFICATES}" ] || { echo "error: $deb is not the pinned ca-certificates" >&2; exit 1; }; \
    . /in/debs/mica-ca-trust/recorded.env; \
    [ -n "${CA_CERTIFICATES_VERSION:-}" ] && [ -n "${CA_CERTIFICATES_ANCHORS_SHA256:-}" ] || { echo "error: recorded.env declares no version or anchor digest" >&2; exit 1; }; \
    version="$(dpkg-deb -f "$deb" Version)"; \
    [ "$version" = "$CA_CERTIFICATES_VERSION" ] || { echo "error: input.ca-certificates of locks/upstream.lock pins $version and recorded.env records $CA_CERTIFICATES_VERSION; re-record both in one commit if the trust store is meant to move" >&2; exit 1; }; \
    [ -z "$(ls -A /usr/local/share/ca-certificates 2>/dev/null)" ] || { echo "error: the build image carries local certificates that would enter the store" >&2; exit 1; }; \
    DEBIAN_FRONTEND=noninteractive dpkg --purge --force-depends ca-certificates >/dev/null; \
    DEBIAN_FRONTEND=noninteractive dpkg --install --force-depends "$deb" >/dev/null; \
    digest="$(find /usr/share/ca-certificates -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum | sha256sum | cut -d' ' -f1)"; \
    [ "$digest" = "$CA_CERTIFICATES_ANCHORS_SHA256" ] || { echo "error: the trust store moved: the anchors of ca-certificates $version hash to $digest, recorded $CA_CERTIFICATES_ANCHORS_SHA256" >&2; exit 1; }; \
    mkdir -p /stage/usr/share /stage/etc/ssl; \
    cp -a /usr/share/ca-certificates /stage/usr/share/; \
    cp -a /etc/ssl/certs /stage/etc/ssl/; \
    install -m 0644 /etc/ca-certificates.conf /stage/etc/ca-certificates.conf; \
    certs="$(grep -c 'BEGIN CERTIFICATE' /stage/etc/ssl/certs/ca-certificates.crt)"; \
    [ "$certs" -ge 100 ] || { echo "error: the generated bundle holds $certs certificates" >&2; exit 1; }; \
    links="$(find /stage -type l | wc -l)"; \
    [ "$links" -ge 100 ] || { echo "error: the hash farm has $links symlinks; they were dereferenced" >&2; exit 1; }; \
    find /stage -type l -printf '%p\t%l\n' | while IFS="$(printf '\t')" read -r link target; do \
        case "$target" in /*) resolved="/stage$target" ;; *) resolved="$(dirname "$link")/$target" ;; esac; \
        [ -e "$resolved" ] || { echo "error: $link -> $target dangles in the payload" >&2; exit 1; }; \
    done; \
    tooling="$(find /stage \( -name openssl -o -name c_rehash -o -name 'update-ca-certificates*' \) -print)"; \
    [ -z "$tooling" ] || { echo "error: the payload carries ca-certificates tooling: $tooling" >&2; exit 1; }; \
    install -d -m 0755 /stage/usr/share/doc/mica-ca-trust; \
    { \
        echo 'Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/'; \
        echo 'Upstream-Name: mica-ca-trust'; \
        echo 'Comment: The payload of this package is not authored by Mica OS. It is the output of'; \
        echo " Debian's ca-certificates package -- the trust anchors, the hash farm that"; \
        echo ' indexes them and the configuration listing them -- generated from the pinned'; \
        echo ' ca-certificates archive (input.ca-certificates of locks/upstream.lock) at build time.'; \
        echo ' The part authored by Mica OS is the packaging and this file, so the Apache-2.0'; \
        echo ' paragraph below is scoped to this doc directory rather than written over the'; \
        echo ' certificates.'; \
        echo ' .'; \
        echo " Debian's own /usr/share/doc/ca-certificates/copyright is reproduced below,"; \
        echo ' verbatim and unedited, harvested during the build. This file is therefore a'; \
        echo ' concatenation and carries a second Format: header: the reproduction is a whole'; \
        echo ' machine-readable file, and truncating it into stanzas of this one would be'; \
        echo ' editing a licence record to make a format check pass. Its Files: paths are'; \
        echo " ca-certificates' own SOURCE paths, exactly as Debian wrote them; they do not"; \
        echo ' describe the layout installed here.'; \
        echo ' .'; \
        echo ' One reference in it dangles on the device: its GPL-2+ paragraph points at'; \
        echo ' /usr/share/common-licenses/GPL-2, and the Mica OS image does not ship that'; \
        echo ' directory. It is left as Debian wrote it. Rewriting the text of a licence so'; \
        echo ' that a pointer resolves is the one edit that must not be made quietly, and the'; \
        echo ' full MPL-2.0 and GPL-2+ terms are carried below in any case.'; \
        echo ''; \
        echo 'Files: usr/share/doc/mica-ca-trust/*'; \
        echo 'Copyright: Mica OS'; \
        echo 'License: Apache-2.0'; \
        echo ''; \
        awk '/^License: Apache-2\.0$/ { last = NR } { l[NR] = $0 } END { for (i = last; i <= NR; i++) print l[i] }' /in/debs/copyright; \
        echo ''; \
        echo '# --------------------------------------------------------------------------'; \
        echo '# Below: /usr/share/doc/ca-certificates/copyright, as shipped by the pinned'; \
        echo '# ca-certificates archive these anchors were generated from. Reproduced'; \
        echo '# verbatim.'; \
        echo '# --------------------------------------------------------------------------'; \
        echo ''; \
        cat /usr/share/doc/ca-certificates/copyright; \
    } >/stage/usr/share/doc/mica-ca-trust/copyright; \
    chmod 0644 /stage/usr/share/doc/mica-ca-trust/copyright; \
    echo "mica-ca-trust: $certs certificates, $links hash links, anchors at the recorded sha256"; \
    bun /tooling/debs/pack-cli.ts --stage /stage --control /in/debs/mica-ca-trust/control --out /out
FROM scratch
COPY --from=pack /out/*.deb /
