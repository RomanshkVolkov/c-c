# C&C — Command & Control

Monorepo for a self-hosted control plane that manages remote servers, Docker Swarm clusters, GitHub Actions secrets, and HTTP request collections.

## Services

| Folder | What it is | Stack | Port | Docs |
|---|---|---|---|---|
| [`app/`](./app) | Cross-platform desktop client | Tauri 2 + React 19 + Vite | — | [README](./app/README.md) |
| [`backend/`](./backend) | API for auth, servers, collections | Go + chi + GORM + Postgres | `8080` | [README](./backend/README.md) |
| [`swarm-manage/`](./swarm-manage) | Per-host agent that exposes Docker Swarm state | Go + chi + Docker socket | `9090` | [README](./swarm-manage/README.md) |
| [`infra/terraform/reports-media/`](./infra/terraform/reports-media) | Private S3 for report screenshots (no CDN) | Terraform + AWS | — | [README](./infra/terraform/reports-media/README.md) |

## Architecture

```
┌──────────────────────┐      HTTPS       ┌──────────────────────┐
│  app  (Tauri/React)  │ ───────────────▶ │  backend  (Go API)   │
│                      │                  │  cac.guz-studio.dev  │
│  - GitHub API direct │                  │  - Postgres          │
│  - HTTP client tool  │                  │  - JWT auth          │
│  - Crypto/image tools│                  │  - Servers, Collec.  │
└──────────────────────┘                  └──────────────────────┘
        │                                            │
        │ SSH/HTTP                                   │ (managed)
        ▼                                            ▼
┌──────────────────────┐                  ┌──────────────────────┐
│   user's VPS         │                  │   k8s cluster        │
│   docker swarm node  │ ◀── REST :9090 ──│   (deploys backend)  │
│   + swarm-manage     │                  │                      │
└──────────────────────┘                  └──────────────────────┘
```

- The **desktop app** is the user's primary interface. It talks to **backend** for persistent state (servers, users, request collections) and directly to **swarm-manage** agents on registered VPSes for live Docker data.
- **backend** runs in Kubernetes behind `cac.guz-studio.dev`. Auth is JWT (access + refresh).
- **swarm-manage** is deployed onto each registered VPS as a sidecar container, mounts `/var/run/docker.sock`, and exposes a read/write API over swarm primitives.

## CI/CD

GitHub workflows under `.github/workflows/`:

- `app-release.yml` — builds Tauri binaries (Linux/macOS/Windows) + signed updater artifacts on `release` publish.
- `backend.yml` — builds & pushes Docker image to GHCR, SSHs into k8s host to apply manifests. Triggers on `backend/**` push or manual dispatch.
- `swarm-manage.yml` — builds & pushes agent image on `swarm-manage/**` push.

## Integrations

- [Server-to-server](./docs/integrations/server-to-server.md) — how a tenant app runs its own bug board in cac with its project's ingest key: credential and what it reaches, operations, reporter vs assignee, webhook, rate limits, error codes. The contract, kept next to the code that implements it.
- [Capture widget](./widget/README.md) — the browser side: embeddable reporter, ingest key in the page, Origin allowlist.

## Proposals (not implemented)

- [Groups & multi-user sharing](./docs/proposals/groups-and-sharing.md) — evolution of the data model from single-user to group-based resource ownership.
- [Organizations + reports module](./docs/proposals/organizations-and-reports.md) — org scopes (separate the two companies across servers/collections) + multi-tenant bug-report tracker: Go ingest, Tauri triage console, embeddable capture widget, images via image-service, S3 via Terraform.

## Local development

Each service has its own setup — see the per-folder README. Quick start:

```bash
# Backend
cd backend && cp .env.example .env && air

# Swarm agent (requires Docker socket access)
cd swarm-manage && air

# Desktop app
cd app && bun install && bun run tauri dev
```

## License

Copyright © 2026 Romanshk Volkov.

- **Core** (`backend/`, `app/`, `swarm-manage/`, `infra/`) — [AGPL-3.0-or-later](LICENSE).
  Copyleft that also covers network use: if you run a modified version as a
  service, you must offer its source to its users.
- **Widget** (`widget/`, published as `@g-studio/report-widget`) —
  [MIT](widget/LICENSE). It is embedded into third-party sites, so it stays
  permissive: dropping it into your page never affects your own licensing.
