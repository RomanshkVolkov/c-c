import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2 } from "lucide-react";
import { useT } from "@/lib/i18n";
import { desde } from "@/lib/desde";
import { GITHUB_PAT_KEY, repoOfDeployable } from "@/lib/github-repo";
import { useDeploymentsStore } from "@/store/deployments.store";
import { Badge } from "@/components/ui/badge";
import type { Deployable } from "@/types/deploy";

/** Un commit como lo devuelve `list_github_commits`. */
export interface CommitSummary {
  sha: string;
  message: string;
  author: string;
  date: string;
}

const NADA: never[] = [];

/**
 * Elegir qué desplegar de una lista, en vez de ir a GitHub a copiar un sha.
 *
 * Son los últimos commits de la rama por defecto del repo, con el PAT de la
 * app. Los que ya tienen imagen publicada (porque el CI avisó) se marcan, y al
 * elegir uno de ellos se despliega el sha **con el que se publicó** —corto o
 * entero—, que es el tag que existe.
 *
 * Sin PAT o sin repo no hay lista, y queda el campo de escribir un sha.
 */
export default function CommitPicker({
  deployable,
  selected,
  onSelect,
}: {
  deployable: Deployable;
  selected: string;
  onSelect: (sha: string) => void;
}) {
  const { t } = useT();
  const builds = useDeploymentsStore((s) => s.builds[deployable.id] ?? NADA);
  const [commits, setCommits] = useState<CommitSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const target = repoOfDeployable(deployable);

  useEffect(() => {
    let alive = true;
    const [owner, repo] = target.split("/");
    if (!owner || !repo) {
      setCommits(null);
      return;
    }
    setLoading(true);
    (async () => {
      try {
        if (!(await invoke<boolean>("github_token_configured", { serverId: GITHUB_PAT_KEY }))) {
          if (alive) setCommits(null);
          return;
        }
        const list = await invoke<CommitSummary[]>("list_github_commits", { serverId: GITHUB_PAT_KEY, owner, repo });
        if (alive) setCommits(list);
      } catch {
        if (alive) setCommits(null);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [target]);

  // El tag con el que se publicó cada commit, si se publicó.
  const published = (sha: string) => builds.find((b) => sha.startsWith(b.sha))?.sha;

  if (loading) return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
  if (!commits || commits.length === 0) return null;

  return (
    <div className="space-y-1">
      <p className="text-sm font-medium">{t("common:deploy.commits", { repo: target })}</p>
      <ul role="listbox" aria-label={t("common:deploy.commitsLabel")} className="max-h-56 divide-y overflow-y-auto rounded-md border">
        {commits.map((c) => {
          const tag = published(c.sha);
          const value = tag ?? c.sha;
          return (
            <li
              key={c.sha}
              role="option"
              aria-selected={selected === value}
              tabIndex={0}
              onClick={() => onSelect(value)}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect(value)}
              className={`flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm hover:bg-accent/40 ${
                selected === value ? "bg-accent/60" : ""
              }`}
            >
              <span className="font-mono text-xs">{c.sha.slice(0, 7)}</span>
              <span className="min-w-0 flex-1 truncate">{c.message}</span>
              {tag && <Badge variant="secondary">{t("common:deploy.imagePublished")}</Badge>}
              <span className="shrink-0 text-xs text-muted-foreground">
                {[c.author, c.date ? desde(c.date) : ""].filter(Boolean).join(" · ")}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
