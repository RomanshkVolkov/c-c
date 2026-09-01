import { useT } from "@/lib/i18n";
import { useState, useEffect, useRef, useMemo } from "react";
import AnsiToHtml from "ansi-to-html";
import { useNavigate, useLocation } from "react-router-dom";
import {
  Activity,
  ArrowLeft,
  RefreshCw,
  Search,
  Terminal,
  X,
  RotateCcw,
  KeyRound,
  SquareTerminal,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Server } from "@/types/server";
import type { SwarmService, SwarmNode } from "@/types/swarm";
import K8sHub from "@/pages/K8sHub";
import { useSwarm } from "@/hooks/use-swarm";
import { agentBase, agentFetch } from "@/lib/agent";
import TerminalPanel from "@/components/terminal/TerminalPanel";
import { useTerminals } from "@/store/terminal.store";
import { useConfirm } from "@/components/ConfirmDialog";
import { toast } from "sonner";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive"> =
  {
    online: "default",
    offline: "destructive",
    pending: "secondary",
    error: "destructive",
  };

function ReplicasBadge({ replicas }: { replicas: SwarmService["replicas"] }) {
  const { running, desired } = replicas;
  const color =
    running === 0
      ? "text-destructive"
      : running < desired
        ? "text-warning"
        : "text-success";
  return (
    <span className={`font-mono text-sm font-medium ${color}`}>
      {running}/{desired}
    </span>
  );
}

function ServiceStatusBadge({
  replicas,
}: {
  replicas: SwarmService["replicas"];
}) {
  const { running, desired } = replicas;
  if (running === 0) return <Badge variant="destructive">down</Badge>;
  if (running < desired) return <Badge variant="secondary">degraded</Badge>;
  return <Badge variant="default">healthy</Badge>;
}

function LogsPanel({
  service,
  host,
  agentPort,
  onClose,
}: {
  service: SwarmService;
  host: string;
  agentPort: number;
  onClose: () => void;
}) {
  const { t } = useT();
  const [logs, setLogs] = useState<string[]>([]);
  const [status, setStatus] = useState<
    "connecting" | "connected" | "reconnecting" | "error"
  >("connecting");
  const bottomRef = useRef<HTMLDivElement>(null);
  const converter = useMemo(() => new AnsiToHtml({ escapeXML: true }), []);

  useEffect(() => {
    setLogs([]);
    setStatus("connecting");
    const url = `http://${host}:${agentPort}/api/v1/services/${service.id}/logs`;
    const es = new EventSource(url);
    let errorCount = 0;

    es.onopen = () => {
      setStatus("connected");
      errorCount = 0;
    };

    es.onmessage = (e) => {
      errorCount = 0;
      setLogs((prev) => {
        const next = [...prev, e.data];
        return next.length > 500 ? next.slice(next.length - 500) : next;
      });
    };

    es.onerror = () => {
      errorCount++;
      if (errorCount >= 3) {
        setStatus("error");
        es.close();
      } else {
        setStatus("reconnecting");
      }
    };

    return () => es.close();
  }, [service.id, host, agentPort]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Terminal className="h-4 w-4" />
          Logs — {service.name}
        </CardTitle>
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-2 mb-2 text-xs text-muted-foreground">
          <span
            className={`h-2 w-2 rounded-full ${status === "connected" ? "bg-success" : status === "error" ? "bg-destructive" : "bg-yellow-500 animate-pulse"}`}
          />
          {status === "connecting" && t("common:servers.connecting")}
          {status === "connected" && t("common:servers.streaming")}
          {status === "reconnecting" && t("common:servers.reconnecting")}
          {status === "error" &&
            t("common:servers.connectionFailed")}
        </div>
        {/* overflow-auto, not just -y: server logs are column-aligned tables and
            a long row has to scroll here rather than widen the page. And
            whitespace-pre so those columns stay lined up — wrapping turns a
            readable table into rubble. */}
        <div className="bg-linear-to-r from-zinc-700 to-zinc-900 rounded-md p-3 h-100 overflow-auto whitespace-pre font-mono text-sm text-green-400">
          {logs.length === 0 ? (
            <span className="text-muted-foreground">{t("common:servers.waitingForLogs")}</span>
          ) : (
            logs.map((line, i) => (
              <div
                key={i}
                dangerouslySetInnerHTML={{ __html: converter.toHtml(line) }}
              />
            ))
          )}
          <div ref={bottomRef} />
        </div>
      </CardContent>
    </Card>
  );
}

function ServicesTab({
  services,
  host,
  agentPort,
  filter,
  onFilterChange,
  onLogsClick,
  onSecretsClick,
  onShellClick,
}: {
  services: SwarmService[];
  host: string;
  agentPort: number;
  filter: string;
  onFilterChange: (v: string) => void;
  onLogsClick: (svc: SwarmService) => void;
  onSecretsClick: (svc: SwarmService) => void;
  onShellClick: (svc: SwarmService) => void;
}) {
  const { t } = useT();
  const needle = filter.trim().toLowerCase();
  const filtered = needle
    ? services.filter((s) => {
        const haystack = `${s.name} ${s.image} ${s.stack ?? ""}`.toLowerCase();
        return haystack.includes(needle);
      })
    : services;

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          value={filter}
          onChange={(e) => onFilterChange(e.target.value)}
          placeholder={t("common:servers.filterServices")}
          className="pl-9 pr-9"
        />
        {filter && (
          <button
            type="button"
            onClick={() => onFilterChange("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            aria-label={t("common:servers.clearFilter")}
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {services.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          {t("common:servers.noServices")}
        </p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          No matches for "{filter}".
        </p>
      ) : (
        <ServicesTable
          services={filtered}
          host={host}
          agentPort={agentPort}
          onLogsClick={onLogsClick}
          onSecretsClick={onSecretsClick}
          onShellClick={onShellClick}
        />
      )}

      {needle && (
        <p className="text-xs text-muted-foreground text-right">
          Showing {filtered.length} of {services.length}
        </p>
      )}
    </div>
  );
}

function ServicesTable({
  services,
  host,
  agentPort,
  onLogsClick,
  onSecretsClick,
  onShellClick,
}: {
  services: SwarmService[];
  host: string;
  agentPort: number;
  onLogsClick: (svc: SwarmService) => void;
  onSecretsClick: (svc: SwarmService) => void;
  onShellClick: (svc: SwarmService) => void;
}) {
  const { t } = useT();
  return (
    <Table>
      <TableHeader className="block">
        <TableRow className="flex w-full">
          <TableHead className="flex-2 min-w-0">{t("common:servers.thName")}</TableHead>
          <TableHead className="flex-3 min-w-0">{t("common:servers.thImage")}</TableHead>
          <TableHead className="flex-3 min-w-0">{t("common:servers.thStack")}</TableHead>
          <TableHead className="flex-1 min-w-0">{t("common:servers.thReplicas")}</TableHead>
          <TableHead className="flex-1 min-w-0">{t("common:servers.thStatus")}</TableHead>
          <TableHead className="flex-2 min-w-0">{t("common:servers.thUpdated")}</TableHead>
          {/* Ancho fijo, y en la cabecera **y** en el cuerpo o se desalinean:
              esto es una tabla hecha con flex, así que cada celda calcula su
              ancho por su cuenta.

              Fijo y no proporcional porque su contenido no es texto que pueda
              truncarse: son cuatro botones, y recortar uno lo deja inservible.
              Con `flex-3` la columna se quedaba corta en cuanto las etiquetas
              crecían —«Restart» son siete caracteres y «Reiniciar» nueve— y
              «Secrets» salía cortado contra el borde con una barra de scroll
              horizontal.

              La variación de ancho entre idiomas se la llevan nombre, imagen y
              stack, que ya truncan y enseñan el valor entero en un tooltip. */}
          <TableHead className="w-96 shrink-0 text-right">{t("common:servers.thActions")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody className="block max-h-105 overflow-y-auto">
        {services.map((svc) => (
          <TableRow key={svc.id} className="flex w-full">
            <TableCell className="flex-2 min-w-0 font-medium truncate">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger>
                    <span className="truncate block">{svc.name}</span>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="font-mono text-xs">{svc.name}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </TableCell>
            <TableCell className="flex-3 min-w-0 font-mono text-xs text-muted-foreground truncate">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger>
                    <span className="truncate block">{svc.image}</span>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="font-mono text-xs">{svc.image}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </TableCell>
            <TableCell className="flex-3 min-w-0">
              {svc.stack ? (
                <Badge variant="secondary" className="truncate">
                  {svc.stack}
                </Badge>
              ) : (
                <span className="text-muted-foreground text-xs">—</span>
              )}
            </TableCell>
            <TableCell className="flex-1 min-w-0">
              <ReplicasBadge replicas={svc.replicas} />
            </TableCell>
            <TableCell className="flex-1 min-w-0">
              <ServiceStatusBadge replicas={svc.replicas} />
            </TableCell>
            <TableCell className="flex-2 min-w-0 text-xs text-muted-foreground">
              {new Date(svc.updatedAt).toLocaleString()}
            </TableCell>
            <TableCell className="w-96 shrink-0 text-right space-x-1 whitespace-nowrap">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onLogsClick(svc)}
              >
                <Terminal className="h-3 w-3 mr-1" />
                {t("common:servers.logs")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  try {
                    await agentFetch(
                      `${agentBase(host, agentPort)}/api/v1/services/${svc.id}/force-update`,
                      { method: "POST" },
                    );
                    toast.success(t("common:last.restarting", { name: svc.name }));
                  } catch (e) {
                    toast.error(t("common:servers.restartFailed"), {
                      description: e instanceof Error ? e.message : String(e),
                    });
                  }
                }}
              >
                <RotateCcw className="h-3 w-3 mr-1" />
                {t("common:servers.restart")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onShellClick(svc)}
                title={t("common:servers.shellTitle")}
              >
                <SquareTerminal className="h-3 w-3 mr-1" />
                {t("common:servers.shell")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onSecretsClick(svc)}
              >
                <KeyRound className="h-3 w-3 mr-1" />
                {t("common:servers.secrets")}
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function NodesTab({ nodes }: { nodes: SwarmNode[] }) {
  const { t } = useT();
  if (nodes.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">
        {t("common:servers.noNodes")}
      </p>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("common:servers.thHostname")}</TableHead>
          <TableHead>{t("common:servers.thRole")}</TableHead>
          <TableHead>{t("common:servers.thStatus")}</TableHead>
          <TableHead>{t("common:servers.thAvailability")}</TableHead>
          <TableHead>{t("common:servers.thEngine")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {nodes.map((node) => (
          <TableRow key={node.id}>
            <TableCell className="font-medium">{node.hostname}</TableCell>
            <TableCell>
              <Badge
                variant={node.role === "manager" ? "default" : "secondary"}
              >
                {node.role}
              </Badge>
            </TableCell>
            <TableCell>
              <Badge
                variant={node.status === "ready" ? "default" : "destructive"}
              >
                {node.status}
              </Badge>
            </TableCell>
            <TableCell>
              <Badge
                variant={
                  node.availability === "active" ? "default" : "secondary"
                }
              >
                {node.availability}
              </Badge>
            </TableCell>
            <TableCell className="font-mono text-xs text-muted-foreground">
              {node.engineVersion}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ServerManage routes to the right console based on the server's orchestrator:
// docker-swarm → the swarm manager below; kubernetes → the platform hub.
export default function ServerManage() {
  const navigate = useNavigate();
  const { state } = useLocation();
  const server = state as Server | null;

  useEffect(() => {
    if (!server) navigate("/dashboard", { replace: true });
  }, [server, navigate]);

  if (!server) return null;
  if (server.type === "kubernetes") return <K8sHub server={server} />;
  return <SwarmManage server={server} />;
}

function SwarmManage({ server }: { server: Server }) {
  const { t } = useT();
  const navigate = useNavigate();
  const confirm = useConfirm();

  const abrirTerminal = useTerminals((s) => s.abrir);
  const cerrarTerminales = useTerminals((s) => s.cerrarTodas);
  const maximizado = useTerminals((s) => s.maximizado);
  const sesiones = useTerminals((s) => s.sesiones);

  // Los terminales viven en esta pantalla, así que salir de ella los cierra.
  // Sin esto quedaría un `ssh` por sesión sin nada que lo represente en la UI:
  // vivo, invisible e imposible de cerrar salvo reiniciando la app.
  useEffect(() => cerrarTerminales, [cerrarTerminales]);

  const volver = async () => {
    const vivas = useTerminals.getState().sesiones.filter((s) => s.estado === "viva");
    if (vivas.length > 0) {
      const ok = await confirm({
        title:
          vivas.length === 1
            ? t("common:servers.closeOneTerminal")
            : t("common:servers.closeManyTerminals", { count: vivas.length }),
        description: t("common:servers.closeTerminalsBody"),
        confirmText: t("common:servers.leave"),
        destructive: true,
      });
      if (!ok) return;
    }
    navigate("/dashboard");
  };

  const [tab, setTab] = useState<"services" | "nodes">("services");
  const [selectedService, setSelectedService] = useState<SwarmService | null>(
    null,
  );
  const [servicesFilter, setServicesFilter] = useState("");

  const { services, nodes, loading, error, refresh } = useSwarm(
    server.host,
    server.agentPort,
  );

  const tabClass = (t: typeof tab) =>
    `px-4 py-2 text-sm font-medium transition-colors cursor-pointer ${
      tab === t
        ? "border-b-2 border-primary text-foreground"
        : "text-muted-foreground hover:text-foreground"
    }`;

  return (
    <div className="h-full bg-background flex flex-col overflow-hidden">
      <header className="shrink-0 border-b px-6 py-3 flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={volver}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex items-center gap-3 flex-1">
          <span className="font-semibold text-lg">{server.name}</span>
          <span className="font-mono text-sm text-muted-foreground">
            {server.host}:{server.agentPort}
          </span>
          <Badge variant={STATUS_VARIANT[server.status] ?? "secondary"}>
            {server.status}
          </Badge>
        </div>
        <Button
          variant="outline"
          size="sm"
          title={t("common:servers.terminalTitle")}
          onClick={() => abrirTerminal(server, { kind: "host" })}
        >
          <SquareTerminal className="h-4 w-4 mr-1" />
          {t("common:servers.terminal")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            navigate(`/servers/${server.id}/stats`, {
              state: { server, nodes },
            })
          }
        >
          <Activity className="h-4 w-4 mr-1" />
          {t("common:servers.stats")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={refresh}
          disabled={loading}
        >
          <RefreshCw
            className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`}
          />
          {t("common:servers.refresh")}
        </Button>
      </header>

      <main
        className={`flex-1 flex-col min-h-0 p-6 gap-4 overflow-hidden ${
          maximizado && sesiones.length > 0 ? "hidden" : "flex"
        }`}
      >
        {error && (
          <div className="shrink-0 rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <Card>
          <CardHeader className="pb-0">
            <div className="flex border-b -mx-6 px-6">
              <button
                className={tabClass("services")}
                onClick={() => setTab("services")}
              >
                Services {!loading && `(${services.length})`}
              </button>
              <button
                className={tabClass("nodes")}
                onClick={() => setTab("nodes")}
              >
                Nodes {!loading && `(${nodes.length})`}
              </button>
            </div>
          </CardHeader>
          <CardContent className="pt-4">
            {loading ? (
              <p className="text-sm text-muted-foreground py-8 text-center">
                {t("common:servers.loading")}
              </p>
            ) : tab === "services" ? (
              <ServicesTab
                services={services}
                host={server.host}
                agentPort={server.agentPort}
                filter={servicesFilter}
                onFilterChange={setServicesFilter}
                onLogsClick={(svc) =>
                  setSelectedService((prev) =>
                    prev?.id === svc.id ? null : svc,
                  )
                }
                onSecretsClick={(svc) =>
                  navigate(`/servers/${server.id}/secrets`, {
                    state: { server, service: svc, services },
                  })
                }
                onShellClick={(svc) =>
                  abrirTerminal(server, { kind: "service", name: svc.name })
                }
              />
            ) : (
              <NodesTab nodes={nodes} />
            )}
          </CardContent>
        </Card>

        {selectedService && (
          <LogsPanel
            service={selectedService}
            host={server.host}
            agentPort={server.agentPort}
            onClose={() => setSelectedService(null)}
          />
        )}
      </main>

      <TerminalPanel />
    </div>
  );
}
