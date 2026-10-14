import { useState } from "react";
import { toast } from "sonner";
import { Hammer } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AGENT_VERSION_BUILDS } from "@/lib/deploy";
import { useT } from "@/lib/i18n";
import { phraseFor } from "@/lib/server-errors";
import { useDeploymentsStore } from "@/store/deployments.store";
import type { Deployable } from "@/types/deploy";
import type { Server } from "@/types/server";

/**
 * La rama del servicio y «Construir en el servidor».
 *
 * La rama vale para todo: un aviso del CI o un push de otra rama no toca este
 * servicio, así que prod y test pueden compartir repo. Con el build en el
 * servidor encendido, un push a esa rama (llega por la GitHub App) hace que el
 * servidor construya la imagen de ese commit y la despliegue: no hace falta un
 * CI que la publique. Los build args son los secrets del servicio marcados
 * «build» o «los dos» (pestaña Secrets).
 */
export default function BuildOnHostSection({ server, deployable }: { server: Server; deployable: Deployable }) {
  const { t } = useT();
  const setBuild = useDeploymentsStore((s) => s.setBuild);
  const [branch, setBranch] = useState(deployable.branch ?? "");
  const [on, setOn] = useState(deployable.buildOnHost ?? false);
  const [dockerfile, setDockerfile] = useState(deployable.dockerfile ?? "");
  const [context, setContext] = useState(deployable.buildContext ?? "");
  const [busy, setBusy] = useState(false);

  const dirty =
    branch.trim() !== (deployable.branch ?? "") ||
    on !== (deployable.buildOnHost ?? false) ||
    dockerfile.trim() !== (deployable.dockerfile ?? "") ||
    context.trim() !== (deployable.buildContext ?? "");
  const agentTooOld = on && (server.agentVersion ?? 0) < AGENT_VERSION_BUILDS;
  const noRepo = on && !deployable.repoFullName;

  const save = async () => {
    setBusy(true);
    try {
      await setBuild(server.id, deployable, {
        branch: branch.trim(),
        buildOnHost: on,
        dockerfile: dockerfile.trim(),
        buildContext: context.trim(),
      });
      toast.success(t("common:deploy.build.saved"));
    } catch (e) {
      toast.error(phraseFor(e instanceof Error ? e.message : String(e), t("common:deploy.build.saveFailed")));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 rounded-md border p-3" aria-labelledby="dep-build-title">
      <div className="flex items-center gap-2">
        <Hammer className="size-4 text-muted-foreground" />
        <h3 id="dep-build-title" className="text-sm font-medium">
          {t("common:deploy.build.title")}
        </h3>
      </div>

      <div className="space-y-1">
        <Label htmlFor="dep-branch" className="text-xs">
          {t("common:deploy.build.branch")}
        </Label>
        <Input
          id="dep-branch"
          className="font-mono text-xs"
          placeholder="main"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">{t("common:deploy.build.branchLead")}</p>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
        {t("common:deploy.build.onHost")}
      </label>
      <p className="text-xs text-muted-foreground">{t("common:deploy.build.onHostLead")}</p>

      {on && (
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="dep-context" className="text-xs">
              {t("common:deploy.build.context")}
            </Label>
            <Input
              id="dep-context"
              className="font-mono text-xs"
              placeholder="."
              value={context}
              onChange={(e) => setContext(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="dep-dockerfile" className="text-xs">
              {t("common:deploy.build.dockerfile")}
            </Label>
            <Input
              id="dep-dockerfile"
              className="font-mono text-xs"
              placeholder="Dockerfile"
              value={dockerfile}
              onChange={(e) => setDockerfile(e.target.value)}
            />
          </div>
        </div>
      )}

      {agentTooOld && <p className="text-xs text-warning">{t("common:deploy.build.agentOld", { version: AGENT_VERSION_BUILDS })}</p>}
      {noRepo && <p className="text-xs text-warning">{t("common:deploy.build.noRepo")}</p>}

      <Button variant="outline" size="sm" disabled={!dirty || busy || noRepo} onClick={() => void save()}>
        {t("common:deploy.build.save")}
      </Button>
    </section>
  );
}
