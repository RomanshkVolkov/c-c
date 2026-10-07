import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ExternalLink, GitBranch, Loader2, Rocket, Server, Workflow, X } from "lucide-react";
import { isWebBuild, openExternal } from "@/lib/platform";
import { useT } from "@/lib/i18n";
import { desde } from "@/lib/desde";
import { shortRef } from "@/lib/deploy";
import { cn } from "@/lib/utils";
import { useOrgsStore } from "@/store/orgs.store";
import { idOf, useActivityStore } from "@/store/activity.store";
import { groupAttempts, type GroupedEntry } from "@/lib/run-attempts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ActivityDeployment, ActivityFilter, WorkflowRun } from "@/types/activity";
import type { DeployStatus } from "@/types/deploy";

/**
 * La actividad de CI de la org (R9): cada run de GitHub Actions de sus repos
 * y cada deploy de cac, mezclados por tiempo, lo más nuevo primero.
 *
 * Es una página y no una pestaña de un servidor porque un run es del **repo**,
 * no del servidor: un repo sin servicio registrado no tendría dónde salir. Lo
 * que sí hay es el camino de vuelta: desde un servicio se llega aquí filtrado
 * (`?deployable=`), y desde un repo de la pestaña GitHub de la org también
 * (`?repo=`). Los avisos de la campana traen además `?run=` o `?deployment=`,
 * y esa fila se resalta.
 *
 * El estado llega en vivo por el stream (`ci:run`, `deploy:status`): un run
 * que termina mientras se mira cambia de color solo.
 */
export default function Activity() {
  const { t } = useT();
  const [params, setParams] = useSearchParams();
  const orgId = useOrgsStore((s) => s.currentOrgId);
  const entries = useActivityStore((s) => s.entries);
  const hasMore = useActivityStore((s) => s.hasMore);
  const loading = useActivityStore((s) => s.loading);
  const error = useActivityStore((s) => s.error);
  const load = useActivityStore((s) => s.load);
  const loadMore = useActivityStore((s) => s.loadMore);

  const repo = params.get("repo") ?? "";
  const deployableId = params.get("deployable") ?? "";
  const highlightRun = params.get("run") ?? "";
  const highlightDeployment = params.get("deployment") ?? "";

  // El objeto del filtro se memoiza para que `load` no se dispare por un
  // literal nuevo en cada pintado: el store compara el filtro por identidad
  // para descartar respuestas tardías.
  const filter = useMemo<ActivityFilter>(
    () => ({ repo: repo || undefined, deployableId: deployableId || undefined }),
    [repo, deployableId],
  );

  useEffect(() => {
    if (orgId) void load(orgId, filter);
  }, [orgId, filter, load]);

  const clearFilter = () => {
    const next = new URLSearchParams(params);
    next.delete("repo");
    next.delete("deployable");
    setParams(next, { replace: true });
  };

  // Un enlace a un intento antiguo resalta el run entero: ya no tiene fila propia.
  const highlighted = (e: GroupedEntry) =>
    (e.kind === "run" && (e.run.id === highlightRun || e.earlier.some((r) => r.id === highlightRun))) ||
    (e.kind === "deployment" && e.deployment.id === highlightDeployment);
  const grouped = useMemo(() => groupAttempts(entries), [entries]);
  const wanted = highlightRun || highlightDeployment;
  const found = !wanted || grouped.some(highlighted);

  const filtered = Boolean(repo || deployableId);
  // El servicio del filtro, para el chip: su nombre va en sus deploys.
  const deployableName = useMemo(() => {
    for (const e of entries) {
      if (e.kind === "deployment" && e.deployment.deployableId === deployableId) return e.deployment.deployableName;
      if (e.kind === "run") for (const d of e.deployments ?? []) if (d.deployableId === deployableId) return d.deployableName;
    }
    return "";
  }, [entries, deployableId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto max-w-4xl space-y-4">
          <header className="space-y-1">
            <h2 className="flex items-center gap-2 text-[19px] font-semibold">
              <Workflow className="size-5" />
              {t("activity:title")}
            </h2>
            <p className="text-sm text-muted-foreground">{t("activity:lead")}</p>
          </header>

          {filtered && (
            <div className="flex flex-wrap items-center gap-2">
              {repo && (
                <Badge variant="secondary" className="font-mono">
                  {t("activity:filter.repo", { repo })}
                </Badge>
              )}
              {deployableId && (
                <Badge variant="secondary">
                  {t("activity:filter.deployable")}
                  {deployableName ? `: ${deployableName}` : ""}
                </Badge>
              )}
              <Button variant="ghost" size="sm" onClick={clearFilter}>
                <X className="mr-1 size-3.5" />
                {t("activity:filter.clear")}
              </Button>
            </div>
          )}

          {wanted && !found && !loading && (
            <p className="rounded-md border border-warning/40 bg-warning/10 p-2 text-sm">{t("activity:notInPage")}</p>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          {entries.length === 0 && !loading ? (
            <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              {filtered ? t("activity:emptyFiltered") : t("activity:empty")}
            </p>
          ) : (
            <ul className="divide-y rounded-md border">
              {grouped.map((e) =>
                e.kind === "run" ? (
                  <RunRow key={`run-${e.run.runId}`} run={e.run} earlier={e.earlier} deployments={e.deployments} highlighted={highlighted(e)} />
                ) : (
                  <DeploymentRow key={`dep-${idOf(e)}`} dep={e.deployment} highlighted={highlighted(e)} />
                ),
              )}
            </ul>
          )}

          {(hasMore || loading) && (
            <div className="flex justify-center">
              <Button variant="outline" size="sm" disabled={loading} onClick={() => void loadMore()}>
                {loading ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : null}
                {loading ? t("activity:loading") : t("activity:loadMore")}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Lo que se pinta del estado de un run: la conclusión si terminó, el estado si no. */
function runBadge(run: WorkflowRun): { variant: "default" | "secondary" | "destructive" | "outline"; className?: string } {
  if (run.status !== "completed") return { variant: run.status === "in_progress" ? "secondary" : "outline" };
  switch (run.conclusion) {
    case "success":
      return { variant: "default" };
    case "failure":
    case "timed_out":
    case "startup_failure":
      return { variant: "destructive" };
    case "cancelled":
    case "skipped":
    case "stale":
      return { variant: "outline" };
    default:
      return { variant: "secondary" };
  }
}

/** Sólo se abre lo que es de GitHub: el enlace lo escribió GitHub, pero la regla no cuesta nada. */
export function isGitHubUrl(u: string): boolean {
  return u.startsWith("https://github.com/");
}

function RunRow({
  run,
  earlier,
  deployments,
  highlighted,
}: {
  run: WorkflowRun;
  /** Los intentos anteriores del mismo run, del primero al penúltimo. */
  earlier: WorkflowRun[];
  deployments: ActivityDeployment[];
  highlighted: boolean;
}) {
  const { t } = useT();
  const ref = useScrollWhen(highlighted);
  const badge = runBadge(run);
  const label =
    run.status === "completed" && run.conclusion
      ? t(`activity:run.conclusion.${run.conclusion}`)
      : t(`activity:run.status.${run.status}`);
  return (
    <li ref={ref} className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm", highlighted && "ring-2 ring-primary/60 ring-inset")}>
      <Badge variant={badge.variant} className={cn("shrink-0", run.status === "in_progress" && "animate-pulse")}>
        {label}
      </Badge>
      <span className="font-medium" title={run.path}>
        {run.workflowName || run.path}
      </span>
      <span className="font-mono text-xs text-muted-foreground">{run.repoFullName}</span>
      {run.headBranch && (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <GitBranch className="size-3" />
          {run.headBranch}
        </span>
      )}
      {run.headSha && <span className="font-mono text-xs">{run.headSha.slice(0, 7)}</span>}
      {run.commitTitle && <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{run.commitTitle}</span>}
      <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
        {run.runAttempt > 1 && <span>{t("activity:attempt", { n: run.runAttempt })}</span>}
        {run.actor && <span>{t("activity:by", { actor: run.actor })}</span>}
        <span title={run.occurredAt}>{desde(run.occurredAt)}</span>
        {isGitHubUrl(run.htmlUrl) && (
          <Button variant="ghost" size="sm" aria-label={t("activity:openRun")} title={t("activity:openRun")} onClick={() => void openExternal(run.htmlUrl)}>
            <ExternalLink className="size-3.5" />
          </Button>
        )}
      </span>
      {earlier.length > 0 && (
        <div className="flex w-full flex-wrap items-center gap-2 pl-1 text-xs text-muted-foreground" data-earlier-attempts>
          <span>{t("activity:earlierAttempts")}</span>
          {earlier.map((r) => {
            const b = runBadge(r);
            const what =
              r.status === "completed" && r.conclusion
                ? t(`activity:run.conclusion.${r.conclusion}`)
                : t(`activity:run.status.${r.status}`);
            const chip = (
              <>
                <Badge variant={b.variant} className="h-4 px-1 text-[10px]">
                  {what}
                </Badge>
                {t("activity:attempt", { n: r.runAttempt })}
              </>
            );
            return isGitHubUrl(r.htmlUrl) ? (
              <button
                key={r.id}
                type="button"
                className="inline-flex items-center gap-1 rounded px-1 hover:bg-muted hover:text-foreground"
                title={t("activity:openRun")}
                onClick={() => void openExternal(r.htmlUrl)}
              >
                {chip}
              </button>
            ) : (
              <span key={r.id} className="inline-flex items-center gap-1 px-1">
                {chip}
              </span>
            );
          })}
        </div>
      )}
      {deployments.length > 0 && (
        <div className="flex w-full flex-wrap gap-2 pl-1">
          {deployments.map((d) => (
            <ToService
              key={d.id}
              serverId={d.serverId}
              className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs hover:bg-muted"
              title={t("activity:openService")}
            >
              <Rocket className="size-3" />
              {t("activity:triggered", { service: d.deployableName, env: d.deployableEnv || "—" })}
              <Badge variant={DEPLOY_VARIANT[d.status] ?? "outline"} className="ml-1">
                {t(`common:deploy.status.${d.status}`)}
              </Badge>
            </ToService>
          ))}
        </div>
      )}
    </li>
  );
}

/**
 * El enlace al servicio de un despliegue. En la web no hay pantalla de
 * servidores (ni el servidor le contesta a una sesión web): el chip se queda,
 * sin enlace a una ruta que no existe.
 */
function ToService({ serverId, className, title, children }: { serverId: string; className: string; title: string; children: ReactNode }) {
  if (isWebBuild) return <span className={className.replace(" hover:bg-muted", "")}>{children}</span>;
  return (
    <Link to={`/servers/${serverId}/services`} className={className} title={title}>
      {children}
    </Link>
  );
}

const DEPLOY_VARIANT: Record<DeployStatus, "default" | "secondary" | "destructive" | "outline"> = {
  queued: "outline",
  running: "secondary",
  succeeded: "default",
  failed: "destructive",
  rolled_back: "outline",
};

function DeploymentRow({ dep, highlighted }: { dep: ActivityDeployment; highlighted: boolean }) {
  const { t } = useT();
  const ref = useScrollWhen(highlighted);
  const who =
    dep.requestedBy === "ci" ? t("common:deploy.byCI") : dep.requestedBy === "github" ? t("common:deploy.byGitHub") : (dep.requestedByName ?? "");
  return (
    <li ref={ref} className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm", highlighted && "ring-2 ring-primary/60 ring-inset")}>
      <Badge variant={DEPLOY_VARIANT[dep.status] ?? "outline"} className={cn("shrink-0", dep.status === "running" && "animate-pulse")}>
        {t(`common:deploy.status.${dep.status}`)}
      </Badge>
      <Rocket className="size-3.5 text-muted-foreground" />
      <span className="font-medium">{dep.deployableName || dep.deployableId}</span>
      {dep.deployableEnv && <span className="text-xs text-muted-foreground">{dep.deployableEnv}</span>}
      <span className="font-mono text-xs">{shortRef(dep.finalImage || dep.image)}</span>
      {dep.error && <span className="min-w-0 flex-1 truncate text-xs text-destructive">{dep.error}</span>}
      <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
        {who && <span>{t("activity:deployment.by", { who })}</span>}
        <span title={dep.createdAt}>{desde(dep.createdAt)}</span>
        {!isWebBuild && (
          <Link
            to={`/servers/${dep.serverId}/services`}
            className="inline-flex items-center"
            aria-label={t("activity:openService")}
            title={t("activity:openService")}
          >
            <Server className="size-3.5" />
          </Link>
        )}
      </span>
    </li>
  );
}

/** Lleva la vista a la fila que pide el enlace, una vez. */
function useScrollWhen(on: boolean) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (on) ref.current?.scrollIntoView?.({ block: "center" });
  }, [on]);
  return ref;
}
