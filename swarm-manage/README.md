# swarm-manage — Docker Swarm Agent

Per-host **Go + chi** agent that exposes Docker Swarm primitives over a REST API. Runs on each registered VPS, mounts the Docker socket, and is reached directly from the desktop app.

## Responsibilities

- List Docker Swarm stacks, services, and nodes.
- Stream service logs over HTTP chunked transfer.
- Force rolling updates (`ForceUpdate`) of a service.
- Health probe.

No database, no authentication — meant to sit behind a trusted network (firewall + VPN) or be exposed only to the backend/desktop app over SSH-tunneled HTTP.

## Folder layout (hexagonal)

```
swarm-manage/
├── cmd/
│   └── main.go                       # HTTP server :9090, graceful shutdown
├── internal/
│   ├── core/
│   │   ├── domain/
│   │   │   ├── swarm.go              # Stack, Service, ServiceReplicas, Node
│   │   │   └── response.go           # APIResponse envelope
│   │   ├── service/
│   │   │   └── swarm.go              # ListStacks, ListServices, ListNodes,
│   │   │                             # StreamLogs, ForceUpdateService
│   │   └── repository/
│   │       └── docker.go             # Docker socket HTTP client (no SDK)
│   └── adapters/
│       ├── handler/
│       │   └── swarm.go              # Per-route handlers
│       ├── http/
│       │   └── routes.go             # chi router, route mounting
│       └── middleware/
│           └── middleware.go         # CORS, Logger, Recovery
├── docker-compose.yml                # Reference deployment (mounts /var/run/docker.sock)
├── Dockerfile                        # Multi-stage Alpine, exposes :9090
├── .air.toml
├── go.mod / go.sum
```

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | `{"status":"healthy","agent":"swarm-manage"}` |
| `GET` | `/api/v1/stacks` | List stacks (grouped via `com.docker.stack.namespace` label) |
| `GET` | `/api/v1/stacks/{stack}/services` | List services in a stack |
| `GET` | `/api/v1/services` | List all services |
| `GET` | `/api/v1/nodes` | List swarm nodes (role/status/availability) |
| `GET` | `/api/v1/services/{id}/logs` | Stream logs (chunked, no timeout) |
| `POST` | `/api/v1/services/{id}/force-update` | Trigger rolling update |

## Docker socket access

`repository/docker.go` opens a raw HTTP-over-Unix-socket connection to `/var/run/docker.sock`. It pings `/_ping` on startup to negotiate the API version. No `github.com/docker/docker` SDK dependency — the module is intentionally minimal.

## Deployment

Designed to run as a container on each swarm manager node:

```yaml
services:
  swarm-manage:
    image: ghcr.io/g-studio-labs/c-c/swarm-manage:latest
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    ports:
      - "9090:9090"
    restart: unless-stopped
```

The desktop app deploys this onto a server via the backend endpoint `POST /api/v1/servers/{id}/deploy-agent` (which SSHes in and `docker run`s the image). Updates use `POST /api/v1/servers/{id}/update-agent`.

## Local development

Requires Docker running locally with swarm initialized:

```bash
docker swarm init
air                                  # http://localhost:9090/health
```

## CI

`.github/workflows/swarm-manage.yml` builds and pushes `ghcr.io/g-studio-labs/c-c/swarm-manage:latest` on changes to `swarm-manage/**`. The agent is pulled by the deploy-agent flow above — no separate manifest application.
