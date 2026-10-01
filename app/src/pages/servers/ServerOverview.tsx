import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Bot, Cable, Rocket, ScrollText, RefreshCw } from "lucide-react";
import { useT } from "@/lib/i18n";
import { api } from "@/lib/api";
import { desde } from "@/lib/desde";
import { AGENT_VERSION_DEPLOYS, shortRef } from "@/lib/deploy";
import { useAgentLifecycle } from "@/hooks/use-agent-lifecycle";
import { useDeploymentsStore } from "@/store/deployments.store";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { APIResponse } from "@/types/auth";
import { useServerContext } from "./ServerLayout";

const NADA: never[] = [];

interface ProvisioningRun {
  id: string;
  playbook: string;
  status: string;
  startedAt: string;
  summary: string;
}

/**
 * El resumen de un servidor: cómo se llega a él, su agente, qué se despliega
 * desde cac y qué se le ha aplicado.
 *
 * Cada tarjeta sin datos enseña **cómo empezar**, nunca un error: un servidor
 * que todavía no despliega nada desde cac está bien, sólo no ha optado. Es la
 * adopción gradual dicha en pantalla. Y un endpoint que falla deja la tarjeta
 * en su estado vacío en vez de tumbar la pantalla.
 */
export default function ServerOverview() {
  const { t } = useT();
  const { server, refreshServer } = useServerContext();
  const { busyId, error, install } = useAgentLifecycle(refreshServer);
  const deployables = useDeploymentsStore((s) => s.deployables[server.id] ?? NADA);
  const loadDeployables = useDeploymentsStore((s) => s.loadDeployables);
  const [runs, setRuns] = useState<ProvisioningRun[]>([]);

  useEffect(() => {
    void loadDeployables(server.id).catch(() => {});
    void api
      .get<APIResponse<ProvisioningRun[]>>(`/api/v1/servers/${server.id}/provisioning-runs`, true)
      .then((res) => setRuns(res?.success && Array.isArray(res.data) ? res.data : []))
      .catch(() => setRuns([]));
  }, [server.id, loadDeployables]);

  const version = server.agentVersion ?? 0;
  const agentNote = !server.hasAgentToken
    ? t("common:servers.overview.agentNoIdentity")
    : version < AGENT_VERSION_DEPLOYS
      ? t("common:servers.overview.agentOld", { version })
      : null;
  const busy = busyId === server.id;
  const last = runs[0];

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Bot className="size-4" /> {t("common:servers.overview.agent")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={server.status === "online" ? "default" : "secondary"}>{server.status}</Badge>
            {server.hasAgentToken && version > 0 && (
              <span className="text-muted-foreground">{t("common:servers.overview.agentVersion", { version })}</span>
            )}
            {server.agentSeenAt && (
              <span className="text-muted-foreground">
                {t("common:servers.overview.agentSeen", { when: desde(server.agentSeenAt) })}
              </span>
            )}
          </div>
          {agentNote && <p className="text-muted-foreground">{agentNote}</p>}
          {error && <p className="text-destructive">{error}</p>}
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void install(server)}>
            <RefreshCw className={`mr-1 size-3.5 ${busy ? "animate-spin" : ""}`} />
            {server.hasAgentToken ? t("common:admin.updateAgent") : t("common:admin.deployAgent")}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Cable className="size-4" /> {t("common:servers.overview.connection")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 font-mono text-xs text-muted-foreground">
          <p>ssh {server.sshUser}@{server.host} -p {server.sshPort}</p>
          <p>{t("common:servers.overview.agentPort", { port: server.agentPort })}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Rocket className="size-4" /> {t("common:servers.overview.deploys")}
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {deployables.length === 0 ? (
            <div className="space-y-2">
              <p className="text-muted-foreground">{t("common:servers.overview.deploysEmpty")}</p>
              <Link to={`/servers/${server.id}/services`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                {t("common:servers.overview.deploysStart")}
              </Link>
            </div>
          ) : (
            <ul className="divide-y">
              {deployables.map((d) => (
                <li key={d.id} className="flex items-center gap-2 py-1.5">
                  <span className="font-medium">{d.name}</span>
                  {d.environment && <Badge variant="outline">{d.environment}</Badge>}
                  <span className="min-w-0 flex-1 truncate text-right font-mono text-xs text-muted-foreground">
                    {d.currentImage ? shortRef(d.currentImage) : t("common:servers.overview.notDeployedYet")}
                  </span>
                  <Badge variant="secondary">{t(`common:deploy.ci.modes.${d.onCINotify}`)}</Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <ScrollText className="size-4" /> {t("common:servers.overview.provisioning")}
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {!last ? (
            <p className="text-muted-foreground">{t("common:servers.overview.provisioningEmpty")}</p>
          ) : (
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs">{last.playbook}</span>
                <Badge variant={last.status === "succeeded" ? "default" : last.status === "failed" ? "destructive" : "secondary"}>
                  {last.status}
                </Badge>
                <span className="text-xs text-muted-foreground">{desde(last.startedAt)}</span>
              </div>
              {last.summary && <pre className="overflow-x-auto font-mono text-[11px] text-muted-foreground">{last.summary}</pre>}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
