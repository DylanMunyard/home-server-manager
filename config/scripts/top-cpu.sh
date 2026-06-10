#!/usr/bin/env bash
# top-cpu — top processes by CPU and memory (one screenful, no TTY)
set -euo pipefail

echo "== by cpu =="
ps aux --sort=-%cpu | head -15
echo
echo "== by mem =="
ps aux --sort=-%mem | head -10
