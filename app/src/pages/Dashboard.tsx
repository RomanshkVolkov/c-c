import { useT } from "@/lib/i18n";
import { useState } from "react";
import { Activity, KeyRound, Network, Pencil, RefreshCw, Rocket, Server, Trash2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card, CardContent, CardHeader, CardTitle,
} from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useServers } from "@/hooks/use-servers";
import AddServerDialog from "@/components/AddServerDialog";
import SshKeyDialog from "@/components/SshKeyDialog";
import EditServerDialog from "@/components/EditServerDialog";
import K8sStatusBadge from "@/components/K8sStatusBadge";
import { useConfirm } from "@/components/ConfirmDialog";
import { toast } from "sonner";
import type { Server as ServerType } from "@/types/server";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive"> = {
  online: "default",
  offline: "destructive",
  pending: "secondary",
  error: "destructive",
};

type AgentBusy = { id: string; kind: "deploy" | "update" } | null;

interface AgentResult {
  stdout: string;
  stderr: string;
}

export default function Dashboard() {
  const { t } = useT();
  const navigate = useNavigate();
  const { servers, loading, createServer, updateServer, deleteServer, refresh } = useServers();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<AgentBusy>(null);
  const [agentError, setAgentError] = useState<string | null>(null);

  // `status` only tracks the swarm-manage agent, so the count is out of swarm
  // servers — a kubernetes row has no agent and would drag the total down.
  const swarmServers = servers.filter((s) => s.type === "docker-swarm");
  const online = swarmServers.filter((s) => s.status === "online").length;
  const types = new Set(servers.map((s) => s.type)).size;

  const [keyFor, setKeyFor] = useState<ServerType | null>(null);
  const [editing, setEditing] = useState<ServerType | null>(null);

  const removeServer = async (server: ServerType) => {
    const ok = await confirm({
      title: `Delete "${server.name}"?`,
      description:
        t("common:admin.deleteServerBody"),
      confirmText: t("common:admin.delete"),
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteServer(server.id);
      toast.success(t("common:last.serverRemoved", { name: server.name }));
    } catch (e) {
      toast.error(t("common:admin.errDelete"), {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const runAgentCommand = async (
    server: ServerType,
    kind: "deploy" | "update",
  ) => {
    setBusy({ id: server.id, kind });
    setAgentError(null);
    try {
      const cmd =
        kind === "deploy"
          ? "deploy_swarm_manage_agent"
          : "update_swarm_manage_agent";
      const args: Record<string, unknown> = {
        host: server.host,
        sshPort: server.sshPort,
        sshUser: server.sshUser,
        // Pin ssh to the server's 1Password key when one is linked; otherwise
        // the agent offers every key it holds and the server may cut us off.
        identityKey: await invoke<string | null>("get_server_ssh_key", {
          serverId: server.id,
        }).catch(() => null),
      };
      if (kind === "deploy") args.agentPort = server.agentPort;
      await invoke<AgentResult>(cmd, args);
      await refresh();
    } catch (e) {
      setAgentError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    // Sin cabecera propia ni menú de cuenta: los tenía de cuando esta pantalla
    // *era* la app y se abría sola. Ahora vive dentro del armazón con barra
    // lateral, que ya pone la marca arriba y la cuenta en su pie — y aquel menú
    // era el único sitio con un «Sign out» duplicado.
    //
    // Tampoco el resumen de pendientes que iba encima. Estaba ahí porque los
    // servidores son lo que menos se toca y hacía falta que lo primero de la
    // primera pantalla fuera trabajo; eso lo contesta Resumen, que es la
    // pantalla en la que abre la app. Aquí sólo estorbaba entre el título y
    // lo que se viene a hacer.
    <div className="min-h-0 flex flex-1 flex-col overflow-auto">
      <main className="flex-1 space-y-5 p-6">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0">
            <h2 className="text-[19px] font-semibold">{t("common:admin.servers")}</h2>
            <p className="mt-0.5 max-w-2xl text-xs leading-relaxed text-muted-foreground">
              Registered VPS instances. Deploy and update use your local SSH agent;
              no key leaves your machine.
            </p>
          </div>
          <div className="ml-auto shrink-0">
            <AddServerDialog onCreated={createServer} />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">{t("common:admin.totalServers")}</CardTitle>
              <Server className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{servers.length}</div>
              <p className="text-xs text-muted-foreground">registered</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">{t("common:admin.agentsOnline")}</CardTitle>
              <Activity className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {online}
                <span className="text-base font-normal text-muted-foreground">
                  /{swarmServers.length}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">agents reachable</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">{t("common:admin.clusterTypes")}</CardTitle>
              <Network className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{types}</div>
              <p className="text-xs text-muted-foreground">orchestrators</p>
            </CardContent>
          </Card>
        </div>

        {agentError && (
          <div className="border border-destructive/40 bg-destructive/5 text-destructive px-4 py-2 rounded-md text-sm whitespace-pre-wrap font-mono">
            {agentError}
          </div>
        )}

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            {editing && (
        <EditServerDialog
          server={editing}
          onSave={updateServer}
          onClose={() => setEditing(null)}
        />
      )}
      {keyFor && (
        <SshKeyDialog
          serverId={keyFor.id}
          serverName={keyFor.name}
          open
          onOpenChange={(v) => !v && setKeyFor(null)}
        />
      )}
          </CardHeader>
          <CardContent>
            {loading ? (
              <p className="text-sm text-muted-foreground py-4 text-center">{t("common:admin.loading")}</p>
            ) : servers.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">
                {t("common:admin.noServers")}
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("common:admin.thName")}</TableHead>
                    <TableHead>{t("common:admin.thHost")}</TableHead>
                    <TableHead>{t("common:admin.thType")}</TableHead>
                    <TableHead>{t("common:admin.thStatus")}</TableHead>
                    <TableHead className="text-right">{t("common:admin.thActions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {servers.map((server) => {
                    const isBusy = busy?.id === server.id;
                    // Agent lifecycle (deploy/update/stats) is swarm-only: a
                    // kubernetes server is driven by the platform hub, and the
                    // swarm-manage agent has nothing to do there.
                    const isSwarm = server.type === "docker-swarm";
                    return (
                      <TableRow key={server.id}>
                        <TableCell className="font-medium">{server.name}</TableCell>
                        <TableCell className="font-mono text-sm text-muted-foreground">
                          {server.host}
                          {isSwarm && `:${server.agentPort}`}
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary">{server.type}</Badge>
                        </TableCell>
                        <TableCell>
                          {isSwarm ? (
                            <Badge variant={STATUS_VARIANT[server.status] ?? "secondary"}>
                              {server.status}
                            </Badge>
                          ) : (
                            <K8sStatusBadge serverId={server.id} />
                          )}
                        </TableCell>
                        <TableCell className="text-right space-x-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            title={t("common:admin.sshKey")}
                            onClick={() => setKeyFor(server)}
                          >
                            <KeyRound className="h-3 w-3" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            title={t("common:admin.editServer")}
                            onClick={() => setEditing(server)}
                          >
                            <Pencil className="h-3 w-3" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            title={t("common:admin.deleteServer")}
                            className="text-destructive hover:text-destructive"
                            onClick={() => removeServer(server)}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                          {isSwarm && (server.status === "pending" || server.status === "error") && (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={isBusy}
                              onClick={() => runAgentCommand(server, "deploy")}
                            >
                              {isBusy && busy?.kind === "deploy" ? (
                                <RefreshCw className="h-3 w-3 mr-1 animate-spin" />
                              ) : (
                                <Rocket className="h-3 w-3 mr-1" />
                              )}
                              {server.status === "error" ? t("common:admin.retryDeploy") : t("common:admin.deployAgent")}
                            </Button>
                          )}
                          {isSwarm && server.status === "online" && (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={isBusy}
                              onClick={() => runAgentCommand(server, "update")}
                            >
                              <RefreshCw
                                className={`h-3 w-3 mr-1 ${
                                  isBusy && busy?.kind === "update" ? "animate-spin" : ""
                                }`}
                              />
                              {isBusy && busy?.kind === "update" ? t("common:admin.updating") : t("common:admin.updateAgent")}
                            </Button>
                          )}
                          {isSwarm && server.status === "online" && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                navigate(`/servers/${server.id}/stats`, {
                                  state: { server },
                                })
                              }
                            >
                              <Activity className="h-3 w-3 mr-1" />
                              {t("common:admin.stats")}
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => navigate(`/servers/${server.id}`, { state: server })}
                          >
                            {t("common:admin.manage")}
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
