#!/usr/bin/env bash
# k3s-top — k3s node + pod resource usage, busiest pods by CPU first
# (kubectl top; degrades to a plain pod list when metrics-server is missing)
set -euo pipefail

# if-condition position keeps `set -e` from killing the script on failure.
if kubectl top nodes 2>/dev/null; then
    echo
    kubectl top pods -A --sort-by=cpu 2>/dev/null | head -30
else
    echo "kubectl top unavailable (metrics-server missing?) — falling back to pod list"
    kubectl get pods -A -o wide
fi
