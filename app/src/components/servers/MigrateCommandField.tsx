import { useState } from "react";
import { toast } from "sonner";
import { useT } from "@/lib/i18n";
import { AGENT_VERSION_MIGRATES } from "@/lib/deploy";
import { useDeploymentsStore } from "@/store/deployments.store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Deployable } from "@/types/deploy";
import type { Server } from "@/types/server";

/**
 * Las migraciones del servicio: lo que corre antes de cada deploy, como un job
 * de Swarm con la imagen nueva y las mismas redes y secrets que el servicio.
 * Si falla, el servicio no se toca y el deploy cuenta como fallido.
 */
export default function MigrateCommandField({ server, deployable }: { server: Server; deployable: Deployable }) {
  const { t } = useT();
  const { setMigrateCommand } = useDeploymentsStore.getState();
  const [cmd, setCmd] = useState(deployable.migrateCommand ?? "");
  const [busy, setBusy] = useState(false);
  const dirty = cmd.trim() !== (deployable.migrateCommand ?? "");
  const oneLine = !/[\r\n]/.test(cmd);
  const agentTooOld = !!cmd.trim() && (server.agentVersion ?? 0) < AGENT_VERSION_MIGRATES;

  const save = async () => {
    setBusy(true);
    try {
      await setMigrateCommand(server.id, deployable, cmd.trim());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1">
      <Label htmlFor="dep-migrate" className="text-sm font-medium">{t("common:deploy.migrate")}</Label>
      <div className="flex gap-2">
        <Input
          id="dep-migrate"
          className="font-mono text-xs"
          placeholder="npx prisma migrate deploy"
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
        />
        <Button variant="outline" size="sm" disabled={!dirty || !oneLine || busy} onClick={() => void save()}>
          {t("common:deploy.migrateSave")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t("common:deploy.migrateLead")}</p>
      {agentTooOld && <p className="text-xs text-warning">{t("common:deploy.migrateAgentOld")}</p>}
    </div>
  );
}
