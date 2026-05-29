#!/usr/bin/env bash

# -----------------------------------------------------------------------------
# This script safely installs 'jq' on a target Linux or macOS machine.
# It first checks if jq is already installed to avoid redundant work. 
# If not, it detects the system's package manager (apt, dnf, yum, apk, 
# pacman, zypper, or brew) and installs jq non-interactively. It also 
# attempts to use 'sudo' automatically if the script is not run as root.
# -----------------------------------------------------------------------------

set -euo pipefail

# 1. Check if jq is already installed
if command -v jq >/dev/null 2>&1; then
    echo "jq is already installed. Version: $(jq --version)"
    exit 0
fi

echo "jq is not installed. Detecting system to install..."

# 2. Helper function to use sudo if the user is not root
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

# 3. Detect the package manager and install non-interactively
if command -v apt-get >/dev/null 2>&1; then
    echo "Detected Debian/Ubuntu-based system."
    run_cmd apt-get update -yqq
    run_cmd apt-get install -yqq jq

elif command -v dnf >/dev/null 2>&1; then
    echo "Detected Fedora/RHEL-based system (dnf)."
    run_cmd dnf install -y jq

elif command -v yum >/dev/null 2>&1; then
    echo "Detected older CentOS/RHEL-based system (yum)."
    run_cmd yum install -y epel-release # Sometimes required for jq on older CentOS
    run_cmd yum install -y jq

elif command -v apk >/dev/null 2>&1; then
    echo "Detected Alpine Linux."
    run_cmd apk add --quiet --no-cache jq

elif command -v pacman >/dev/null 2>&1; then
    echo "Detected Arch-based system."
    run_cmd pacman -Sy --noconfirm jq

elif command -v zypper >/dev/null 2>&1; then
    echo "Detected SUSE-based system."
    run_cmd zypper install -y jq

elif command -v brew >/dev/null 2>&1; then
    echo "Detected macOS or Homebrew."
    # brew shouldn't generally be run with sudo
    brew install jq

else
    echo "Error: Could not determine package manager. Please install jq manually."
    exit 1
fi

# 4. Verify installation
if command -v jq >/dev/null 2>&1; then
    echo "Successfully installed jq! Version: $(jq --version)"
else
    echo "Error: Installation completed but jq is not in the system PATH."
    exit 1
fi