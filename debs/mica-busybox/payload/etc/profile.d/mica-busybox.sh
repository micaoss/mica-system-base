# Sourced by /etc/profile in every login shell, on a getty and over SSH alike.
# BusyBox's applets, one link each under /usr/libexec/busybox, are reached by plain
# name as a fallback: that directory goes last in PATH, so every command the root ships keeps its
# own binary. Services do not read this file; their PATH is unchanged.
case ":${PATH-}:" in
*:/usr/libexec/busybox:*) ;;
*) PATH="${PATH:+$PATH:}/usr/libexec/busybox" ;;
esac
export PATH
