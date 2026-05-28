# k8s-eso-shop

[![build](https://github.com/aslancarlos/k8s-eso-shop/actions/workflows/build.yml/badge.svg)](https://github.com/aslancarlos/k8s-eso-shop/actions/workflows/build.yml) [![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Demo e-commerce application that proves the full **External Secrets Operator → IDIRA Secrets Manager** secret chain on Kubernetes. Every credential the app touches — DB host, user, password — is fetched from IDIRA at runtime via ESO, never stored in source code or baked into images.

> **2026-05-27 — rebrand & theme** · Visual language now follows [paloaltonetworks.com/idira](https://www.paloaltonetworks.com/idira): Onest typography + IBM Plex Mono, IDIRA palette (`#0067ff` blue / `#fa582d` orange), **dark + light theme** with a sun/moon toggle in the nav (persists to `localStorage`, falls back to `prefers-color-scheme`). Skip-to-content link, visible focus rings, and `prefers-reduced-motion` support (WCAG 2.4.1 / 2.3.3). Implemented in [`src/views/partials/head.ejs`](src/views/partials/head.ejs) and [`public/style.css`](public/style.css).

Live at: `https://demo.minha.cloud/k8s-eso/`

---

## What this demonstrates

| Capability | How |
|---|---|
| Zero-hardcoded secrets | All DB creds via ESO → IDIRA Secrets Manager JWT auth |
| Secret rotation | ESO polls every 1 min; Python operator triggers zero-downtime rolling restart |
| Production-grade K8s | PodDisruptionBudget, rolling update, liveness/readiness/startup probes |
| OWASP hardening | Security headers, CSP, rate limiting, atomic DB operations |
| i18n | PT (default) / EN / ES, cookie-persisted |
| Theme | Dark + light, user-toggleable, system-preference fallback |

---

## Architecture

```
Browser
   │  HTTPS
   ▼
nginx Ingress (nginx-internal, TLS via cert-manager)
   │  /k8s-eso/*  →  strip prefix
   ▼
Node.js / Express app  (3 replicas, port 3000)
   │  mysql2 pool
   ▼
MySQL 8  (external RDS)
   │
   │  DB_HOST / DB_USER / DB_PASS
   │  mounted as env vars from K8s Secret
   ▼
K8s Secret  eso-shop-db-creds  (namespace: eso-shop)
   │
   │  created & refreshed every 1 min by
   ▼
External Secrets Operator v2.1  (ClusterSecretStore: conjur-store)
   │
   │  JWT auth (eks-latam authenticator)
   │  ServiceAccount: springboot-app / eso-shop-sa
   ▼
CyberArk Conjur Cloud  (latamlab.secretsmgr.cyberark.cloud)
   └── data/vault/dev-demo-aslan/dbuser_dual/{username,password,address}


Python Operator (eso-shop-operator)
   │  watches eso-shop-db-creds for resourceVersion changes
   │  on change → PATCH deployment annotation → rolling restart
   └── exposes /status JSON consumed by the live dashboard
```

---

## Stack

| Layer | Technology |
|---|---|
| App | Node.js 20, Express 4, EJS templates |
| Database | MySQL 8 (external) |
| Secret management | External Secrets Operator v2.1 |
| Secret vault | CyberArk Conjur Cloud |
| Custom operator | Python 3.12, `kubernetes` SDK |
| Container | Docker (linux/amd64) |
| Orchestration | Kubernetes (EKS) |
| Ingress | nginx-ingress (`nginx-internal` class) |
| TLS | cert-manager + cloud-venafi-issuer |

---

## Project structure

```
├── src/
│   ├── server.js           # Express app — all routes, security middleware
│   ├── db.js               # MySQL pool, auto-migration on startup, seed data
│   ├── i18n.js             # Lightweight i18n (no external deps)
│   ├── locales/
│   │   ├── pt.json         # Portuguese (default)
│   │   ├── en.json
│   │   └── es.json
│   └── views/
│       ├── index.ejs       # Home — featured products
│       ├── products.ejs    # Full catalog with category filter
│       ├── orders.ejs      # Order list
│       ├── order-detail.ejs
│       ├── secrets-info.ejs  # Live ESO/Conjur status + YAML reference
│       ├── dashboard.ejs   # Live K8s dashboard (pods, DB, operator)
│       └── partials/
│           ├── head.ejs    # Nav + language switcher
│           └── foot.ejs
├── public/
│   └── style.css
├── operator/               # Python secret-watcher operator
│   ├── main.py
│   ├── requirements.txt
│   └── Dockerfile
├── k8s/                    # All Kubernetes manifests
│   ├── namespace.yaml
│   ├── serviceaccount.yaml
│   ├── deployment.yaml     # 3 replicas, rolling update, probes, resource limits
│   ├── ingress.yaml
│   ├── external-secret.yaml
│   ├── cluster-secret-store.yaml
│   ├── eso-rbac.yaml       # ESO token-request RBAC
│   ├── pdb.yaml            # PodDisruptionBudget (minAvailable: 2)
│   ├── conjur-policy.yml   # Conjur policy to apply before deploying
│   └── operator/
│       ├── deployment.yaml
│       ├── rbac.yaml
│       └── service.yaml
├── Dockerfile
└── package.json
```

---

## Local development

**Prerequisites:** Node.js 20+, MySQL 8+

```bash
npm install

export DB_HOST=127.0.0.1
export DB_USER=root
export DB_PASS=yourpassword
export DB_NAME=myappDB

npm run dev        # node --watch src/server.js
```

The app auto-creates tables and seeds sample products and orders on first startup. No separate migration step needed.

Open `http://localhost:3000`.

---

## Kubernetes deployment

**Prerequisites:**
- EKS cluster with ESO v2.1 installed (`external-secrets` namespace)
- CyberArk Conjur Cloud tenant with `authn-jwt/eks-latam` authenticator enabled
- `dockerhub-pull` imagePullSecret in `eso-shop` namespace
- `k8scert` TLS secret in `conjur` namespace (cert-manager + cloud-venafi-issuer)

### 1. Apply Conjur policy

Load `k8s/conjur-policy.yml` in the Conjur UI or via CLI to grant the `eso-shop-sa` service account read access to the DB variables.

### 2. Deploy everything

```bash
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/serviceaccount.yaml
kubectl apply -f k8s/eso-rbac.yaml
kubectl apply -f k8s/cluster-secret-store.yaml
kubectl apply -f k8s/external-secret.yaml
kubectl apply -f k8s/operator/
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/ingress.yaml
kubectl apply -f k8s/pdb.yaml
```

### 3. Verify the secret chain

```bash
# ESO must show READY=True
kubectl get externalsecret -n eso-shop

# Secret must exist with the three keys
kubectl get secret eso-shop-db-creds -n eso-shop -o jsonpath='{.data}' | base64 -d

# App must be fully rolled out
kubectl rollout status deployment/eso-shop -n eso-shop
```

---

## Environment variables

All DB credentials are injected from `eso-shop-db-creds` via `envFrom.secretRef`. The remaining vars are set directly in `k8s/deployment.yaml`.

| Variable | Source | Description |
|---|---|---|
| `DB_HOST` | K8s Secret (ESO) | MySQL host / IP |
| `DB_USER` | K8s Secret (ESO) | MySQL user |
| `DB_PASS` | K8s Secret (ESO) | MySQL password |
| `DB_NAME` | Deployment env | Database name (default: `myappDB`) |
| `PORT` | Deployment env | HTTP port (default: `3000`) |
| `BASE_PATH` | Deployment env | URL prefix served under (default: `/k8s-eso`) |
| `OPERATOR_URL` | Deployment env | Internal URL of the Python operator |
| `POD_NAMESPACE` | `fieldRef` | Auto-injected from pod metadata |
| `SECRET_NAME` | Deployment env | K8s secret name the operator watches |

---

## Secret-watcher operator

The Python operator in `operator/` runs as a separate deployment (`eso-shop-operator`) with a scoped Role that grants only `get/list/watch` on `eso-shop-db-creds` and `get/patch` on the `eso-shop` deployment.

**What it does:**
1. Streams watch events on `eso-shop-db-creds` via the Kubernetes API
2. On `MODIFIED` with a new `resourceVersion` → patches the deployment with `eso-operator/restartedAt` annotation
3. The annotation change triggers a rolling restart, cycling pods onto the new credentials
4. Exposes `/status` JSON (pod list, deployment state, restart history) consumed by the dashboard

**Operator RBAC is least-privilege by design** — it cannot read secret data, only watch metadata.

---

## API endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Home — featured products |
| `GET` | `/products` | Full catalog; `?category=Electronics` to filter |
| `GET` | `/orders` | Order list |
| `GET` | `/orders/:id` | Order detail |
| `POST` | `/orders` | Create order (rate-limited: 10/min per IP) |
| `GET` | `/secrets-info` | Live ESO/Conjur status + YAML reference |
| `GET` | `/dashboard` | Live K8s dashboard UI |
| `GET` | `/api/dashboard` | Dashboard JSON (pods, DB, operator, events) |
| `GET` | `/health` | `{"status":"ok"}` — liveness/readiness probe |

---

## Security

Applied as part of the codebase, not as an afterthought:

- **No secrets in source** — all credentials fetched at runtime via ESO
- **Security headers** — `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, `Content-Security-Policy`
- **`X-Powered-By` disabled** — no technology fingerprinting
- **Rate limiting** — `POST /orders` capped at 10 requests/min per IP (in-memory, per pod)
- **Atomic stock decrement** — `UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?` prevents negative stock under concurrent load
- **Cookie hardening** — `eso_lang` cookie: `httpOnly`, `secure` (auto-detected via `x-forwarded-proto`), `sameSite: lax`
- **Parameterized queries** — all DB queries use `mysql2` prepared statements

---

## i18n

Language detection priority: `?lang=xx` query param → `eso_lang` cookie → `Accept-Language` header → `pt` (default).

Supported: `pt`, `en`, `es`. Translation files live in `src/locales/`. The middleware is a ~40-line custom module with no external dependencies.
