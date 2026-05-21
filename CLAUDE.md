# CLAUDE.md

## Build and deploy

All images must target `linux/amd64` — the EKS nodes do not run ARM.

```bash
# App
docker build --platform linux/amd64 -t aslancarlos/k8s-eso-shop:latest .
docker push aslancarlos/k8s-eso-shop:latest
kubectl rollout restart deployment/eso-shop -n eso-shop
kubectl rollout status deployment/eso-shop -n eso-shop --timeout=120s

# Operator (separate image)
cd operator
docker build --platform linux/amd64 -t aslancarlos/eso-shop-operator:latest .
docker push aslancarlos/eso-shop-operator:latest
kubectl rollout restart deployment/eso-shop-operator -n eso-shop
```

Local dev (no Docker):
```bash
export DB_HOST=127.0.0.1 DB_USER=root DB_PASS=secret DB_NAME=myappDB
npm run dev
```

## Architecture decisions

**BASE_PATH and relative URLs** — The app is served under `/k8s-eso/` via nginx rewrite. Express is configured with `BASE_PATH=/k8s-eso` and a `<base href="/k8s-eso/">` tag is injected in `head.ejs`. All `href` values in EJS templates must be **relative** (e.g. `href="products"`, not `href="/products"`). Absolute paths bypass the base tag and break navigation.

**Trust proxy** — `app.set('trust proxy', 1)` is required. Without it, `req.ip` returns the nginx pod IP instead of the client IP, breaking the rate limiter. `req.secure` also depends on this to correctly read `X-Forwarded-Proto`.

**TLS termination at ingress** — The Node.js app listens on plain HTTP port 3000. TLS is handled entirely by nginx. The `eso_lang` cookie uses `secure: req.secure || req.headers['x-forwarded-proto'] === 'https'` to set the secure flag correctly.

**DB migration on startup** — `db.js` runs `CREATE TABLE IF NOT EXISTS` and seeds data automatically on first connection. There is no separate migration CLI or job. If you add a new table or column, add it to the `migrate()` function. Idempotency matters — use `IF NOT EXISTS` or `UPDATE ... WHERE`.

**Operator RBAC is intentionally narrow** — The Python operator can only `get/list/watch` the single secret `eso-shop-db-creds` and `get/patch` the single deployment `eso-shop`. Do not expand these permissions. The operator reads `resourceVersion` changes from metadata only — it never reads secret data.

**ESO refresh interval** — Set to `1m` in `k8s/external-secret.yaml`. This is intentionally short for demo purposes.

## Key files

| File | What to know |
|---|---|
| `src/server.js` | All routes + security middleware. Rate limiter is per-pod in-memory (not distributed). |
| `src/db.js` | Pool is a module-level singleton. Migration + broken image URL fix runs every cold start. |
| `src/i18n.js` | Cookie name is `eso_lang`. `SUPPORTED` list must match filenames in `src/locales/`. |
| `k8s/cluster-secret-store.yaml` | Contains a real `caBundle` (base64 Conjur CA cert chain). Do not regenerate or truncate it. |
| `k8s/conjur-policy.yml` | Must be applied in Conjur before ESO can sync the secret. Not a K8s manifest — load via Conjur CLI/UI. |
| `operator/main.py` | Runs two threads: HTTP server (health + status) and K8s watch loop. Shared state is protected by `_lock`. |

## What not to do

- **Do not add `configuration-snippet` annotations to ingress** — the nginx admission webhook rejects them (CVE-2021-25742 hardening is enabled on this cluster).
- **Do not use `ingressClassName: nginx`** — this cluster uses `nginx-internal`. Wrong class = no routing.
- **Do not store credentials anywhere in the codebase** — DB creds come exclusively from the K8s secret injected by ESO.
- **Do not remove `app.set('trust proxy', 1)`** — rate limiting and secure cookies depend on it.
- **Do not use `<%- %>` for user-supplied content** — only use unescaped output (`<%-`) for translation strings from server-side JSON files. User data must always go through `<%= %>`.
- **Do not change the operator's Role to ClusterRole** — the operator only needs access within `eso-shop` namespace.

## Applying K8s manifests

Apply in this order when doing a fresh deploy — ESO objects depend on the namespace and service account existing first:

```
namespace.yaml → serviceaccount.yaml → eso-rbac.yaml →
cluster-secret-store.yaml → external-secret.yaml →
operator/ → deployment.yaml → ingress.yaml → pdb.yaml
```

To verify the secret chain:
```bash
kubectl get externalsecret eso-shop-db-creds -n eso-shop
# READY column must be True

kubectl describe secret eso-shop-db-creds -n eso-shop
# Must contain DB_HOST, DB_USER, DB_PASS keys
```

## Adding a new translation key

1. Add the key to all three locale files: `src/locales/pt.json`, `en.json`, `es.json`
2. Use `<%= t('section.key') %>` in EJS for plain text, `<%- t('section.key') %>` only if the value intentionally contains HTML (e.g. `<strong>` in step descriptions)
3. No server restart needed for locale changes in dev (`--watch` reloads on file change), but a full image rebuild is needed for production

## Product images

All product images are Unsplash URLs stored in the DB. Before using any Unsplash URL, verify it returns HTTP 200:
```bash
curl -s -o /dev/null -w "%{http_code}" "https://images.unsplash.com/photo-XXXX?w=400"
```
If a URL returns 404, update it in both the seed data (`db.js`) and add a fix to the `brokenImages` array in the migration block so existing rows are patched on next startup.
