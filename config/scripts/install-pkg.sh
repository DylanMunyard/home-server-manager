#!/usr/bin/env bash

# install-pkg — install a package on a target Linux/macOS host
#
# Detects the system package manager (or honours $MANAGER) and installs $PKG
# non-interactively, using sudo automatically when not run as root. Skips the
# work if the package's command is already on PATH.
#
# params:
#   PKG:     { label: Package to install (e.g. jq or htop), required: true }
#   MANAGER: { label: Force a package manager, default: auto, choices: [auto, apt, dnf, yum, apk, pacman, zypper, brew] }

set -euo pipefail

# 1. Already present? (best-effort: most packages expose a command of the same name)
if command -v "$PKG" >/dev/null 2>&1; then
    echo "$PKG is already installed: $(command -v "$PKG")"
    exit 0
fi

echo "$PKG is not installed. Installing (manager: $MANAGER)..."

# 2. Helper to use sudo if not root
run_cmd() {
    if [ "$(id -u)" -eq 0 ]; then
        "$@"
    elif command -v sudo >/dev/null 2>&1; then
        sudo "$@"
    else
        echo "Error: Root privileges required, but sudo is not available."
        exit 1
    fi
}

# 3. Resolve the manager — 'auto' picks the first one found on the host.
mgr="$MANAGER"
if [ "$mgr" = "auto" ]; then
    for m in apt-get dnf yum apk pacman zypper brew; do
        if command -v "$m" >/dev/null 2>&1; then mgr="$m"; break; fi
    done
    # normalise apt-get → apt label
    [ "$mgr" = "apt-get" ] && mgr="apt"
fi
[ "$mgr" = "auto" ] && { echo "Error: could not detect a package manager. Set MANAGER explicitly."; exit 1; }

# 4. Install via the chosen manager
case "$mgr" in
    apt)    run_cmd apt-get update -yqq; run_cmd apt-get install -yqq "$PKG" ;;
    dnf)    run_cmd dnf install -y "$PKG" ;;
    yum)    run_cmd yum install -y "$PKG" ;;
    apk)    run_cmd apk add --quiet --no-cache "$PKG" ;;
    pacman) run_cmd pacman -Sy --noconfirm "$PKG" ;;
    zypper) run_cmd zypper install -y "$PKG" ;;
    brew)   brew install "$PKG" ;;  # brew should not run under sudo
    *)      echo "Error: unsupported manager '$mgr'."; exit 1 ;;
esac

# 5. Verify
if command -v "$PKG" >/dev/null 2>&1; then
    echo "Successfully installed $PKG: $(command -v "$PKG")"
else
    echo "Install completed but '$PKG' is not on PATH (the package may name its binary differently)."
fi
