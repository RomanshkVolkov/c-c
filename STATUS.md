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
| swarm-manage per-task stats endpoint | `swarm-manage/internal/core/domain/swarm.go`, `swarm-manage/internal/core/repository/docker.go`, `swarm-manage/internal/core/service/swarm.go`, `swarm-manage/internal/adapters/handler/swarm.go`, `swarm-manage/internal/adapters/http/routes.go` | New `GET /api/v1/services/{id}/stats` proxying Docker's `/tasks` + `/containers/{id}/stats?stream=false` per running task. Computes CPU% from one-shot precpu sample; subtracts page cache from mem usage for a more RSS-like figure. Stats calls fan out concurrently (one goroutine per task). |
| Rebuilt deploy/update agent in the desktop app via SSH | `app/src-tauri/src/lib.rs`, `app/src/pages/Dashboard.tsx` | Two new Tauri commands `deploy_swarm_manage_agent` / `update_swarm_manage_agent` shell out to `ssh` with `BatchMode=yes` + `StrictHostKeyChecking=accept-new`. Auth comes from the OS SSH agent (1Password via `SSH_AUTH_SOCK`), no keys stored anywhere. Dashboard regains the Deploy/Update buttons but now calls these local commands instead of the removed backend endpoints. |

## ⏳ Planned (next iterations)

### App UI for container stats

Backend endpoint exists (above). Now consume it from `app/src/pages/ServerManage.tsx`:

- Per-service stats table: CPU%, RAM (used / limit), Net Rx/Tx, Block R/W per task.
- Poll `/api/v1/services/{id}/stats` every ~5s while the panel is open. Stop polling on navigation away.
- Show a per-row error badge when the agent returned `error` for that task (means Docker stats call failed but task exists).
- Pre-requisite: the new `swarm-manage` image (built from the in-progress endpoint) must be rolled out to each server via the "Update Agent" button.

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
