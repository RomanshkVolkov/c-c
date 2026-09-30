import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, RotateCcw, Rocket } from "lucide-react";
import { useT } from "@/lib/i18n";
import { phraseFor } from "@/lib/server-errors";
import { desde } from "@/lib/desde";
import { guessEnvironment, isSha, repoFromImage, shortRef, shortServiceName } from "@/lib/deploy";
import { useDeploymentsStore } from "@/store/deployments.store";
import { useConfirm } from "@/components/ConfirmDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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

/** La primera versión del agente que despliega (`domain.AgentVersionDeploys`). */
const AGENT_VERSION_DEPLOYS = 3;

/**
 * Desplegar un servicio desde cac, y ver lo que se desplegó.
 *
 * Un servicio que todavía no se despliega desde aquí se **registra** primero,
 * y registrarlo no toca el servidor: su CI sigue desplegando como hoy. Es el
 * primer paso de la adopción gradual, y lo dice la propia pantalla.
 */
export default function DeployDialog({
  server,
  service,
  open,
  onOpenChange,
}: {
  server: Server;
  service: SwarmService;
  open: boolean;
  onOpenChange: (v: boolean) => void;
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
    if (open) void loadDeployables(server.id).catch(() => {});
  }, [open, server.id, loadDeployables]);

  useEffect(() => {
    if (open && deployable) void loadHistory(server.id, deployable.id).catch(() => {});
  }, [open, server.id, deployable, loadHistory]);

  // El último deploy se enseña solo: es el que se acaba de pedir, o el que
  // está en marcha, y su log es lo que uno quiere ver.
  const abierto = viendo ?? history[0]?.id ?? null;
  useEffect(() => {
    if (open && deployable && abierto && logs[abierto] === undefined) {
      void loadLog(server.id, deployable.id, abierto).catch(() => {});
    }
  }, [open, deployable, abierto, logs, server.id, loadLog]);

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
      }),
    );

  const desplegar = () =>
    conError(async () => {
      const d = await deploy(server.id, deployable!.id, sha.trim());
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("common:deploy.title", { name: service.name })}</DialogTitle>
          {deployable && (
            <DialogDescription className="font-mono text-xs">
              {t("common:deploy.now", { image: deployable.currentImage || service.image })}
            </DialogDescription>
          )}
        </DialogHeader>

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
              <Button onClick={() => void desplegar()} disabled={busy || vivo || sinAgente || !isSha(sha)}>
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
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
