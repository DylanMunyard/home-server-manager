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

This same Secret holds **two groups of keys**, both pulled in by the API pod's
`envFrom: secretRef` (so **no Deployment edit is needed** when you add a key):

1. Any `${VAR}` interpolations used in `config/servers/*.yaml` (hosts,
   passphrases, passwords) — key name must match the `${VAR}` name exactly.
2. The **Discord OAuth + session** vars the auth layer requires:
   `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `ALLOWED_DISCORD_IDS`,
   `SESSION_SECRET` (≥32 chars), `SESSION_SALT` (exactly 16 chars). The API
   **exits at startup** if any is missing/invalid (`auth.config.ts` fails loud),
   so this Secret is effectively required, not optional. `PUBLIC_URL` is *not*
   here — it's non-secret and lives in `api-deployment.yaml`.

```bash
kubectl -n home-server-mgr create secret generic home-server-mgr-secrets \
  --from-literal=HETZNER_HOST='<value>' \
  --from-literal=HETZNER_PASSPHRASE='<value>' \
  --from-literal=DISCORD_CLIENT_ID='<discord app client id>' \
  --from-literal=DISCORD_CLIENT_SECRET='<discord app client secret>' \
  --from-literal=ALLOWED_DISCORD_IDS='<your discord user id>' \
  --from-literal=SESSION_SECRET="$(openssl rand -hex 24)" \
  --from-literal=SESSION_SALT="$(openssl rand -hex 8)" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n home-server-mgr rollout restart deployment/home-server-mgr-api
```

The `create … --dry-run=client -o yaml | kubectl apply` form **replaces the
whole Secret**, so always re-run it with the *full* set of keys — drop one and
it's gone. (`openssl rand -hex 8` is exactly 16 chars; `-hex 24` is 48, ≥32.)
Rotating `SESSION_SECRET`/`SESSION_SALT` invalidates existing login cookies —
you just sign in again.

Verify:

```bash
kubectl -n home-server-mgr get secret home-server-mgr-ssh -o jsonpath='{.data.id_ed25519}' | base64 -d | head -1
# -> -----BEGIN OPENSSH PRIVATE KEY-----
```

---

## 2b. Cloudflare Tunnel (public ingress)

`mgr.munyard.dev` is served by a **dedicated** Cloudflare Tunnel owned by this
app (`deploy/k8s/cloudflared.yaml`) — not shared with other projects, so the
whole deployment lives in this repo. The tunnel terminates at the UI Service
(`home-server-mgr-ui:80`); nginx there serves the SPA and proxies `/api` + `/ws`
to the API, and the API enforces Discord auth on those routes.

One-time setup (from your laptop, with `cloudflared` installed and admin
kubeconfig to the cluster):

```bash
cloudflared tunnel login
cloudflared tunnel create home-server-mgr      # prints a Tunnel ID + creds file path

# Tunnel credentials Secret (the creds JSON is the secret; the id is not).
kubectl -n home-server-mgr create secret generic tunnel-credentials \
  --from-file=credentials.json=$HOME/.cloudflared/<TUNNEL_ID>.json

# Point the public hostname at this tunnel (creates the DNS CNAME in Cloudflare).
cloudflared tunnel route dns home-server-mgr mgr.munyard.dev
```

The Tunnel ID is committed in `deploy/k8s/cloudflared.yaml` (it's not a
secret — only `credentials.json` is). Update it there only if you recreate the
tunnel. Apply the manifest:

```bash
kubectl apply -f deploy/k8s/cloudflared.yaml
kubectl -n home-server-mgr rollout status deployment/cloudflared --timeout=120s
```

Like `rbac.yaml`, this manifest is applied **manually** — the Jenkinsfile only
applies `api-deployment.yaml` / `ui-deployment.yaml` by name, so the tunnel
isn't touched by CI once it's up. Confirm `PUBLIC_URL` in `api-deployment.yaml`
matches the hostname (`https://mgr.munyard.dev`), and that
`mgr.munyard.dev/api/auth/callback` is registered as an OAuth2 redirect URL in
the Discord app.

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
| `home-server-mgr-secrets` | One key per `${VAR}` in `config/servers/*.yaml` (e.g. `HETZNER_HOST`, `HETZNER_PASSPHRASE`) **plus** the auth keys `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `ALLOWED_DISCORD_IDS`, `SESSION_SECRET`, `SESSION_SALT`. | `envFrom: secretRef` on the API pod |
| `tunnel-credentials` | `credentials.json` (Cloudflare Tunnel creds) | Mounted at `/etc/cloudflared/creds` on the cloudflared pod |

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

The UI Service is `ClusterIP`. In production it's reached publicly via the
Cloudflare Tunnel at **https://mgr.munyard.dev** (see "2b. Cloudflare Tunnel").
For local cluster debugging without the tunnel:

- Port-forward (quick test): `kubectl -n home-server-mgr port-forward svc/home-server-mgr-ui 5780:80`
