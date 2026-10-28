# mica-deb: arches=amd64,arm64,armhf inputs=openssh-server,openssh-client
# mica-openssh: SSH as an option on the floor, in place of mica-ssh -- sshd,
# sshd-session and sshd-auth out of the pinned openssh-server and ssh-keygen out
# of the pinned openssh-client, mica-sshd.service, its prestart, the preset that
# keeps it disabled and the OpenRC script mica-sshd. The Debian packages are read
# here, not installed: they depend on debconf, ucf and systemd's sysusers, which
# no root carries. Their libraries are this package's Depends: the build refuses a
# binary that needs a library the control does not name. The control's version
# is the pinned openssh-server's; a moved pin fails here until it is updated with
# it.
ARG MICA_BUILD_IMAGE
FROM ${MICA_BUILD_IMAGE} AS pack
ARG MICA_DEB_ARCH
ARG MICA_DEB_SOURCE_REPO
ARG SOURCE_DATE_EPOCH
ARG MICA_INPUT_OPENSSH_SERVER
ARG MICA_INPUT_OPENSSH_CLIENT
COPY mica-sshd.service mica-sshd-prestart 50-mica-sshd.preset mica-sshd.openrc mica-sshd-boot.openrc /in/ssh/
COPY postinst /in/scripts/
RUN --mount=type=bind,from=cache,target=/cache \
    --mount=type=bind,from=debs,target=/in/debs \
    --mount=type=bind,from=tooling,target=/tooling \
    set -eu; \
    for input in "openssh-server ${MICA_INPUT_OPENSSH_SERVER}" "openssh-client ${MICA_INPUT_OPENSSH_CLIENT}"; do \
        set -- $input; \
        deb="/cache/sha256/$2"; \
        [ "$(sha256sum "$deb" | cut -d' ' -f1)" = "$2" ] || { echo "error: $deb is not the pinned $1" >&2; exit 1; }; \
        [ "$(dpkg-deb -f "$deb" Package):$(dpkg-deb -f "$deb" Architecture)" = "$1:${MICA_DEB_ARCH}" ] || { echo "error: $deb is not $1 for ${MICA_DEB_ARCH}" >&2; exit 1; }; \
        dpkg-deb -x "$deb" "/$1"; \
    done; \
    version="$(dpkg-deb -f "/cache/sha256/${MICA_INPUT_OPENSSH_SERVER}" Version)"; \
    upstream="${version#*:}"; upstream="${upstream%-*}"; \
    declared="$(sed -n 's/^Version: //p' /in/debs/mica-openssh/control)"; \
    [ "${declared%-mica*}" = "$upstream" ] || { echo "error: input.openssh-server pins $version and debs/mica-openssh/control declares $declared" >&2; exit 1; }; \
    install -D -m 0755 /openssh-server/usr/sbin/sshd /stage/usr/sbin/sshd; \
    install -D -m 0755 /openssh-server/usr/lib/openssh/sshd-session /stage/usr/lib/openssh/sshd-session; \
    install -D -m 0755 /openssh-server/usr/lib/openssh/sshd-auth /stage/usr/lib/openssh/sshd-auth; \
    install -D -m 0755 /openssh-client/usr/bin/ssh-keygen /stage/usr/bin/ssh-keygen; \
    depends="$(sed -n 's/^Depends: //p' /in/debs/mica-openssh/control)"; \
    for binary in /stage/usr/sbin/sshd /stage/usr/lib/openssh/sshd-session /stage/usr/lib/openssh/sshd-auth /stage/usr/bin/ssh-keygen; do \
        machine="$(od -An -tu2 -j18 -N2 "$binary" | tr -d ' ')"; \
        case "${MICA_DEB_ARCH}:${machine}" in amd64:62|arm64:183|armhf:40) ;; *) echo "error: $binary is ELF machine $machine, not ${MICA_DEB_ARCH}" >&2; exit 1 ;; esac; \
        for library in $(objdump -p "$binary" | sed -n 's/^ *NEEDED *//p'); do \
            case "$library" in \
            libc.so.6 | ld-linux-*) continue ;; \
            libaudit.so.1) package=libaudit1 ;; \
            libcom_err.so.2) package=libcom-err2 ;; \
            libcrypt.so.1) package=libcrypt1 ;; \
            libcrypto.so.3) package=libssl3t64 ;; \
            libgssapi_krb5.so.2) package=libgssapi-krb5-2 ;; \
            libkrb5.so.3) package=libkrb5-3 ;; \
            libpam.so.0) package=libpam0g ;; \
            libselinux.so.1) package=libselinux1 ;; \
            libwrap.so.0) package=libwrap0 ;; \
            libwtmpdb.so.0) package=libwtmpdb0 ;; \
            libz.so.1) package=zlib1g ;; \
            *) echo "error: $binary needs $library, which no Depends of debs/mica-openssh/control provides" >&2; exit 1 ;; \
            esac; \
            case ", $depends, " in *", $package, "*) ;; *) echo "error: $binary needs $library of $package, which debs/mica-openssh/control does not depend on" >&2; exit 1 ;; esac; \
        done; \
    done; \
    install -D -m 0644 /in/ssh/mica-sshd.service /stage/etc/systemd/system/mica-sshd.service; \
    install -D -m 0755 /in/ssh/mica-sshd-prestart /stage/usr/lib/mica/mica-sshd-prestart; \
    install -D -m 0755 /in/ssh/mica-sshd.openrc /stage/etc/init.d/mica-sshd; \
    install -D -m 0644 /in/ssh/50-mica-sshd.preset /stage/usr/lib/systemd/system-preset/50-mica-sshd.preset; \
    install -D -m 0755 /in/ssh/mica-sshd-boot.openrc /stage/etc/init.d/mica-sshd-boot; \
    install -d -m 0755 /stage/etc/systemd/system/multi-user.target.wants /stage/etc/runlevels/default; \
    ln -s /etc/systemd/system/mica-sshd.service /stage/etc/systemd/system/multi-user.target.wants/mica-sshd.service; \
    ln -s /etc/init.d/mica-sshd-boot /stage/etc/runlevels/default/mica-sshd-boot; \
    install -d -m 0755 /stage/usr/share/doc/mica-openssh; \
    { \
        echo 'Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/'; \
        echo 'Upstream-Name: mica-openssh'; \
        echo "Comment: /usr/sbin/sshd, /usr/lib/openssh/sshd-session and /usr/lib/openssh/sshd-auth are those of"; \
        echo " Debian's openssh-server $version, and /usr/bin/ssh-keygen that of its openssh-client, taken"; \
        echo ' unmodified from the pinned archives (input.openssh-server and input.openssh-client of'; \
        echo " locks/upstream.lock of https://github.com/micaoss/${MICA_DEB_SOURCE_REPO})."; \
        echo ' The part authored by Mica OS is the packaging, the unit, the OpenRC script, the prestart'; \
        echo ' and this file.'; \
        echo " Debian's own copyright of OpenSSH, /usr/share/doc/openssh-client/copyright, to which"; \
        echo ' openssh-server links its own, is reproduced below, verbatim.'; \
        echo ''; \
        echo '# --------------------------------------------------------------------------'; \
        echo '# Below: /usr/share/doc/openssh-client/copyright, as shipped by the pinned openssh-client.'; \
        echo '# --------------------------------------------------------------------------'; \
        echo ''; \
        cat /openssh-client/usr/share/doc/openssh-client/copyright; \
    } >/stage/usr/share/doc/mica-openssh/copyright; \
    chmod 0644 /stage/usr/share/doc/mica-openssh/copyright; \
    bun /tooling/src/cli.ts deb pack --arch "$MICA_DEB_ARCH" --root /stage --control /in/debs/mica-openssh/control --maintainer-scripts /in/scripts --out /out
FROM scratch
COPY --from=pack /out/*.deb /
