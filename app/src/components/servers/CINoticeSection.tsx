import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Check, Copy, ExternalLink, KeyRound, Rocket } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useT } from "@/lib/i18n";
import { apiUrl } from "@/lib/api";
import { desde } from "@/lib/desde";
import { ciNoticeStep, usesShortSha } from "@/lib/deploy";
import { GITHUB_PAT_KEY, repoOfDeployable } from "@/lib/github-repo";
import { invoke } from "@tauri-apps/api/core";
import { useDeploymentsStore } from "@/store/deployments.store";
import { useConfirm } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Server } from "@/types/server";
import type { CINotifyMode, Deployable } from "@/types/deploy";

const NADA: never[] = [];

/** El nombre del secret que lee el paso del workflow. */
const CI_KEY_SECRET = "CAC_DEPLOY_KEY";

/**
 * El aviso del CI de un servicio: su llave, qué hace cac al recibirlo, y las
 * versiones que el CI ha publicado.
 *
 * Es el paso 3 de la adopción gradual. En «Apuntar» (lo de por defecto) el CI
 * sigue desplegando él y cac sólo lleva la lista; pasar a «Desplegar» es lo
 * que cambia quién despliega, y por eso se confirma.
 */
export default function CINoticeSection({
  server,
  deployable,
  currentImage,
  canDeploy,
  onDeploy,
}: {
  server: Server;
  deployable: Deployable;
  /** La imagen que corre el servicio ahora, aunque no la desplegara cac. */
  currentImage: string;
  /** Si ahora mismo se puede pedir un deploy (agente listo, nada en curso). */
  canDeploy: boolean;
  onDeploy: (sha: string) => void;
}) {
  const { t } = useT();
  const confirm = useConfirm();
  const builds = useDeploymentsStore((s) => s.builds[deployable.id] ?? NADA);
  const { loadBuilds, mintCIKey, setCINotify, setGitHub } = useDeploymentsStore.getState();
  const [repo, setRepo] = useState(deployable.repoFullName);
  const [workflow, setWorkflow] = useState(deployable.buildWorkflow ?? "");
  const ghDirty = repo.trim() !== deployable.repoFullName || workflow.trim() !== (deployable.buildWorkflow ?? "");
  // La llave entera sólo vive aquí, y sólo hasta cerrar el diálogo. Y sólo
  // se enseña si no se pudo guardar sola en el repo.
  const [key, setKey] = useState<string | null>(null);
  // El repo donde quedó guardada como secret, si se pudo.
  const [savedIn, setSavedIn] = useState<string | null>(null);
  const [copied, setCopied] = useState<"key" | "step" | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadBuilds(server.id, deployable.id).catch(() => {});
  }, [server.id, deployable.id, loadBuilds]);

  // El tag que lleva lo que corre ahora dice si el CI etiqueta corto o entero.
  const shortTags = usesShortSha(currentImage) || (deployable.shortTags ?? false);
  const step = ciNoticeStep(apiUrl("/ingest/v1/deploys"), shortTags);

  const guard = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const mint = async () => {
    if (deployable.ciKeyPreview) {
      const ok = await confirm({
        title: t("common:deploy.ci.remintTitle"),
        description: t("common:deploy.ci.remintBody", { preview: deployable.ciKeyPreview }),
        confirmText: t("common:deploy.ci.remint"),
      });
      if (!ok) return;
    }
    await guard(async () => {
      const k = await mintCIKey(server.id, deployable.id);
      setKey(null);
      setSavedIn(null);
      // Con el PAT de la app, la llave va sola a los secrets del repo: nadie
      // tiene que ir a GitHub a pegarla. Sin PAT o sin repo, se enseña.
      const target = repoOfDeployable({ repoFullName: repo.trim(), imageRepo: deployable.imageRepo });
      const [owner, name] = target.split("/");
      const canPush =
        !!owner && !!name && (await invoke<boolean>("github_token_configured", { serverId: GITHUB_PAT_KEY }).catch(() => false));
      if (!canPush) {
        setKey(k.key);
        return;
      }
      try {
        await invoke("set_github_secret", {
          serverId: GITHUB_PAT_KEY,
          owner,
          repo: name,
          name: CI_KEY_SECRET,
          value: k.key,
        });
      } catch (e) {
        setKey(k.key);
        toast.error(t("common:deploy.ci.pushFailed", { repo: target }), {
          description: e instanceof Error ? e.message : String(e),
        });
        return;
      }
      setSavedIn(target);
      // El repo deducido de la imagen se queda puesto: es el mismo que verá
      // GitHub, y sin él no hay Deployments.
      if (!deployable.repoFullName) {
        setRepo(target);
        await setGitHub(server.id, deployable, target, workflow.trim(), shortTags);
      }
    });
  };

  const setMode = async (mode: CINotifyMode) => {
    if (mode === deployable.onCINotify) return;
    if (mode === "deploy") {
      const ok = await confirm({
        title: t("common:deploy.ci.toDeployTitle"),
        description: t("common:deploy.ci.toDeployBody", { server: server.name }),
        confirmText: t("common:deploy.ci.toDeployConfirm"),
      });
      if (!ok) return;
    }
    await guard(() => setCINotify(server.id, deployable, mode));
  };

  const copy = (what: "key" | "step", text: string) => {
    void navigator.clipboard.writeText(text);
    setCopied(what);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div>
        <p className="text-sm font-medium">{t("common:deploy.ci.title")}</p>
        <p className="text-xs text-muted-foreground">{t("common:deploy.ci.lead")}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">{t("common:deploy.ci.mode")}</span>
        <div role="radiogroup" aria-label={t("common:deploy.ci.mode")} className="flex rounded-md border p-0.5">
          {(["record", "deploy"] as const).map((m) => (
            <button
              key={m}
              role="radio"
              aria-checked={deployable.onCINotify === m}
              disabled={busy}
              onClick={() => void setMode(m)}
              className={`rounded px-2 py-0.5 text-xs ${deployable.onCINotify === m ? "bg-accent font-medium" : "text-muted-foreground"}`}
            >
              {t(`common:deploy.ci.modes.${m}`)}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <span className="font-mono text-xs text-muted-foreground">
          {deployable.ciKeyPreview ? t("common:deploy.ci.keyPreview", { preview: deployable.ciKeyPreview }) : t("common:deploy.ci.noKey")}
        </span>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void mint()}>
          <KeyRound className="mr-1 size-3.5" />
          {deployable.ciKeyPreview ? t("common:deploy.ci.remint") : t("common:deploy.ci.mint")}
        </Button>
      </div>

      {/* Con la GitHub App: el repo hace que cada deploy sea un Deployment en
          GitHub, y el workflow, que su final cuente como el aviso. */}
      <div className="flex flex-wrap items-end gap-2 text-sm">
        <div className="min-w-40 flex-1 space-y-1">
          <Label htmlFor="ci-repo" className="text-xs">{t("common:deploy.ci.repo")}</Label>
          <Input
            id="ci-repo"
            className="h-8 font-mono text-xs"
            placeholder="owner/repo"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
          />
        </div>
        <div className="min-w-32 flex-1 space-y-1">
          <Label htmlFor="ci-workflow" className="text-xs">{t("common:deploy.ci.workflow")}</Label>
          <Input
            id="ci-workflow"
            className="h-8 font-mono text-xs"
            placeholder="prod.yml"
            value={workflow}
            onChange={(e) => setWorkflow(e.target.value)}
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !ghDirty}
          onClick={() => void guard(() => setGitHub(server.id, deployable, repo.trim(), workflow.trim(), shortTags))}
        >
          {t("common:deploy.ci.saveGitHub")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t("common:deploy.ci.githubLead")}</p>

      {savedIn && (
        <div className="space-y-2 rounded-md border border-success/40 bg-success/10 p-2 text-xs">
          <p>{t("common:deploy.ci.keySaved", { repo: savedIn, secret: CI_KEY_SECRET })}</p>
          <p>{t("common:deploy.ci.stepLead")}</p>
          <div className="relative">
            <pre className="overflow-x-auto rounded bg-muted p-2 font-mono text-[11px]">{step}</pre>
            <Button
              variant="ghost"
              size="sm"
              className="absolute top-1 right-1"
              onClick={() => copy("step", step)}
              aria-label={t("common:deploy.ci.copyStep")}
            >
              {copied === "step" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </Button>
          </div>
        </div>
      )}

      {key && (
        <div className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs">
          <p>{t("common:deploy.ci.keyOnce")}</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate font-mono" data-testid="ci-key">{key}</code>
            <Button variant="ghost" size="sm" onClick={() => copy("key", key)} aria-label={t("common:deploy.ci.copyKey")}>
              {copied === "key" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </Button>
          </div>
          <p>{t("common:deploy.ci.stepLead")}</p>
          <div className="relative">
            <pre className="overflow-x-auto rounded bg-muted p-2 font-mono text-[11px]">{step}</pre>
            <Button
              variant="ghost"
              size="sm"
              className="absolute top-1 right-1"
              onClick={() => copy("step", step)}
              aria-label={t("common:deploy.ci.copyStep")}
            >
              {copied === "step" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-1">
        <p className="text-xs font-medium">{t("common:deploy.ci.builds")}</p>
        {builds.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("common:deploy.ci.noBuilds")}</p>
        ) : (
          <ul className="max-h-40 divide-y overflow-y-auto rounded-md border">
            {builds.map((b) => (
              <li key={b.id} className="flex items-center gap-2 px-2 py-1 text-xs">
                <span className="font-mono">{b.sha.slice(0, 7)}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {[b.ref.replace(/^refs\/heads\//, ""), b.actor, desde(b.createdAt)].filter(Boolean).join(" · ")}
                </span>
                {/* Lo escribe quien tiene la llave: sólo se abre si es una página web. */}
                {b.runUrl.startsWith("https://") && (
                  <Button variant="ghost" size="sm" aria-label={t("common:deploy.ci.openRun")} onClick={() => void openUrl(b.runUrl)}>
                    <ExternalLink className="size-3.5" />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!canDeploy || busy}
                  aria-label={t("common:deploy.ci.deployThis", { sha: b.sha.slice(0, 7) })}
                  title={t("common:deploy.ci.deployThis", { sha: b.sha.slice(0, 7) })}
                  onClick={() => onDeploy(b.sha)}
                >
                  <Rocket className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
