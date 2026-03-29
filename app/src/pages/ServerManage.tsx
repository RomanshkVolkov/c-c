import { useState, useEffect, useRef, useMemo } from "react";
import AnsiToHtml from "ansi-to-html";
import { useNavigate, useLocation } from "react-router-dom";
import { ArrowLeft, RefreshCw, Terminal, X, RotateCcw, KeyRound } from "lucide-react";
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
import { useSwarm } from "@/hooks/use-swarm";

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
        ? "text-yellow-500"
        : "text-green-500";
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
    <Card className="mt-4">
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
            className={`h-2 w-2 rounded-full ${status === "connected" ? "bg-green-500" : status === "error" ? "bg-destructive" : "bg-yellow-500 animate-pulse"}`}
          />
          {status === "connecting" && "Connecting..."}
          {status === "connected" && "Streaming"}
          {status === "reconnecting" && "Reconnecting..."}
          {status === "error" &&
            "Connection failed — agent may be unreachable or endpoint not available"}
        </div>
        <div className="bg-linear-to-r from-zinc-700 to-zinc-900 rounded-md p-3 h-72 overflow-y-auto font-mono text-sm text-green-400">
          {logs.length === 0 ? (
            <span className="text-muted-foreground">Waiting for logs...</span>
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
  onLogsClick,
  onSecretsClick,
}: {
  services: SwarmService[];
  host: string;
  agentPort: number;
  onLogsClick: (svc: SwarmService) => void;
  onSecretsClick: (svc: SwarmService) => void;
}) {
  if (services.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">
        No services found.
      </p>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Image</TableHead>
          <TableHead>Stack</TableHead>
          <TableHead>Replicas</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Updated</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {services.map((svc) => (
          <TableRow key={svc.id}>
            <TableCell className="font-medium">{svc.name}</TableCell>
            <TableCell className="font-mono text-xs text-muted-foreground max-w-48 truncate">
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
            <TableCell>
              {svc.stack ? (
                <Badge variant="secondary">{svc.stack}</Badge>
              ) : (
                <span className="text-muted-foreground text-xs">—</span>
              )}
            </TableCell>
            <TableCell>
              <ReplicasBadge replicas={svc.replicas} />
            </TableCell>
            <TableCell>
              <ServiceStatusBadge replicas={svc.replicas} />
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">
              {new Date(svc.updatedAt).toLocaleString()}
            </TableCell>
            <TableCell className="text-right space-x-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onLogsClick(svc)}
              >
                <Terminal className="h-3 w-3 mr-1" />
                Logs
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  fetch(
                    `http://${host}:${agentPort}/api/v1/services/${svc.id}/force-update`,
                    { method: "POST" },
                  )
                }
              >
                <RotateCcw className="h-3 w-3 mr-1" />
                Restart
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onSecretsClick(svc)}
              >
                <KeyRound className="h-3 w-3 mr-1" />
                Secrets
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function NodesTab({ nodes }: { nodes: SwarmNode[] }) {
  if (nodes.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">
        No nodes found.
      </p>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Hostname</TableHead>
          <TableHead>Role</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Availability</TableHead>
          <TableHead>Engine</TableHead>
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

export default function ServerManage() {
  const navigate = useNavigate();
  const { state } = useLocation();
  const server = state as Server | null;

  const [tab, setTab] = useState<"services" | "nodes">("services");
  const [selectedService, setSelectedService] = useState<SwarmService | null>(
    null,
  );

  useEffect(() => {
    if (!server) navigate("/dashboard", { replace: true });
  }, [server, navigate]);

  const { services, nodes, loading, error, refresh } = useSwarm(
    server?.host ?? "",
    server?.agentPort ?? 0,
  );

  if (!server) return null;

  const tabClass = (t: typeof tab) =>
    `px-4 py-2 text-sm font-medium transition-colors cursor-pointer ${
      tab === t
        ? "border-b-2 border-primary text-foreground"
        : "text-muted-foreground hover:text-foreground"
    }`;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b px-6 py-3 flex items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate("/dashboard")}
        >
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
          onClick={refresh}
          disabled={loading}
        >
          <RefreshCw
            className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </header>

      <main className="flex-1 p-6 space-y-4">
        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
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
                Loading...
              </p>
            ) : tab === "services" ? (
              <ServicesTab
                services={services}
                host={server.host}
                agentPort={server.agentPort}
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
    </div>
  );
}
