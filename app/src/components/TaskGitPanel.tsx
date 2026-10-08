import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
} from "lucide-react";

import { isGitHubUrl } from "@/lib/github-url";
import { useT, type MessageKey } from "@/lib/i18n";
import { openExternal } from "@/lib/platform";
import { cn } from "@/lib/utils";
import type { GitSummary, PRState, TaskGitLink, TaskGitLinks } from "@/types/task";

/**
 * «Desarrollo»: lo que GitHub ha enlazado a esta tarea.
 *
 * La forma es la del panel Development de Jira, que es lo que conoce quien
 * viene de ahí: un resumen de cuántas ramas, PRs y commits, y debajo el
 * detalle. Las PRs siempre a la vista con su estado (como Linear), porque son
 * lo que se pregunta —«¿ya está fusionado?»—; las ramas, debajo; los commits,
 * plegados, que en una tarea larga son decenas y nadie los lee uno a uno.
 *
 * Sólo enseña. Lo que llega de GitHub no mueve la tarea (`domain/github.go`):
 * fusionar una PR no la cierra.
 */

const PR_ICON: Record<PRState, typeof GitPullRequest> = {
  open: GitPullRequest,
  draft: GitPullRequestDraft,
  merged: GitMerge,
  closed: GitPullRequestClosed,
};

/** Los colores de GitHub para cada estado, que es como se reconocen de un vistazo. */
const PR_COLOR: Record<PRState, string> = {
  open: "text-emerald-500",
  draft: "text-muted-foreground",
  merged: "text-violet-500",
  closed: "text-red-500",
};

const PR_LABEL: Record<PRState, MessageKey> = {
  open: "work:task.git.state.open",
  draft: "work:task.git.state.draft",
  merged: "work:task.git.state.merged",
  closed: "work:task.git.state.closed",
};

function prState(s: string): PRState {
  return s === "draft" || s === "merged" || s === "closed" ? s : "open";
}

/** Abre en GitHub, y sólo si el enlace es de GitHub: llegó por un webhook. */
function abrir(url: string) {
  if (isGitHubUrl(url)) void openExternal(url);
}

export default function TaskGitPanel({ git }: { git?: TaskGitLinks }) {
  const { t } = useT();
  const [commitsAbiertos, setCommitsAbiertos] = useState(false);

  if (!git) return null;
  const { prs, branches, commits } = git;
  if (prs.length + branches.length + commits.length === 0) return null;

  // Lo que se enlazó por la rama y no por el texto lo dice al pasar el ratón:
  // si no, una PR que no nombra la tarea parecería enlazada al azar.
  const porRama = (l: TaskGitLink) => (l.via === "branch" ? t("work:task.git.viaBranch") : undefined);

  return (
    <section className="space-y-2" aria-label={t("work:task.git.development")}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("work:task.git.development")}
        </h3>
        <span className="text-xs text-muted-foreground">
          {[
            branches.length > 0 && t("work:task.git.branches", { count: branches.length }),
            prs.length > 0 && t("work:task.git.prs", { count: prs.length }),
            git.summary.commits > 0 && t("work:task.git.commits", { count: git.summary.commits }),
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>

      {prs.length > 0 && (
        <ul className="space-y-1">
          {prs.map((pr) => {
            const s = prState(pr.state);
            const Icon = PR_ICON[s];
            return (
              <li key={`${pr.repoId}-${pr.key}`}>
                <button
                  type="button"
                  onClick={() => abrir(pr.htmlUrl)}
                  title={porRama(pr)}
                  className="flex w-full items-start gap-2 rounded px-1.5 py-1 text-left text-sm hover:bg-accent"
                >
                  <Icon className={cn("mt-0.5 size-4 shrink-0", PR_COLOR[s])} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">
                      <span className="text-muted-foreground">#{pr.key}</span> {pr.title}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {pr.repoFullName}
                      {pr.authorLogin && ` · @${pr.authorLogin}`}
                    </span>
                  </span>
                  <span className={cn("shrink-0 text-xs font-medium", PR_COLOR[s])}>{t(PR_LABEL[s])}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {branches.length > 0 && (
        <ul className="space-y-0.5">
          {branches.map((b) => {
            const borrada = b.state === "deleted";
            return (
              <li
                key={`${b.repoId}-${b.key}`}
                title={porRama(b)}
                className={cn(
                  "flex items-center gap-2 px-1.5 text-xs",
                  borrada ? "text-muted-foreground/60" : "text-muted-foreground",
                )}
              >
                <GitBranch className="size-3.5 shrink-0" aria-hidden />
                <span className={cn("min-w-0 truncate font-mono", borrada && "line-through")}>{b.key}</span>
                <span className="shrink-0 truncate">{b.repoFullName}</span>
                {borrada && <span className="shrink-0 italic">{t("work:task.git.deleted")}</span>}
              </li>
            );
          })}
        </ul>
      )}

      {commits.length > 0 && (
        <div>
          <button
            type="button"
            aria-expanded={commitsAbiertos}
            onClick={() => setCommitsAbiertos((v) => !v)}
            className="flex items-center gap-1 px-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            {commitsAbiertos ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            {t("work:task.git.commits", { count: git.summary.commits })}
          </button>
          {commitsAbiertos && (
            <ul className="mt-1 space-y-0.5">
              {commits.map((c) => (
                <li key={`${c.repoId}-${c.key}`}>
                  <button
                    type="button"
                    onClick={() => abrir(c.htmlUrl)}
                    title={porRama(c)}
                    className="flex w-full items-center gap-2 rounded px-1.5 py-0.5 text-left text-xs hover:bg-accent"
                  >
                    <GitCommitHorizontal className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="shrink-0 font-mono text-muted-foreground">{c.key.slice(0, 7)}</span>
                    {/* La primera línea: el resto del mensaje es para el log. */}
                    <span className="min-w-0 flex-1 truncate">{c.title.split("\n")[0]}</span>
                    {c.authorLogin && (
                      <span className="shrink-0 text-muted-foreground">@{c.authorLogin}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * El chip de la tarjeta: cuántas PRs tiene y en qué estado van, con el color
 * del resumen (`prBadge`, la precedencia de Jira: abierta > fusionada >
 * cerrada). Sin PRs no hay chip: una rama sola no dice nada en el tablero.
 */
export function PrChip({ git }: { git?: GitSummary }) {
  const { t } = useT();
  if (!git || git.prs === 0) return null;
  const s = prState(git.prBadge ?? "open");
  const Icon = PR_ICON[s];
  return (
    <span
      className={cn("flex items-center gap-0.5", PR_COLOR[s])}
      title={`${t("work:task.git.prs", { count: git.prs })} · ${t(PR_LABEL[s])}`}
    >
      <Icon className="size-3" aria-hidden />
      {git.prs}
    </span>
  );
}
