# STATUS

Tracking doc — open items, in-progress work, and decisions from rolling conversations. Update this file when you start/finish work or change direction.

## 🚨 User action required

| Item | Context | Owner |
|---|---|---|
| Update GitHub repo secret `DATABASE_URL` with the rotated Postgres password | Backend pod is currently in CrashLoopBackOff (`/health` returns 503). The k8s secret gets regenerated from this GitHub secret on every deploy. Until rotated, the `backend` workflow + manual `workflow_dispatch` will redeploy with a dead credential. | jose |
| (After above) Re-run the `backend` GitHub workflow | Actions → `backend` → "Run workflow" — now possible because we added `workflow_dispatch`. | jose |
| Verify 1Password reference works | Have the user's GitHub PAT 1Password item handy. Reference looks like `op://Personal/My-GitHub/credential`. The new "Load from 1Password" button in the Stack Secrets page reads it via `op read`. Requires `op` CLI installed + signed in. | jose |

## 🟡 In progress (uncommitted)

| Item | Files | Notes |
|---|---|---|
| Per-folder documentation | `README.md`, `app/README.md`, `backend/README.md`, `swarm-manage/README.md` | Replaces the default Tauri stub; new READMEs for backend + swarm-manage. |
| Backend SSH-key removal (A) | `backend/internal/...`, `backend/go.{mod,sum}`, `app/src/{hooks,types,components,pages}/...` | Backend no longer accepts or stores SSH keys; `deploy-agent`/`update-agent` endpoints + handlers + service + repo helpers removed; deps `zalando/go-keyring` + `golang.org/x/crypto/ssh` dropped from `go.mod`. Frontend caller hook + dialog field + dashboard buttons removed. |
| GitHub PAT via 1Password (B) | `app/src-tauri/src/lib.rs`, `app/src/pages/StackSecrets.tsx` | New Rust commands `load_github_token_from_1password`, `refresh_github_token_from_1password`, `get_op_reference`, `clear_op_reference`. Uses `op read --no-newline <ref>` via `std::process::Command` (no extra Tauri plugin). UI in Stack Secrets page gets a 1Password reference input + Load/Refresh buttons above the manual-paste fallback. Op reference is stored in the OS keychain under `op-reference:<server_id>`. |
| Groups proposal (C) | `docs/proposals/groups-and-sharing.md`, links in `README.md` + `app/README.md` | Doc-only, no implementation. |
| This file | `STATUS.md` | — |

## ⏳ Planned (next iterations)

### Rebuild `deploy-agent` / `update-agent` from the app side

Once the dead backend SSH path is committed, rebuild deploy/update agent in the desktop app:

- App shells out to `ssh` CLI via `tauri-plugin-shell` (or `std::process::Command` for simplicity).
- 1Password SSH agent (`SSH_AUTH_SOCK`) takes over key handling transparently — no key code in our app.
- Per-server "Deploy Agent" / "Update Agent" actions in the dashboard, calling local SSH directly to the host stored in DB metadata.
- Initially no host-key verification (current backend used `InsecureIgnoreHostKey`); when we rebuild it on the app side, store + verify host keys properly.

## 💭 Future / nice-to-have

- **Scrub rotated DB password from git history** (`git filter-repo` + force push). Credentials in `78d0129` and `769e592` are already rotated and inert; only do this for hygiene if it matters. Destructive — rewrites public SHAs.
- **Audit other places that may rely on go-keyring on the backend.** Removed for SSH keys; none known to remain.
- **Per-server PATs.** Today the GitHub PAT is shared globally (`PATK_global_usage`). When multi-server / multi-org becomes a thing, the 1Password reference should be stored per `server_id` rather than once globally. The keychain layer already supports that (the `ref_account(server_id)` function in `lib.rs`); only the UI assumes a single global key.

## ✅ Done (this thread)

| Commit | What | Why |
|---|---|---|
| `8f0fad1` | `createUpdaterArtifacts: true` in Tauri config + trailing slash on collections list/create calls | Updater was 404-ing because no `latest.json`/`.sig` artifacts were being produced; collections list/create were 404-ing because chi registers `r.Get("/", ...)` with trailing slash. |
| `7133059` | Untrack `backend/.env` and `backend/tmp/`; add `backend/.gitignore` covering `.env` + `tmp/` | Stop accidental commits of secrets and Air's build artifact. Existing credentials in history were already rotated. |
| `54d5840` | `workflow_dispatch` on the backend workflow | Enables manual re-deploys without dummy commits to `backend/**`. |
