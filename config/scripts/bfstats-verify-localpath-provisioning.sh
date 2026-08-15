#!/usr/bin/env bash
# bfstats-verify-localpath-provisioning — prove local-path can dynamically
#     provision a PVC onto the attached volume, and that a real workload can
#     read and write it
#
# Creates a SEPARATE StorageClass carrying its own `nodePath` parameter, so the
# cluster's default `local-path` StorageClass and the `local-path-config`
# ConfigMap are never modified. Nothing existing is touched: no current PVC,
# workload or manifest is read or changed. Everything created here is prefixed
# and torn down on exit.
#
# The test mirrors production: a Deployment running as the same UID as
# bf42-stats, writing to a PVC, then reading back and checksumming.
#
# The assertion that matters is not "the pod could write" — it is "the bytes
# physically landed on the attached volume". A misconfigured nodePath fails by
# silently provisioning onto the root disk instead, which looks identical from
# inside the pod. So this verifies the PV's path on the host AND that the path
# sits on a different device from the root filesystem.
#
# params:
#   MOUNT_PATH:  { label: "Host path of the mounted volume", default: "/mnt/bfstats-data" }
#   APP_UID:     { label: "UID the workload runs as", default: "1000" }
#   APP_GID:     { label: "GID the workload runs as", default: "1000" }
#   ROOT_REF:    { label: "Known root-disk path, for the device comparison", default: "/var/lib/rancher/k3s/storage" }
#   USE_SC:      { label: "Test an EXISTING StorageClass by name instead of creating one", default: "" }
#   KEEP:        { label: "Set to 1 to leave everything in place for inspection", default: "0" }
# nodes: [ hetzner/bfstats ]
#
# Exit codes: 0 provisioning verified · 1 verification failed · 2 prerequisite missing

set -euo pipefail

MOUNT_PATH="${MOUNT_PATH:-/mnt/bfstats-data}"
APP_UID="${APP_UID:-1000}"
APP_GID="${APP_GID:-1000}"
ROOT_REF="${ROOT_REF:-/var/lib/rancher/k3s/storage}"
USE_SC="${USE_SC:-}"
KEEP="${KEEP:-0}"

# USE_SC set => test the cluster's real StorageClass as-is (what production will
# actually use). Unset => create a throwaway SC pinned with nodePath.
SC="${USE_SC:-lp-verify-$$}"
OWN_SC=0; [ -z "$USE_SC" ] && OWN_SC=1
NS="lp-verify-$$"

command -v kubectl >/dev/null 2>&1 || { echo "kubectl not installed on host" >&2; exit 2; }

log()  { printf '==> %s\n' "$*" >&2; }
dim()  { printf '    %s\n' "$*" >&2; }
fail() { printf '[FAIL] %s\n' "$*" >&2; FAILED=1; }
die()  { printf '[fail] %s\n' "$*" >&2; exit 1; }
FAILED=0

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "$KEEP" = "1" ]; then
    echo >&2
    log "KEEP=1 — leaving StorageClass '$SC' and namespace '$NS' in place."
    dim "Remove with: kubectl delete ns $NS && kubectl delete sc $SC"
    exit "$rc"
  fi
  echo >&2
  log "Cleaning up"
  # Namespace first: deleting the PVC while the SC still exists lets the
  # provisioner run its teardown and remove the directory it created.
  kubectl delete namespace "$NS" --wait=true --timeout=90s >/dev/null 2>&1 || true
  # Only ever delete a StorageClass this script created — never one of the
  # cluster's own.
  [ "$OWN_SC" = "1" ] && kubectl delete storageclass "$SC" >/dev/null 2>&1 || true
  exit "$rc"
}
trap cleanup EXIT INT TERM

log "Verifying local-path provisioning onto $MOUNT_PATH"
if [ "$OWN_SC" = "1" ]; then
  dim "storageclass : $SC  (created by this script, additive — cluster's own untouched)"
else
  dim "storageclass : $SC  (existing cluster StorageClass, used as-is)"
fi
dim "namespace    : $NS"
dim "workload uid : $APP_UID:$APP_GID"
echo >&2

# ── the StorageClass ─────────────────────────────────────────────────────────
# reclaimPolicy Delete so teardown removes the provisioned directory for us.
# WaitForFirstConsumer matches the cluster default and is required for
# local-path to know which node it is provisioning for.
if [ "$OWN_SC" = "1" ]; then
  kubectl apply -f - >/dev/null <<YAML
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: $SC
provisioner: rancher.io/local-path
parameters:
  nodePath: $MOUNT_PATH
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Delete
YAML
else
  kubectl get storageclass "$SC" >/dev/null 2>&1 || die "StorageClass '$SC' not found"
fi

kubectl create namespace "$NS" >/dev/null

# ── PVC + a sample app that actually uses it ─────────────────────────────────
kubectl apply -f - >/dev/null <<YAML
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: lp-verify-pvc
  namespace: $NS
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: $SC
  resources:
    requests:
      storage: 1Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: lp-verify-app
  namespace: $NS
spec:
  replicas: 1
  selector:
    matchLabels: { app: lp-verify-app }
  template:
    metadata:
      labels: { app: lp-verify-app }
    spec:
      securityContext:
        runAsUser: $APP_UID
        runAsGroup: $APP_GID
        fsGroup: $APP_GID
      containers:
        - name: app
          image: busybox:1.36
          command: ["/bin/sh","-c"]
          args:
            - |
              # A long-lived workload that writes on an interval, so we are
              # testing sustained read/write through the PVC rather than a
              # single lucky write at startup.
              set -e
              echo "starting, writing to /data"
              i=0
              while :; do
                i=\$((i+1))
                echo "line \$i at \$(date -Iseconds)" >> /data/app.log
                sync
                sleep 2
              done
          volumeMounts:
            - { name: data, mountPath: /data }
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: lp-verify-pvc
YAML

log "Waiting for the sample app to become ready"
if ! kubectl rollout status deployment/lp-verify-app -n "$NS" --timeout=150s >&2; then
  echo >&2
  fail "the sample app never became ready"
  dim "PVC:"; kubectl get pvc -n "$NS" >&2 || true
  dim "Events:"; kubectl get events -n "$NS" --sort-by=.lastTimestamp 2>&1 | tail -15 >&2 || true
  exit 1
fi

POD="$(kubectl get pod -n "$NS" -l app=lp-verify-app -o jsonpath='{.items[0].metadata.name}')"
PV="$(kubectl get pvc lp-verify-pvc -n "$NS" -o jsonpath='{.spec.volumeName}')"
dim "pod: $POD"
dim "pv : $PV"
echo >&2

# ── 1. where did the provisioner actually put it? ────────────────────────────
log "Check 1 — provisioned path on the host"
HOSTPATH="$(kubectl get pv "$PV" -o jsonpath='{.spec.local.path}' 2>/dev/null || true)"
[ -n "$HOSTPATH" ] || HOSTPATH="$(kubectl get pv "$PV" -o jsonpath='{.spec.hostPath.path}' 2>/dev/null || true)"
dim "PV path: ${HOSTPATH:-<none>}"

case "$HOSTPATH" in
  "$MOUNT_PATH"/*)
    dim "OK: provisioned under $MOUNT_PATH"
    ;;
  *)
    fail "provisioned to '$HOSTPATH', NOT under $MOUNT_PATH"
    dim "The nodePath StorageClass parameter was not honoured — local-path fell"
    dim "back to its configured nodePathMap. Adding $MOUNT_PATH to the"
    dim "local-path-config ConfigMap would be required instead."
    ;;
esac

# ── 2. is that path really on the volume, not the root disk? ─────────────────
log "Check 2 — the path is on the attached volume, not the root disk"
if [ -n "$HOSTPATH" ] && [ -d "$HOSTPATH" ]; then
  dev_vol="$(stat -c %d "$HOSTPATH")"
  dev_root="$(stat -c %d "$ROOT_REF")"
  dim "device(provisioned)=$dev_vol  device($ROOT_REF)=$dev_root"
  if [ "$dev_vol" = "$dev_root" ]; then
    fail "provisioned directory is on the SAME device as the root disk"
  else
    dim "OK: separate device"
    dim "backing: $(df -h --output=source,size,avail "$HOSTPATH" | tail -1)"
  fi
else
  fail "provisioned path '$HOSTPATH' does not exist on this host"
fi

# ── 3. can the workload read and write through the PVC? ──────────────────────
log "Check 3 — sample app read/write through the PVC"
sleep 6   # let the app append a few lines on its interval
lines="$(kubectl exec -n "$NS" "$POD" -- sh -c 'wc -l < /data/app.log' 2>/dev/null | tr -d '[:space:]' || echo 0)"
dim "app.log lines: ${lines:-0}"
[ "${lines:-0}" -ge 2 ] || fail "sample app is not appending to its volume"

kubectl exec -n "$NS" "$POD" -- sh -c '
  dd if=/dev/urandom of=/data/probe.bin bs=1M count=16 2>/dev/null
  sync
  md5sum /data/probe.bin | cut -d" " -f1 > /data/probe.md5
' >/dev/null 2>&1 || fail "workload could not write a 16MiB file"

in_pod="$(kubectl exec -n "$NS" "$POD" -- sh -c 'cat /data/probe.md5' 2>/dev/null | tr -d '[:space:]')"
dim "checksum in pod : ${in_pod:-<none>}"

# Read the same bytes from the host side — proves the PVC is genuinely backed
# by that directory rather than an overlay or emptyDir.
if [ -n "$HOSTPATH" ] && [ -f "$HOSTPATH/probe.bin" ]; then
  on_host="$(md5sum "$HOSTPATH/probe.bin" | cut -d' ' -f1)"
  dim "checksum on host: $on_host"
  if [ "$in_pod" = "$on_host" ] && [ -n "$in_pod" ]; then
    dim "OK: identical bytes in pod and on the volume"
  else
    fail "checksum mismatch between pod and host"
  fi
else
  fail "probe.bin not visible at $HOSTPATH on the host"
fi

# ── 4. ownership, as the provisioner left it ─────────────────────────────────
log "Check 4 — ownership usable by uid $APP_UID"
if [ -n "$HOSTPATH" ] && [ -d "$HOSTPATH" ]; then
  dim "$(stat -c 'dir mode=%a owner=%u:%g' "$HOSTPATH")"
fi

echo >&2
if [ "$FAILED" = "0" ]; then
  log "RESULT: PASS — local-path provisions onto $MOUNT_PATH and the app can read/write it"
  exit 0
fi
log "RESULT: FAIL — see [FAIL] lines above"
exit 1
