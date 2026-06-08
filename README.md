# C&C — Command & Control

Monorepo for a self-hosted control plane that manages remote servers, Docker Swarm clusters, GitHub Actions secrets, and HTTP request collections.

## Services

| Folder | What it is | Stack | Port | Docs |
|---|---|---|---|---|
| [`app/`](./app) | Cross-platform desktop client | Tauri 2 + React 19 + Vite | — | [README](./app/README.md) |
| [`backend/`](./backend) | API for auth, servers, collections | Go + chi + GORM + Postgres | `8080` | [README](./backend/README.md) |
| [`swarm-manage/`](./swarm-manage) | Per-host agent that exposes Docker Swarm state | Go + chi + Docker socket | `9090` | [README](./swarm-manage/README.md) |

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

## Proposals (not implemented)

- [Groups & multi-user sharing](./docs/proposals/groups-and-sharing.md) — evolution of the data model from single-user to group-based resource ownership.

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
