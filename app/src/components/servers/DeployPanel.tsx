import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, RotateCcw, Rocket, Settings2, Workflow } from "lucide-react";
import { useT } from "@/lib/i18n";
import { phraseFor } from "@/lib/server-errors";
import { desde } from "@/lib/desde";
import { AGENT_VERSION_DEPLOYS, guessEnvironment, isSha, usesShortSha, repoFromImage, shortRef, shortServiceName } from "@/lib/deploy";
import { useDeploymentsStore } from "@/store/deployments.store";
import { useConfirm } from "@/components/ConfirmDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import CINoticeSection from "./CINoticeSection";
import CommitPicker from "./CommitPicker";
import MigrateCommandField from "./MigrateCommandField";
import BuildOnHostSection from "./BuildOnHostSection";
import type { Server } from "@/types/server";
import type { SwarmService } from "@/types/swarm";
import type { Deployment, DeployStatus } from "@/types/deploy";

const VARIANTE: Record<DeployStatus, "default" | "secondary" | "destructive" | "outline"> = {
  queued: "outline",
  running: "secondary",
  succeeded: "default",
  failed: "destructive",
  rolled_back: "outline",
};

// Referencias estables para los selectores: `?? []` dentro de uno crea un
// array nuevo en cada lectura y zustand repinta sin parar.
const NADA: never[] = [];

/**
 * Desplegar un servicio desde cac, y ver lo que se desplegó.
 *
 * Un servicio que todavía no se despliega desde aquí se **registra** primero,
 * y registrarlo no toca el servidor: su CI sigue desplegando como hoy. Es el
 * primer paso de la adopción gradual, y lo dice la propia pantalla.
 */
export default function DeployPanel({
  server,
  service,
  active = true,
  full = false,
  onOpenActivity,
  onConfigure,
  secrets,
}: {
  server: Server;
  service: SwarmService;
  /** Si está a la vista: con él se piden el servicio, el historial y el log. */
  active?: boolean;
  /**
   * Con toda la configuración (la página «Despliegue»): de dónde sale, rama y
   * build, secrets y migraciones. Sin ella (el modal), sólo desplegar y lo
   * desplegado, y un enlace a configurarlo: la configuración en un modal que
   * se abre para desplegar pasaba desapercibida.
   */
  full?: boolean;
  onOpenActivity?: (deployableId: string, orgId: string) => void;
  /** Ir a la página de configuración (sólo sin `full`). */
  onConfigure?: () => void;
  /** Los secrets del servicio, en su sitio de la página (sólo con `full`). */
  secrets?: React.ReactNode;
}) {
  const { t } = useT();
  const confirm = useConfirm();
  const deployables = useDeploymentsStore((s) => s.deployables[server.id] ?? NADA);
  const deployable = deployables.find((d) => d.serviceName === service.name);
  const history = useDeploymentsStore((s) => (deployable ? s.history[deployable.id] : undefined) ?? NADA);
  const logs = useDeploymentsStore((s) => s.logs);
  const { loadDeployables, loadHistory, loadLog, createDeployable, deploy, rollback } = useDeploymentsStore.getState();

  const [sha, setSha] = useState("");
  const [busy, setBusy] = useState(false);
  const [viendo, setViendo] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: shortServiceName(service.name, service.stack),
    environment: guessEnvironment(service.stack),
    imageRepo: repoFromImage(service.image),
  });

  useEffect(() => {
    if (active) void loadDeployables(server.id).catch(() => {});
  }, [active, server.id, loadDeployables]);

  useEffect(() => {
    if (active && deployable) void loadHistory(server.id, deployable.id).catch(() => {});
  }, [active, server.id, deployable, loadHistory]);

  // El último deploy se enseña solo: es el que se acaba de pedir, o el que
  // está en marcha, y su log es lo que uno quiere ver.
  const abierto = viendo ?? history[0]?.id ?? null;
  useEffect(() => {
    if (active && deployable && abierto && logs[abierto] === undefined) {
      void loadLog(server.id, deployable.id, abierto).catch(() => {});
    }
  }, [active, deployable, abierto, logs, server.id, loadLog]);

  const vivo = useMemo(() => history.some((d) => d.status === "queued" || d.status === "running"), [history]);
  // Sin identidad, o de una versión que no sabe desplegar: el backend lo
  // rechazaría, así que ni se ofrece. Las dos se arreglan igual, reinstalando.
  const sinAgente = !server.hasAgentToken || (server.agentVersion ?? 0) < AGENT_VERSION_DEPLOYS;

  const conError = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const registrar = () =>
    conError(() =>
      createDeployable(server.id, {
        name: form.name.trim(),
        stack: service.stack,
        serviceName: service.name,
        imageRepo: form.imageRepo.trim(),
        environment: form.environment.trim(),
        // GitHub avisa con el sha entero; si el CI etiqueta corto, cac recorta.
        shortTags: usesShortSha(service.image),
      }),
    );

  const desplegar = (commit: string) =>
    conError(async () => {
      const d = await deploy(server.id, deployable!.id, commit);
      setSha("");
      setViendo(d.id);
      toast.info(t("common:deploy.queued"));
    });

  const volver = async (d: Deployment) => {
    const ok = await confirm({
      title: t("common:deploy.rollbackTitle"),
      description: t("common:deploy.rollbackBody", { image: shortRef(d.previousImage) }),
      confirmText: t("common:deploy.rollback"),
    });
    if (!ok) return;
    await conError(async () => {
      const nuevo = await rollback(server.id, deployable!.id, d.id);
      setViendo(nuevo.id);
    });
  };

  const quien = (d: Deployment) =>
    d.requestedBy === "ci" ? t("common:deploy.byCI") : d.requestedBy === "github" ? t("common:deploy.byGitHub") : (d.requestedByName ?? "");

  return (
    <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          {deployable ? (
            <p className="font-mono text-xs text-muted-foreground">
              {t("common:deploy.now", { image: deployable.currentImage || service.image })}
            </p>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-1">
            {deployable && onOpenActivity && (
              <Button variant="ghost" size="sm" onClick={() => onOpenActivity(deployable.id, deployable.orgId)}>
                <Workflow className="mr-1 size-3.5" />
                {t("common:deploy.activity")}
              </Button>
            )}
            {deployable && !full && onConfigure && (
              <Button variant="outline" size="sm" onClick={onConfigure}>
                <Settings2 className="mr-1 size-3.5" />
                {t("common:deploy.configure")}
              </Button>
            )}
          </div>
        </div>

        {sinAgente && <p className="rounded-md border border-warning/40 bg-warning/10 p-2 text-sm">{t("common:deploy.noAgent")}</p>}

        {!deployable ? (
          <div className="space-y-3">
            <p className="text-sm font-medium">{t("common:deploy.notYet")}</p>
            <p className="text-sm text-muted-foreground">{t("common:deploy.notYetLead")}</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="dep-name">{t("common:deploy.name")}</Label>
                <Input id="dep-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="dep-env">{t("common:deploy.environment")}</Label>
                <Input id="dep-env" value={form.environment} onChange={(e) => setForm({ ...form, environment: e.target.value })} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dep-repo">{t("common:deploy.imageRepo")}</Label>
              <Input
                id="dep-repo"
                className="font-mono text-xs"
                value={form.imageRepo}
                placeholder={t("common:deploy.imageRepoHint")}
                onChange={(e) => setForm({ ...form, imageRepo: e.target.value })}
              />
            </div>
            <div className="flex justify-end">
              <Button onClick={() => void registrar()} disabled={busy || !form.name.trim() || !form.imageRepo.trim()}>
                {t("common:deploy.register")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <CommitPicker deployable={deployable} selected={sha} onSelect={setSha} />
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
              <Button onClick={() => void desplegar(sha.trim())} disabled={busy || vivo || sinAgente || !isSha(sha)}>
                {vivo ? <Loader2 className="mr-1 size-4 animate-spin" /> : <Rocket className="mr-1 size-4" />}
                {vivo ? t("common:deploy.deploying") : t("common:deploy.deploy")}
              </Button>
            </div>

            <div className="space-y-1">
              <p className="text-sm font-medium">{t("common:deploy.history")}</p>
              {history.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("common:deploy.empty")}</p>
              ) : (
                <ul className="max-h-48 divide-y overflow-y-auto rounded-md border">
                  {history.map((d) => (
                    <li key={d.id} className={`flex items-center gap-2 px-2 py-1.5 text-sm ${d.id === abierto ? "bg-accent/40" : ""}`}>
                      <Badge variant={VARIANTE[d.status]}>{t(`common:deploy.status.${d.status}`)}</Badge>
                      <span className="font-mono text-xs">{shortRef(d.finalImage || d.image)}</span>
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                        {quien(d)} · {desde(d.createdAt)}
                        {/* Un código del backend se traduce; un texto del agente pasa tal cual. */}
                        {d.error ? ` · ${phraseFor(d.error, d.error)}` : ""}
                      </span>
                      <Button variant="ghost" size="sm" onClick={() => setViendo(d.id)}>
                        {t("common:deploy.viewLog")}
                      </Button>
                      {d.status === "succeeded" && d.previousImage && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy || vivo || sinAgente}
                          title={t("common:deploy.rollback")}
                          aria-label={t("common:deploy.rollback")}
                          onClick={() => void volver(d)}
                        >
                          <RotateCcw className="size-3.5" />
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {abierto && (
              <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
                {logs[abierto] ?? "…"}
              </pre>
            )}

            {/* La configuración, en el orden en que se piensa: de dónde sale la
                imagen, qué rama y si se construye aquí, con qué secrets, y qué
                corre antes de desplegar. */}
            {full && (
              <div className="space-y-4 border-t pt-4">
              <CINoticeSection
                server={server}
                deployable={deployable}
                currentImage={service.image}
                canDeploy={!vivo && !sinAgente}
                onDeploy={(commit) => void desplegar(commit)}
                onOpenActivity={onOpenActivity && (() => onOpenActivity(deployable.id, deployable.orgId))}
              />

              {/* Después del CI: el build pide el repo, que se pone ahí. */}
              <BuildOnHostSection key={`build-${deployable.id}`} server={server} deployable={deployable} />
                {secrets}
                <MigrateCommandField key={deployable.id} server={server} deployable={deployable} />
              </div>
            )}
          </div>
        )}
    </div>
  );
}
