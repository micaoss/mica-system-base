# Sourced by /etc/profile. An interactive bash on a color terminal gets a colored
# user@host:cwd prompt (red for root) and color output from ls, grep and diff.
[ -n "${BASH_VERSION-}" ] && [ -n "${PS1-}" ] || return 0
case "${TERM-}" in
xterm* | screen* | tmux* | rxvt* | linux | *color*) ;;
*) return 0 ;;
esac

if [ "$(id -u)" -eq 0 ]; then _mica_user='1;31'; else _mica_user='1;32'; fi
PS1="\[\e[${_mica_user}m\]\u@\h\[\e[0m\]:\[\e[1;34m\]\w\[\e[0m\]\\$ "
unset _mica_user

# dircolors is GNU coreutils; without that option ls keeps its default colors.
! command -v dircolors >/dev/null || eval "$(dircolors -b)"
alias ls='ls --color=auto' grep='grep --color=auto' diff='diff --color=auto'
