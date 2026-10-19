import { useEffect, useState } from "react";
import { Loader2, RefreshCw, Rocket } from "lucide-react";
import { useConfirm } from "@/components/ConfirmDialog";
import { useT } from "@/lib/i18n";
import { desde } from "@/lib/desde";
import { isSha, runsCommit } from "@/lib/deploy";
import { phraseFor } from "@/lib/server-errors";
import { cn } from "@/lib/utils";
import { useDeploymentsStore } from "@/store/deployments.store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import type { Deployable } from "@/types/deploy";

const NADA: never[] = [];

/**
 * Qué desplegar: los últimos commits de la rama del servicio, con el más
 * nuevo ya elegido, y un botón. Desplegar lo último es un clic.
 *
 * La lista la da el backend con la GitHub App. Hasta la v1.12.0 la pedía la
 * app con el token de GitHub de esta máquina y de la rama **por defecto**: sin
 * token no salía nada, y un servicio de `dev` enseñaba los commits de `main`.
 *
 * Se marca el commit que corre en el servidor y cuántos hay por encima sin
 * desplegar. Sin build en el servidor, uno que ya tiene imagen publicada (el
 * CI avisó) se despliega con el tag **con el que se publicó** —corto o
 * entero—, que es el que existe.
 *
 * Escribir un sha queda para lo raro, detrás de «Otro commit…»; y a la vista
 * cuando no hay lista, diciendo por qué.
 *
 * La lista se refresca sola cuando llega un commit nuevo (`deploy:build`), y
 * desplegar lo que ya corre se confirma. Con la pantalla abierta desde antes
 * de un merge, lo de arriba era lo que ya corría y se desplegó sin traer nada
 * (jose, 19-oct-2026).
 */
export default function CommitPicker({
  serverId,
  deployable,
  currentImage,
  disabled,
  deploying,
  onDeploy,
}: {
  serverId: string;
  deployable: Deployable;
  /** La imagen que corre ahora, para marcar su commit. */
  currentImage: string;
  disabled: boolean;
  /** Hay un deploy en cola o en curso. */
  deploying: boolean;
  onDeploy: (sha: string) => void;
}) {
  const { t } = useT();
  const builds = useDeploymentsStore((s) => s.builds[deployable.id] ?? NADA);
  const commits = useDeploymentsStore((s) => s.commits[deployable.id]);
  const stale = useDeploymentsStore((s) => s.commitsStale[deployable.id] ?? 0);
  const confirm = useConfirm();
  const [tick, setTick] = useState(0);
  const hasRepo = deployable.repoFullName !== "";
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [sha, setSha] = useState("");

  useEffect(() => {
    if (!hasRepo) return;
    let alive = true;
    setLoading(true);
    setError(null);
    useDeploymentsStore
      .getState()
      .loadCommits(serverId, deployable.id)
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // La rama y el repo cambian la lista; un commit nuevo o el botón, también.
  }, [serverId, deployable.id, deployable.branch, deployable.repoFullName, hasRepo, stale, tick]);

  const list = hasRepo && !error ? (commits ?? NADA) : NADA;
  // El tag con el que se publicó cada commit, si se publicó.
  const published = (commit: string) => builds.find((b) => commit.startsWith(b.sha))?.sha;
  const valueOf = (commit: string) => (deployable.buildOnHost ? commit : (published(commit) ?? commit));
  const running = list.findIndex((c) => runsCommit(currentImage, c.sha));
  const chosen = picked ?? list[0]?.sha ?? null;

  const deploy = async (value: string) => {
    if (runsCommit(currentImage, value)) {
      const ok = await confirm({
        title: t("common:deploy.redeployTitle"),
        description: t("common:deploy.redeployBody", { sha: value.slice(0, 7) }),
        confirmText: t("common:deploy.redeployConfirm"),
      });
      if (!ok) return;
    }
    onDeploy(value);
  };

  const deployButton = (label: string, value: string, enabled: boolean) => (
    <Button className="shrink-0" onClick={() => void deploy(value)} disabled={disabled || !enabled}>
      {deploying ? <Loader2 className="mr-1 size-4 animate-spin" /> : <Rocket className="mr-1 size-4" />}
      {deploying ? t("common:deploy.deploying") : label}
    </Button>
  );

  const field = (
    <div className="flex items-end gap-2">
      <div className="flex-1 space-y-1.5">
        <Label htmlFor="dep-sha">{t("common:deploy.sha")}</Label>
        <Input
          id="dep-sha"
          className="font-mono"
          value={sha}
          placeholder={t("common:deploy.shaHint")}
          onChange={(e) => setSha(e.target.value.trim().toLowerCase())}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
      </div>
      {deployButton(t("common:deploy.deploy"), sha.trim(), isSha(sha))}
    </div>
  );

  if (loading && !commits) {
    return (
      <div className="space-y-1.5" aria-busy>
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (list.length === 0) {
    return (
      <div className="space-y-2">
        {!hasRepo ? (
          <p className="text-xs text-muted-foreground">{t("common:deploy.commitsNeedRepo")}</p>
        ) : error ? (
          <p className="text-xs text-muted-foreground">
            {t("common:deploy.commitsFailed", { reason: phraseFor(error, error) })}
          </p>
        ) : null}
        {field}
      </div>
    );
  }

  return (
    <div role="group" aria-label={t("common:deploy.commitsLabel")} className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-medium">
          {t("common:deploy.commits", { branch: deployable.branch || t("common:deploy.defaultBranch") })}
          {running > 0 && (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {t("common:deploy.behind", { count: running })}
            </span>
          )}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("common:deploy.refreshCommits")}
            title={t("common:deploy.refreshCommits")}
            disabled={loading}
            onClick={() => setTick((n) => n + 1)}
          >
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          </Button>
          <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => setManual((m) => !m)}>
            {t("common:deploy.otherCommit")}
          </Button>
        </div>
      </div>
      <ul role="listbox" aria-label={t("common:deploy.commitsLabel")} className="max-h-56 divide-y overflow-y-auto rounded-md border">
        {list.map((c, i) => {
          const tag = !deployable.buildOnHost && published(c.sha);
          const selected = chosen === c.sha;
          return (
            <li
              key={c.sha}
              role="option"
              aria-selected={selected}
              tabIndex={0}
              onClick={() => setPicked(c.sha)}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setPicked(c.sha)}
              className={cn(
                "flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm hover:bg-accent/40",
                selected && "bg-accent/60",
                // Lo que ya corre y lo de antes, en segundo plano.
                running >= 0 && i > running && "text-muted-foreground",
              )}
            >
              <span className="font-mono text-xs">{c.sha.slice(0, 7)}</span>
              <span className="min-w-0 flex-1 truncate">{c.message}</span>
              {i === running && <Badge variant="outline">{t("common:deploy.running")}</Badge>}
              {tag && <Badge variant="secondary">{t("common:deploy.imagePublished")}</Badge>}
              <span className="shrink-0 text-xs text-muted-foreground">
                {[c.author, c.date ? desde(c.date) : ""].filter(Boolean).join(" · ")}
              </span>
            </li>
          );
        })}
      </ul>
      {chosen && (
        <div className="flex justify-end">
          {deployButton(t("common:deploy.deployCommit", { sha: chosen.slice(0, 7) }), valueOf(chosen), true)}
        </div>
      )}
      {manual && field}
    </div>
  );
}
