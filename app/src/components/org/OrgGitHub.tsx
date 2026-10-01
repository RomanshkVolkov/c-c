import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ExternalLink, Github, Loader2, RefreshCw } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useT } from "@/lib/i18n";
import { api } from "@/lib/api";
import { phraseFor } from "@/lib/server-errors";
import { useOrgsStore } from "@/store/orgs.store";
import { useTasksStore } from "@/store/tasks.store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { APIResponse } from "@/types/auth";
import type { GitHubRepo, GitHubStatus } from "@/types/github";

/**
 * La GitHub App de esta org: qué cuentas de GitHub la tienen instalada, y a
 * qué espacio va cada repo.
 *
 * Un repo enlazado a un espacio deja una línea en la tarea que nombre cada
 * commit o PR (`cac#12`, o el folio del cliente). Las líneas son internas: el
 * cliente no lee los mensajes de commit del equipo. Un repo sin enlazar no
 * hace nada, y así empieza cada uno.
 */
export default function OrgGitHub({ canManage }: { canManage: boolean }) {
  const { t } = useT();
  const orgId = useOrgsStore((s) => s.currentOrgId);
  const tree = useTasksStore((s) => s.tree);
  const fetchTree = useTasksStore((s) => s.fetchTree);
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const base = `/api/v1/organizations/${orgId}/github`;

  const load = useCallback(async () => {
    if (!orgId) return;
    try {
      const res = await api.get<APIResponse<GitHubStatus>>(`${base}/`, true);
      if (res?.success && res.data) setStatus(res.data);
    } catch (e) {
      toast.error(phraseFor(e instanceof Error ? e.message : String(e), t("org:github.loadFailed")));
    }
  }, [orgId, base, t]);

  useEffect(() => {
    void load();
    if (tree.length === 0) void fetchTree().catch(() => {});
  }, [load, tree.length, fetchTree]);

  // Los espacios con tareas de esta org: la sala «general» no tiene.
  const spaces = tree.filter((s) => s.orgId === orgId && s.kind !== "general");

  const connect = async () => {
    setBusy(true);
    try {
      const res = await api.post<APIResponse<{ url: string }>>(`${base}/link`, {}, true);
      if (!res?.success || !res.data) throw new Error(res?.error ?? "github-off");
      await openUrl(res.data.url);
      toast.info(t("org:github.finishInBrowser"));
    } catch (e) {
      toast.error(phraseFor(e instanceof Error ? e.message : String(e), t("org:github.connectFailed")));
    } finally {
      setBusy(false);
    }
  };

  const update = async (repo: GitHubRepo, patch: Partial<Pick<GitHubRepo, "spaceId" | "bareRefs">>) => {
    const next = { spaceId: repo.spaceId, bareRefs: repo.bareRefs, ...patch };
    try {
      const res = await api.patch<APIResponse<GitHubRepo>>(`${base}/repos/${repo.id}`, next, true);
      if (!res?.success || !res.data) throw new Error(res?.error ?? "github");
      const saved = res.data;
      setStatus((s) => (s ? { ...s, repos: s.repos.map((r) => (r.id === saved.id ? saved : r)) } : s));
    } catch (e) {
      toast.error(phraseFor(e instanceof Error ? e.message : String(e), t("org:github.saveFailed")));
    }
  };

  if (!status) {
    return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
  }
  if (!status.configured) {
    return <p className="text-sm text-muted-foreground">{t("org:github.notConfigured")}</p>;
  }

  return (
    <div className="max-w-3xl space-y-4">
      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">{t("org:github.lead")}</p>
        <p className="text-xs text-muted-foreground">{t("org:github.syntax")}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {status.installations.map((i) => (
          <Badge key={i.id} variant="secondary" className="gap-1">
            <Github className="size-3" /> {i.accountLogin || i.installationId}
          </Badge>
        ))}
        {status.installations.length === 0 && (
          <span className="text-sm text-muted-foreground">{t("org:github.noInstallations")}</span>
        )}
        <span className="flex-1" />
        <Button variant="ghost" size="sm" onClick={() => void load()} aria-label={t("org:github.reload")}>
          <RefreshCw className="size-3.5" />
        </Button>
        {canManage && (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void connect()}>
            <ExternalLink className="mr-1 size-3.5" />
            {status.installations.length === 0 ? t("org:github.connect") : t("org:github.connectAnother")}
          </Button>
        )}
      </div>

      {status.repos.length > 0 && (
        <ul className="divide-y rounded-md border">
          {status.repos.map((repo) => (
            <li key={repo.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{repo.fullName}</span>
              <select
                aria-label={t("org:github.spaceFor", { repo: repo.fullName })}
                className="h-8 rounded-md border bg-background px-2 text-sm"
                disabled={!canManage}
                value={repo.spaceId}
                onChange={(e) => void update(repo, { spaceId: e.target.value })}
              >
                <option value="">{t("org:github.notLinked")}</option>
                {spaces.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title={t("org:github.bareRefsHint")}>
                <input
                  type="checkbox"
                  checked={repo.bareRefs}
                  disabled={!canManage || !repo.spaceId}
                  onChange={(e) => void update(repo, { bareRefs: e.target.checked })}
                />
                {t("org:github.bareRefs")}
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
