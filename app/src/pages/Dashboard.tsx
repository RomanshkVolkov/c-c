import { useState } from "react";
import { Activity, KeyRound, LogOut, Network, Pencil, RefreshCw, Rocket, Server, Trash2, User } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuGroup, DropdownMenuLabel, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useAuth } from "@/hooks/use-auth";
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
  const navigate = useNavigate();
  const { session, logout } = useAuth();
  const { servers, loading, createServer, updateServer, deleteServer, refresh } = useServers();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<AgentBusy>(null);
  const [agentError, setAgentError] = useState<string | null>(null);

  const handleLogout = () => { logout(); navigate("/login"); };
  const initials = session?.username?.slice(0, 2).toUpperCase() ?? "??";
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
        "Removes it from cac. The machine and anything running on it are untouched.",
      confirmText: "Delete",
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteServer(server.id);
      toast.success(`Removed ${server.name}`);
    } catch (e) {
      toast.error("Could not delete", {
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
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Server className="h-5 w-5" />
          <span className="font-semibold text-lg">CAC</span>
          <Separator orientation="vertical" className="h-5 mx-1" />
          <span className="text-muted-foreground text-sm">VPS Control Plane</span>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger className="flex items-center gap-2 px-2 py-1 rounded-md hover:bg-accent transition-colors">
            <Avatar className="h-7 w-7">
              <AvatarFallback className="text-xs">{initials}</AvatarFallback>
            </Avatar>
            <span className="text-sm">{session?.username}</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              <DropdownMenuLabel className="flex items-center gap-2">
                <User className="h-4 w-4" />
                {session?.username}
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={handleLogout} variant="destructive">
                <LogOut className="h-4 w-4" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <main className="flex-1 p-6 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Total Servers</CardTitle>
              <Server className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{servers.length}</div>
              <p className="text-xs text-muted-foreground">registered</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Agents online</CardTitle>
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
              <CardTitle className="text-sm font-medium">Cluster Types</CardTitle>
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
            <div>
              <CardTitle>Servers</CardTitle>
              <CardDescription>
                Registered VPS instances. Deploy/Update uses your local SSH agent
                (1Password recommended) — no keys leave your machine.
              </CardDescription>
            </div>
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
      <AddServerDialog onCreated={createServer} />
          </CardHeader>
          <CardContent>
            {loading ? (
              <p className="text-sm text-muted-foreground py-4 text-center">Loading...</p>
            ) : servers.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">
                No servers yet. Add one to get started.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Host</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
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
                            title="SSH key (1Password)"
                            onClick={() => setKeyFor(server)}
                          >
                            <KeyRound className="h-3 w-3" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            title="Edit server"
                            onClick={() => setEditing(server)}
                          >
                            <Pencil className="h-3 w-3" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            title="Delete server"
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
                              {server.status === "error" ? "Retry Deploy" : "Deploy Agent"}
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
                              {isBusy && busy?.kind === "update" ? "Updating..." : "Update Agent"}
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
                              Stats
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => navigate(`/servers/${server.id}`, { state: server })}
                          >
                            Manage
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
