# Jenkins CI/CD — home-server-mgr

Jenkins runs on the local k8s cluster (the same `bethany` node it deploys to)
and uses **in-cluster ServiceAccount auth** — no kubeconfig credential to
manage. The Jenkins agent pod is launched into the `home-server-mgr`
namespace under the `home-server-mgr-deployer` ServiceAccount; `kubectl`
inside the pod authenticates with the auto-mounted token.

---

## 1. One-time cluster bootstrap

Apply the namespace, ServiceAccount, Role, and RoleBinding from your laptop
(while you have admin kubeconfig to the cluster):

```bash
kubectl apply -f deploy/k8s/rbac.yaml
```

This creates:

| Resource | Name | Namespace |
|----------|------|-----------|
| Namespace | `home-server-mgr` | — |
| ServiceAccount | `home-server-mgr-deployer` | `home-server-mgr` |
| Role | `home-server-mgr-deployer` | `home-server-mgr` |
| RoleBinding | `home-server-mgr-deployer` | `home-server-mgr` |

---

## 2. Create the SSH key Secret

The API needs the SSH private key referenced by `config/servers/*.yaml`.
The mounted path is `/home/app/.ssh/` so `~/.ssh/id_ed25519` (as written
in the YAML) resolves correctly.

Create the Secret manually (Jenkins does **not** rotate this). Include one
`--from-file=NAME=PATH` per key your YAML references — `NAME` is the
filename inside `/home/app/.ssh/`, so it must match what the YAML uses:

```bash
kubectl -n home-server-mgr create secret generic home-server-mgr-ssh \
  --from-file=id_ed25519=$HOME/.ssh/id_ed25519 \
  --from-file=hetzner=$HOME/.ssh/hetzner
```

To add or replace a key later, re-run the same command with the full set
and pipe through apply (Secrets are immutable to plain `create`):

```bash
kubectl -n home-server-mgr create secret generic home-server-mgr-ssh \
  --from-file=id_ed25519=$HOME/.ssh/id_ed25519 \
  --from-file=hetzner=$HOME/.ssh/hetzner \
  --from-file=pi-town=$HOME/.ssh/pi-town \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n home-server-mgr rollout restart deployment/home-server-mgr-api
```

If `config/servers/*.yaml` uses any `${VAR}` interpolations (e.g. hosts,
passphrases, passwords), put one entry per var in `home-server-mgr-secrets`
— the API pod's `envFrom: secretRef` pulls every key in as an env var, so
**no Deployment edit is needed when you add a new `${VAR}`**.

```bash
kubectl -n home-server-mgr create secret generic home-server-mgr-secrets \
  --from-literal=HETZNER_HOST='<value>' \
  --from-literal=HETZNER_PASSPHRASE='<value>' \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n home-server-mgr rollout restart deployment/home-server-mgr-api
```

The Secret key names must match the `${VAR}` names in the YAML exactly
(case-sensitive). Re-run the same command with the full set to add or
replace keys later.

Verify:

```bash
kubectl -n home-server-mgr get secret home-server-mgr-ssh -o jsonpath='{.data.id_ed25519}' | base64 -d | head -1
# -> -----BEGIN OPENSSH PRIVATE KEY-----
```

---

## 3. Configure Docker Hub credentials in Jenkins

The Jenkinsfile pushes images to `dylanmunyard/home-server-manager:api`
and `:ui` using a Docker Hub Access Token.

1. [Docker Hub > Account Settings > Security](https://hub.docker.com/settings/security) → **New Access Token**
2. Description `jenkins-home-server-mgr`, **Read/Write** permissions, copy the token.
3. In **Jenkins > Manage Jenkins > Credentials**, add a **Username with password** credential:
   - **Username**: `dylanmunyard`
   - **Password**: the access token
   - **ID**: `dylanmunyard-dockerhub-pat`

---

## 4. Configure the Kubernetes cloud in Jenkins

The `Local k8s` cloud must already be configured (re-used from bfstats).
No per-project config is required — the Jenkinsfile sets
`namespace 'home-server-mgr'` on each agent block, which launches the
agent pod into that namespace with the `home-server-mgr-deployer` SA from
`pod.yaml`.

If the `Local k8s` cloud uses a restricted namespace list, add
`home-server-mgr` to it: **Manage Jenkins > Clouds > Local k8s >
Kubernetes Namespace** (and any allowed-namespaces list).

---

## 5. Git HTTPS credential (if cloning over HTTPS)

If the Jenkins job clones via HTTPS:

1. **Jenkins > Manage Jenkins > Credentials** → **Add Credentials**
2. Kind: `Username with password`
3. Username: GitHub username, Password: PAT with `repo` scope
4. ID: `home-server-mgr-git-https`
5. Attach to the pipeline job's SCM source.

---

## Jenkins credentials summary

| Credential ID | Type | Purpose |
|---------------|------|---------|
| `dylanmunyard-dockerhub-pat` | Username/Password | Docker Hub push |
| `home-server-mgr-git-https` | Username/Password | Git HTTPS clone (if applicable) |

(No kubeconfig credential — in-cluster SA replaces it.)

---

## Cluster-managed secrets summary

These are k8s Secrets in the `home-server-mgr` namespace, created manually
(not by Jenkins). Jenkins reads them indirectly via the pod's `env` / volume
mounts.

| Secret | Keys | Used by |
|--------|------|---------|
| `home-server-mgr-ssh` | `id_ed25519` (and any other private keys referenced from YAML) | Mounted at `/home/app/.ssh/` |
| `home-server-mgr-secrets` | One key per `${VAR}` used in `config/servers/*.yaml` (e.g. `HETZNER_HOST`, `HETZNER_PASSPHRASE`). Key name must match `${VAR}` name exactly. | `envFrom: secretRef` on the API pod |

---

## ConfigMaps

These are recreated by Jenkins on every API deploy from the `config/`
folder — do **not** create them manually.

| ConfigMap | Sourced from | Mounted at |
|-----------|--------------|------------|
| `home-server-mgr-servers` | `config/servers/` (every file) | `/app/config/servers` |
| `home-server-mgr-scripts` | `config/scripts/` (every file, mode 0755) | `/app/config/scripts` |

The `--from-file=<dir>` form means adding or removing files in those
folders is picked up on the next Jenkins build — no Jenkinsfile change
needed.

---

## How to access the UI

The UI Service is `ClusterIP`. Pick one:

- Port-forward (quick test): `kubectl -n home-server-mgr port-forward svc/home-server-mgr-ui 5780:80`
- LoadBalancer / NodePort: edit `ui-deployment.yaml` Service `spec.type`
- Ingress: add an Ingress resource pointing at `home-server-mgr-ui:80`
  (intentionally not bundled — depends on your cluster's ingress controller)
