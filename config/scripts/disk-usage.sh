#!/usr/bin/env bash
# disk-usage-summary — display available disk space and volume breakdown
set -euo pipefail

# ANSI Color Codes
BLUE='\033[1;34m'
GREEN='\033[1;32m'
YELLOW='\033[1;33m'
RED='\033[1;31m'
NC='\033[0m' # No Color
BOLD='\033[1m'

echo -e "${BLUE}${BOLD}=== Volume Breakdown & Available Space ===${NC}\n"

# Run df, filter out noisy filesystems, and pipe to awk for formatting
df -h -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs | awk -v green="$GREEN" -v yellow="$YELLOW" -v red="$RED" -v nc="$NC" -v bold="$BOLD" '
BEGIN {
    # Print table header
    printf "%s%-25s %-10s %-10s %-10s %-10s %s%s\n", bold, "FILESYSTEM", "SIZE", "USED", "AVAIL", "USE%", "MOUNTED ON", nc
    print "------------------------------------------------------------------------------------------"
}
NR>1 {
    # Extract the usage percentage as a number for comparison
    usage = $5
    sub(/%/, "", usage)
    
    # Assign color based on threshold
    color = green
    if (usage >= 75) color = yellow
    if (usage >= 90) color = red
    
    # Print formatted row
    printf "%-25s %-10s %-10s %-10s %s%-10s%s %s\n", $1, $2, $3, $4, color, $5, nc, $6
}'

echo ""