#!/usr/bin/env bash
# bfstats-verify-volume-path — prove a host path is a real mounted volume that
#                              the app's UID can read and write
#
# Run this BEFORE migrating any PVC onto an attached Hetzner Volume. It answers
# the four questions that decide whether the migration is safe, in the same
# order they would bite you in production:
#
#   1. Does the path exist and is it actually a mount, or is it a plain
#      directory on the root disk? This is the failure that matters most: an
#      unmounted volume looks identical to a mounted one, and a PVC pointed at
#      it silently starts writing an empty database to the boot disk.
#   2. Can root create + chown a subdirectory there? (What the local-path
#      provisioner does when it materialises a PVC.)
#   3. Can the app's UID actually write, fsync and read back inside it?
#      (What bf42-stats does every second of every day.)
#   4. Is there enough free space for the databases?
#
# Everything is created in a temporary namespace and destroyed on exit. No
# existing workload, PVC or manifest is touched. Read-only with respect to
# production; the only writes are to a scratch subdirectory under MOUNT_PATH,
# which is removed afterwards.
#
# params:
#   MOUNT_PATH:  { label: "Host path of the mounted volume", required: true }
#   APP_UID:     { label: "UID the workload runs as", default: "1000" }
#   APP_GID:     { label: "GID the workload runs as", default: "1000" }
#   REF_PATH:    { label: "Known root-disk path to compare against", default: "/var/lib/rancher/k3s/storage" }
#   MIN_FREE_GB: { label: "Fail if free space is under this many GB", default: "20" }
# nodes: [ hetzner/bfstats ]
#
# Exit codes: 0 all checks passed · 1 a check failed · 2 missing prerequisite

set -euo pipefail

NS="volverify-$$"
IMAGE="busybox:1.36"

MOUNT_PATH="${MOUNT_PATH:?MOUNT_PATH is required}"
APP_UID="${APP_UID:-1000}"
APP_GID="${APP_GID:-1000}"
REF_PATH="${REF_PATH:-/var/lib/rancher/k3s/storage}"
MIN_FREE_GB="${MIN_FREE_GB:-20}"

command -v kubectl >/dev/null 2>&1 || { echo "kubectl not installed on host" >&2; exit 2; }

case "$MOUNT_PATH" in
  /*) ;;
  *) echo "MOUNT_PATH must be absolute (got '$MOUNT_PATH')" >&2; exit 2 ;;
esac

cleanup() {
  local rc=$?
  echo >&2
  echo "Cleaning up namespace $NS ..." >&2
  kubectl delete namespace "$NS" --wait=false >/dev/null 2>&1 || true
  exit "$rc"
}
trap cleanup EXIT INT TERM

echo "=== bfstats volume path verification ===" >&2
echo "  path      : $MOUNT_PATH" >&2
echo "  as        : uid=$APP_UID gid=$APP_GID" >&2
echo "  ref (root): $REF_PATH" >&2
echo "  min free  : ${MIN_FREE_GB}G" >&2
echo >&2

kubectl create namespace "$NS" >/dev/null

# The pod mirrors production exactly:
#   - initContainer runs as root and does what the local-path provisioner does
#     (mkdir + chown), then hands over
#   - the main container runs as the app's UID and does what the app does
#
# hostPath type is `Directory`, NOT `DirectoryOrCreate`. That is deliberate: if
# the volume is not mounted we want the pod to fail to start, rather than
# kubelet helpfully creating the directory on the root disk and every check
# below passing against the wrong filesystem.
cat <<YAML | kubectl apply -f - >/dev/null
apiVersion: v1
kind: Pod
metadata:
  name: volverify
  namespace: $NS
spec:
  restartPolicy: Never
  initContainers:
    - name: as-root
      image: $IMAGE
      securityContext:
        runAsUser: 0
      command: ["/bin/sh","-c"]
      args:
        - |
          set -e
          echo "--- [root] provisioner simulation ---"
          mkdir -p /target/.volverify/sub
          chown -R $APP_UID:$APP_GID /target/.volverify
          echo "[root] mkdir + chown OK"
      volumeMounts:
        - { name: target, mountPath: /target }
  containers:
    - name: as-app
      image: $IMAGE
      securityContext:
        runAsUser: $APP_UID
        runAsGroup: $APP_GID
      command: ["/bin/sh","-c"]
      args:
        - |
          fail=0
          echo "--- [app] identity ---"
          id

          echo "--- [app] filesystem ---"
          df -h /target
          df -P /target | awk 'NR==2 {print "DEVICE="\$1}'

          echo "--- [app] mount check ---"
          # Device ids differ iff the two paths are on different filesystems.
          # If they match, MOUNT_PATH is on the root disk => volume not mounted.
          t=\$(stat -c %d /target)
          r=\$(stat -c %d /ref)
          echo "target_dev=\$t ref_dev=\$r"
          if [ "\$t" = "\$r" ]; then
            echo "FAIL: $MOUNT_PATH is on the SAME filesystem as $REF_PATH."
            echo "      The volume is not mounted — anything written here lands on the root disk."
            fail=1
          else
            echo "OK: separate filesystem from the root disk"
          fi

          echo "--- [app] free space ---"
          free_kb=\$(df -P /target | awk 'NR==2 {print \$4}')
          free_gb=\$((free_kb / 1024 / 1024))
          echo "free=\${free_gb}G required=${MIN_FREE_GB}G"
          if [ "\$free_gb" -lt "${MIN_FREE_GB}" ]; then
            echo "FAIL: only \${free_gb}G free, need ${MIN_FREE_GB}G"
            fail=1
          else
            echo "OK: sufficient free space"
          fi

          echo "--- [app] write / fsync / read-back ---"
          f=/target/.volverify/sub/probe.bin
          if ! dd if=/dev/urandom of=\$f bs=1M count=8 2>/dev/null; then
            echo "FAIL: could not write as uid $APP_UID"
            fail=1
          else
            sync
            a=\$(md5sum \$f | cut -d' ' -f1)
            b=\$(md5sum \$f | cut -d' ' -f1)
            if [ "\$a" = "\$b" ] && [ -n "\$a" ]; then
              echo "OK: wrote 8MiB, read back, checksum \$a"
            else
              echo "FAIL: read-back mismatch"
              fail=1
            fi
            rm -f \$f
          fi

          echo "--- [app] subdirectory creation ---"
          if mkdir -p /target/.volverify/sub/nested 2>/dev/null; then
            echo "OK: app uid can create subdirectories"
            rmdir /target/.volverify/sub/nested
          else
            echo "FAIL: app uid cannot create subdirectories"
            fail=1
          fi

          echo
          if [ "\$fail" = "0" ]; then echo "RESULT: ALL CHECKS PASSED"; else echo "RESULT: FAILURES PRESENT"; fi
          exit \$fail
      volumeMounts:
        - { name: target, mountPath: /target }
        - { name: ref,    mountPath: /ref, readOnly: true }
  volumes:
    - name: target
      hostPath:
        path: $MOUNT_PATH
        type: Directory
    - name: ref
      hostPath:
        path: $REF_PATH
        type: Directory
YAML

echo "Waiting for pod to finish..." >&2
# Don't use `wait --for=condition=Ready`: the pod is expected to run to
# completion, so Ready may never be observed. Poll phase instead.
deadline=$((SECONDS + 180))
phase=""
while :; do
  phase="$(kubectl get pod volverify -n "$NS" -o jsonpath='{.status.phase}' 2>/dev/null || true)"
  case "$phase" in
    Succeeded|Failed) break ;;
  esac
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo >&2
    echo "TIMED OUT waiting for the pod. Most likely the hostPath could not be" >&2
    echo "satisfied — with type: Directory that means $MOUNT_PATH does not exist" >&2
    echo "on the node (volume not mounted?). Pod events:" >&2
    kubectl describe pod volverify -n "$NS" 2>&1 | sed -n '/Events:/,$p' >&2
    exit 1
  fi
  sleep 3
done

echo >&2
kubectl logs volverify -n "$NS" --all-containers=true 2>&1 || true
echo >&2

if [ "$phase" = "Succeeded" ]; then
  echo "=== VERIFIED: $MOUNT_PATH is a mounted volume, writable by uid $APP_UID ===" >&2
  exit 0
fi

echo "=== FAILED: $MOUNT_PATH is NOT safe to migrate a PVC onto (see output above) ===" >&2
exit 1
