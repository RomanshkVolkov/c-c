# Observability — Grafana behind cac's authenticated proxy

Manifests for the platform hub's flagship integration (proposal F3). **Not applied
by CI**: the backend workflow only ships `backend/k8s/{0-rbac,2-deployment,3-service,4-http-route}.yaml`,
so everything here is applied deliberately by an operator.

## Design

- **Grafana is never exposed publicly.** The Service is `ClusterIP` and there is
  no Gateway/HTTPRoute. The only ways in are cac's authenticated proxy and
  `kubectl port-forward` (break-glass).
- **Auth is cac's.** cac validates your session, then asserts your identity to
  Grafana with `auth.proxy` (`X-WEBAUTH-USER`). The proxy strips any
  client-supplied `X-WEBAUTH-*`/`Authorization`, so a caller can't impersonate
  another user. Users are auto-created as Editors on first visit.
- **Config and datasources are code** (`01-config.yaml`), not UI clicks.
- **cac's RBAC stays read-only.** The backend never deploys or mutates the
  cluster; applying these manifests is a human/CI action.

## Apply

```sh
kubectl apply -f grafana/00-namespace.yaml

# 1) Break-glass admin password (only usable via port-forward).
kubectl -n observability create secret generic grafana-admin \
  --from-literal=password="$(openssl rand -base64 24)"

# 2) Config + workload. root_url is still a placeholder at this point.
kubectl apply -f grafana/01-config.yaml -f grafana/02-deployment.yaml
kubectl -n observability rollout status deployment/grafana
```

### 3) Register the integration in cac

In the desktop app: **Servers → (your kubernetes server) → Integrations → Add**

- kind: `grafana`
- name: `Grafana`
- url: `http://grafana.observability.svc.cluster.local:3000`
- authMethod: `header`

### 4) Point Grafana at its proxy path

Grafana must know the public prefix it is served under, which includes the cac
server and integration ids. Take the `path` returned by the launch action (or
build it as `/api/v1/servers/<serverId>/integrations/<integrationId>/proxy`) and
set `root_url` to `https://cac.guz-studio.dev` + that path:

```sh
PROXY_URL="https://cac.guz-studio.dev/api/v1/servers/<serverId>/integrations/<integrationId>/proxy"
sed "s#__CAC_PROXY_URL__#${PROXY_URL}#" grafana/01-config.yaml | kubectl apply -f -
kubectl -n observability rollout restart deployment/grafana
```

Then hit **Open** on the tile in cac — you land already signed in as your cac user.

> Until `root_url` is correct Grafana still loads through the proxy, but some
> self-generated links/redirects will point at the wrong prefix.

## Break-glass

```sh
kubectl -n observability port-forward deploy/grafana 3000:3000
# http://localhost:3000 — user: admin, password: from the grafana-admin secret
```

## Datasources

Uncomment the blocks in `01-config.yaml` and create the referenced secret:

```sh
kubectl -n observability create secret generic grafana-datasource-secrets \
  --from-literal=CNPG_READONLY_USER=grafana_ro \
  --from-literal=CNPG_READONLY_PASSWORD='...'
```

Use a **read-only** Postgres role, never the CNPG owner:

```sql
CREATE ROLE grafana_ro LOGIN PASSWORD '...';
GRANT CONNECT ON DATABASE cac TO grafana_ro;
GRANT USAGE ON SCHEMA public TO grafana_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO grafana_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO grafana_ro;
```

## Optional: metrics (Prometheus)

Grafana alone gives dashboards over existing data (CNPG). For cluster/pod metrics
add Prometheus. On a single-node VPS prefer a tuned install over defaults:

```sh
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm upgrade --install kps prometheus-community/kube-prometheus-stack \
  -n observability --create-namespace \
  --set alertmanager.enabled=false \
  --set grafana.enabled=false \
  --set prometheus.prometheusSpec.retention=7d \
  --set prometheus.prometheusSpec.resources.requests.memory=512Mi \
  --set prometheus.prometheusSpec.resources.limits.memory=1Gi
```

Budget ~1–1.5 GB RAM for Prometheus + exporters; check headroom
(`kubectl top nodes`) before installing. Then uncomment the Prometheus datasource
in `01-config.yaml`.

## Notes

- Pin/verify the Grafana image tag in `02-deployment.yaml` before applying.
- The PVC uses the cluster's default StorageClass; set `storageClassName` if you
  need a specific one.
- `strategy: Recreate` is deliberate: Grafana's SQLite DB is on a RWO volume and
  must never be opened by two pods.
