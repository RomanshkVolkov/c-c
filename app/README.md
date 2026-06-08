# app — Desktop Client

Cross-platform desktop application built with **Tauri 2** + **React 19** + **TypeScript** + **Vite**. The primary user interface of the C&C control plane.

## Features

- **Server management** — register remote VPSes, store SSH creds in the OS keychain.
- **Docker Swarm UI** — list stacks/services/nodes, stream service logs, force rolling updates (via [`swarm-manage`](../swarm-manage) agent on each host).
- **GitHub Actions secrets manager** — read/write repo secrets and variables using sealed-box encryption (libsodium).
- **HTTP request client** — Postman-style request collections with folders, sharing across users.
- **Crypto tools** — hash (SHA/MD5/HMAC), JWT decode, bcrypt/argon2, ID generators (UUID/CUID2), encoders.
- **Image compression** — resize and re-encode to WebP.
- **Auto-updater** — signed updater artifacts pulled from GitHub Releases (`latest.json` + `.sig`).

## Tech stack

| Layer | Tool |
|---|---|
| UI | React 19, TailwindCSS, shadcn/ui, React Router v7, lucide-react |
| State | Zustand |
| Build | Vite + Bun |
| Desktop runtime | Tauri 2 (Rust) |
| Tauri plugins | `http`, `dialog`, `fs`, `updater`, `process`, `opener` |
| Rust crates | `reqwest`, `crypto_box`, `image`, `webp`, `jsonwebtoken`, `keyring` |

## Folder layout

```
app/
├── src/                          # React frontend
│   ├── main.tsx                  # ReactDOM entry
│   ├── App.tsx                   # Router setup
│   ├── pages/                    # Route-level views
│   │   ├── Login.tsx
│   │   ├── Dashboard.tsx         # Server overview
│   │   ├── ServerManage.tsx      # Stack/service detail per server
│   │   ├── StackSecrets.tsx      # GitHub secrets/vars
│   │   ├── ImageTool.tsx         # WebP compressor
│   │   ├── CryptoTools.tsx       # Hash/JWT/bcrypt/etc.
│   │   └── RequestClient.tsx     # HTTP client + collections
│   ├── components/
│   │   ├── AppLayout.tsx         # Sidebar shell
│   │   ├── AppSidebar.tsx
│   │   ├── ProtectedRoute.tsx    # Auth guard
│   │   ├── UpdateChecker.tsx     # Updater toast
│   │   └── ui/                   # shadcn primitives
│   ├── store/                    # Zustand stores
│   │   ├── auth.store.ts
│   │   ├── collections.store.ts  # Request collections (owned + shared)
│   │   ├── requests.store.ts     # In-flight HTTP request state
│   │   └── updater.store.ts
│   ├── hooks/                    # use-auth, use-servers, use-swarm
│   ├── lib/
│   │   ├── api.ts                # fetch wrapper with auto-refresh on 401
│   │   └── utils.ts
│   └── types/                    # DTO definitions
├── src-tauri/                    # Rust backend
│   ├── src/
│   │   ├── main.rs               # Entry
│   │   ├── lib.rs                # Tauri command registry + token cache
│   │   ├── http_client.rs        # Generic HTTP send used by RequestClient
│   │   ├── crypto_tools.rs       # Hash/JWT/bcrypt/argon2/ID gen commands
│   │   └── image.rs              # Compression command
│   ├── tauri.conf.json           # App config + updater endpoint
│   ├── capabilities/default.json # Permissions
│   └── Cargo.toml
├── package.json
├── vite.config.ts
└── tsconfig.json
```

## API contract

The frontend talks to the backend at `VITE_API_URL` (default `https://cac.guz-studio.dev`). The fetch wrapper at `src/lib/api.ts` handles JWT injection + auto-refresh on `expired-token`.

**Note on trailing slashes:** chi's `r.Get("/", ...)` registers routes with a trailing slash. Always call `/api/v1/<resource>/` (with slash) for list/create endpoints. ID-scoped endpoints (`/api/v1/<resource>/{id}`) don't need it.

## Local development

```bash
bun install
bun run tauri dev              # launches Vite + Tauri window
```

Set `app/.env.local` with `VITE_API_URL=http://localhost:8080` to point at a locally running backend.

## Build & release

Releases are cut by publishing a `vX.Y.Z` GitHub release. The `app-release.yml` workflow:

1. Syncs version from the tag into `tauri.conf.json` + `Cargo.toml`.
2. Builds for Linux (`.deb`/`.AppImage`/`.rpm`), macOS (universal `.dmg` + `.app.tar.gz`), Windows (NSIS `.exe`).
3. Signs all bundles with `TAURI_SIGNING_PRIVATE_KEY` (requires `bundle.createUpdaterArtifacts: true` in `tauri.conf.json`).
4. Uploads bundles + `.sig` files + `latest.json` to the release.

The installed app polls `https://github.com/RomanshkVolkov/c-c/releases/latest/download/latest.json` every 30 min via the `UpdateChecker` component.

## Related proposals

- [Groups & multi-user sharing](../docs/proposals/groups-and-sharing.md) — future model for multi-user resource ownership. Currently the app assumes a single user.

## Tauri capabilities

`src-tauri/capabilities/default.json` declares:

- `http:allow-fetch` → `https://**`, `http://**` (GitHub API, user-supplied URLs)
- `fs:allow-write` → `$DOWNLOAD/**`, `$HOME/**` (image exports)
- `dialog:allow-save`, `opener:default`, `updater:default`, `process:allow-restart`
