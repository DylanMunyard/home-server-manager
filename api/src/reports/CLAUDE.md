# E2E reports — engine internals

Scope: `api/src/reports/`, the `/data/reports` volume, and the reports section
in the dashboard node detail (`ui/src/reports/`, rendered by
`ui/src/metrics/NodeDetail.tsx`). Root `CLAUDE.md` has the summary; this is the
contract.

## What problem this solves

The bfstats `e2e` job uploads its Playwright HTML report as a GitHub artifact.
Looking at it means downloading a zip and running
`npx playwright show-report ui/playwright-report` locally — so in practice the
failure videos were never watched. This hosts the report at a URL instead, and
makes the ntfy alert's tap-target *be* that URL.

## Routes

```
POST   /api/reports/ingest?node=…&repo=…&pr=…&branch=…&sha=…&run=…&status=…
       Authorization: Bearer $REPORTS_INGEST_TOKEN
       Content-Type: application/gzip     body = tar.gz of the report dir
       → 201 { id, url }

GET    /api/reports?node=<id>      list metadata, newest first   (session)
DELETE /api/reports/:id                                          (session)
GET    /api/reports/view/<id>/report/index.html   the report      (session)
```

- **`node` is required and validated** against `config/servers` via the existing
  `loadServer()`. A report cannot exist without a real node — that anchor is the
  whole point, and it's what the node-detail listing filters on. Unknown ⇒ 400.
- Every other query param is optional provenance. A report with none of it still
  works; the UI falls back to showing the id.
- `status` defaults to `failed`. **Only `failed` fires an ntfy alert** — a passed
  report can still be uploaded and viewed, it just doesn't push.

## The auth carve-out — the sharp edge of this feature

`/api/reports/ingest` is the **only** path besides `/api/health` and
`/api/auth/*` that isn't behind Discord OAuth, because GitHub Actions can't
complete an interactive OAuth flow. The bearer token is therefore the entire
gate. Rules that must hold:

- The entry in `auth.plugin.ts`'s `isPublicPath()` is an **exact string match**.
  A `startsWith('/api/reports')` there would publish every hosted report to the
  internet. Don't.
- `REPORTS_INGEST_TOKEN` unset ⇒ the route returns **503**, never a default or
  a dev fallback. No token, no ingest.
- The compare is `crypto.timingSafeEqual`, length-gated first (it throws on a
  length mismatch).

## Extraction is untrusted input

The tarball arrives over the internet, so `reports.store.ts#extract` treats it
as hostile even though we wrote the sender:

- `strict: true` promotes node-tar's warnings to errors, so an entry with a
  `..` segment or an absolute path **aborts the whole extraction** rather than
  being skipped. A failed extraction deletes the partial dir so the UI never
  lists a half-report.
- The `filter` accepts only `File` and `Directory` entries. Links are the real
  risk: a symlink to `/etc/passwd` inside the report dir would be followed by
  `@fastify/static` when serving it back.
- `strip: 1` drops the archive's top-level wrapper, so the report always lands
  at `<id>/report/index.html` regardless of what CI named the directory.
- The body is streamed (`request.raw` → gunzip → tar) via a passthrough
  content-type parser. It is never buffered — a report with videos is tens of MB
  and the pod has a 768Mi limit.

`:id` is validated against `/^\d{8}-\d{6}-[0-9a-f]{6}$/` inside `dirFor()`,
which every path-forming call goes through. That shape check is the traversal
defence for the delete and view routes — keep it there rather than at the edges.

## Storage + retention

```
<REPORTS_DIR>/<id>/meta.json     provenance
<REPORTS_DIR>/<id>/report/…      the extracted report, served as-is
```

- **No index file.** Retention keeps this to a handful of directories, so
  `list()` just scans them. A report can be removed with `rm -rf` and nothing
  else needs updating.
- `id` is `YYYYMMDD-HHMMSS-<6 hex>` in **UTC**, so lexical order is chronological
  regardless of the process TZ (which the pod pins to Brisbane for cron).
- **`prune()` keeps `REPORTS_KEEP` per node**, not globally — a chatty repo must
  not evict the one report you were about to open on another box.
- The `/data/reports` PVC (`deploy/k8s/api-deployment.yaml`) is the documented
  exception to the no-persistence rule. It's RWO local-path, which is why that
  Deployment uses `strategy: Recreate` — a RollingUpdate would have the new pod
  waiting on a volume the old one still holds.

## Serving

The report is an ordinary static site: a self-contained `index.html` plus a
sibling `data/` dir of `.webm`/`.png` attachments referenced by **relative**
URL. `@fastify/static` under `/api/reports/view/` is the whole implementation —
no rewriting, no `show-report`, and it handles Range requests, which is what
makes seeking inside a failure video work.

The UI opens it in a new tab rather than an iframe: it's a full-page app, and
being same-origin means the session cookie authenticates it with no extra work.

## Config (env, lenient — never fails boot)

| var | default | effect |
| --- | --- | --- |
| `REPORTS_DIR` | `<repo>/.reports` | prod sets `/data/reports` (the PVC) |
| `REPORTS_INGEST_TOKEN` | — | unset ⇒ ingest 503; viewing still works |
| `REPORTS_KEEP` | `10` | per node |
| `REPORTS_MAX_BYTES` | 100MB | Cloudflare's free-plan request-body cap |

## The CI side (other repo)

`~/projects/skandia/bfstats/.github/workflows/claude-cursor-review.yml`, step
**"Publish Playwright report to home-server-mgr"** in the `e2e` job. Notes for
whoever changes it:

- It runs **before** the PR-comment step so the comment can carry the link via
  `REPORT_URL` in `$GITHUB_ENV`.
- `continue-on-error: true` and every failure path `exit 0` — publishing is a
  convenience, not a gate. If mgr is down, missing secrets, or the report is
  over 100MB, the step warns and the E2E verdict is untouched. The
  `upload-artifact` step stays as the fallback.
- Secrets: `HSM_REPORTS_URL`, `HSM_REPORTS_TOKEN` (matching the
  `REPORTS_INGEST_TOKEN` in `home-server-mgr-secrets`).
- The upload traverses cloudflared → the UI's nginx → the API, so
  `deploy/nginx.conf` needs `client_max_body_size` above the report size;
  nginx's 1m default would 413 every upload.
