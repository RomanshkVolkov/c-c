# STATUS

Tracking doc — open items, in-progress work, and decisions from rolling conversations. Update this file when you start/finish work or change direction.

## 🚨 User action required

| Item | Context | Owner |
|---|---|---|
| Cut a new app release tag | The backend now rejects `sshPrivateKey` on `POST /api/v1/servers/` and the `deploy-agent`/`update-agent` endpoints are gone. Any installed app older than commit `36c870e` will break when interacting with servers. | jose |
| Verify 1Password reference works on next release | The new "Load from 1Password" button in the Stack Secrets page reads via `op read op://Vault/Item/credential`. Requires `op` CLI installed + signed in. Smoke-test once the new release is installed. | jose |

## 🟡 In progress (uncommitted)

| Item | Files | Notes |
|---|---|---|
| Rename `productName` to `CAC` (drop `&`) | `app/src-tauri/tauri.conf.json` | Works around the `tauri-action@v0.6.2` sanitizer inconsistency that was preventing `latest.json` from being uploaded. Window title in `app.windows[0].title` keeps `&` — only the bundle/binary name changes. Takes effect on the next release tag. |

## ⏳ Planned (next iterations)

### Container resource usage per server

Surface per-container resource usage (CPU / memory / network / disk I/O) for the containers running on each stored server.

- New endpoint on `swarm-manage`: `GET /api/v1/services/{id}/stats` and/or `GET /api/v1/containers/{id}/stats` that proxies Docker's `/containers/{id}/stats?stream=false` (or streams it).
- Frontend page or section under `ServerManage.tsx`: live table per service/task with rolling stats.
- Decide: pull-on-demand (cheap, no daemon load) vs. SSE/WebSocket streaming (smoother UI, more cost). Default to on-demand polling at ~5s intervals while the page is open.

### Rebuild `deploy-agent` / `update-agent` from the app side

Once the dead backend SSH path is committed, rebuild deploy/update agent in the desktop app:

- App shells out to `ssh` CLI via `tauri-plugin-shell` (or `std::process::Command` for simplicity).
- 1Password SSH agent (`SSH_AUTH_SOCK`) takes over key handling transparently — no key code in our app.
- Per-server "Deploy Agent" / "Update Agent" actions in the dashboard, calling local SSH directly to the host stored in DB metadata.
- Initially no host-key verification (current backend used `InsecureIgnoreHostKey`); when we rebuild it on the app side, store + verify host keys properly.

## 💭 Future / nice-to-have

- **File upstream bug at `tauri-apps/tauri-action`.** The inconsistent sanitization in `upload-version-json.ts` (uses `[ ()[\]{}]` → `.`) vs. `ghAssetName` (uses `[^a-zA-Z0-9_-]` → `.`) means any `productName` with chars like `&`, `+`, `@`, etc. breaks `latest.json` upload silently. Worth a PR to align the sanitizers.
- **Existing C&C installs won't auto-migrate** to the new `CAC` install path. On a new release tag, users will end up with two installs side by side (old `C&C` and new `CAC`). Document the manual cleanup step when we cut the release.
- **Scrub rotated DB password from git history** (`git filter-repo` + force push). Credentials in `78d0129` and `769e592` are already rotated and inert; only do this for hygiene if it matters. Destructive — rewrites public SHAs.
- **Audit other places that may rely on go-keyring on the backend.** Removed for SSH keys; none known to remain.
- **Per-server PATs.** Today the GitHub PAT is shared globally (`PATK_global_usage`). When multi-server / multi-org becomes a thing, the 1Password reference should be stored per `server_id` rather than once globally. The keychain layer already supports that (the `ref_account(server_id)` function in `lib.rs`); only the UI assumes a single global key.

## ✅ Done (this thread)

| Commit | What | Why |
|---|---|---|
| `8f0fad1` | `createUpdaterArtifacts: true` in Tauri config + trailing slash on collections list/create calls | Updater was 404-ing because no `latest.json`/`.sig` artifacts were being produced; collections list/create were 404-ing because chi registers `r.Get("/", ...)` with trailing slash. |
| `7133059` | Untrack `backend/.env` and `backend/tmp/`; add `backend/.gitignore` covering `.env` + `tmp/` | Stop accidental commits of secrets and Air's build artifact. Existing credentials in history were already rotated. |
| `54d5840` | `workflow_dispatch` on the backend workflow | Enables manual re-deploys without dummy commits to `backend/**`. |
| `94c450c` | Per-folder READMEs (root, app, backend, swarm-manage), `STATUS.md`, groups proposal under `docs/proposals/` | Replace default Tauri stub README; document architecture and CI/CD; sketch multi-user evolution. |
| `a667a4a` | Remove backend SSH key storage + `deploy-agent`/`update-agent` endpoints; drop `zalando/go-keyring` and `golang.org/x/crypto/ssh` | Keyring path was dead on a Linux k8s pod; SSH-from-app will replace it. |
| `36c870e` | Drop frontend deploy/update-agent UI (hook fns, dialog field, dashboard buttons) | Backend endpoints gone — UI followed. |
| `47dcae7` | Tauri commands `load_github_token_from_1password` / `refresh_*` / `get_op_reference` / `clear_op_reference`; UI in Stack Secrets for "Load from 1Password" + "Refresh" using `op read`. Reference stored in OS keychain as `op-reference:<server_id>`. | Streamline PAT entry — user no longer copy-pastes from 1Password. |
| (manual) | Rotated GitHub secret `DATABASE_URL` + redeployed backend via `workflow_dispatch` | `/health` returns 200 again. |
