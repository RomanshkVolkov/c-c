import { fechaYHora } from "@/lib/fechas";
import { useT } from "@/lib/i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import AnsiToHtml from "ansi-to-html";
import { useNavigate } from "react-router-dom";
import { KeyRound, RotateCcw, Rocket, Search, SquareTerminal, Terminal, X } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import DeployDialog from "@/components/servers/DeployDialog";
import { agentBase, agentFetch, agentStreamUrl } from "@/lib/agent";
import { goInOrg } from "@/lib/ir-en-org";
import { useTerminals } from "@/store/terminal.store";
import type { SwarmService } from "@/types/swarm";
import { useServerContext } from "./ServerLayout";

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
    // Con el pase en la URL: `EventSource` no manda cabeceras. Ver agentStreamUrl.
    let es: EventSource | null = null;
    let cerrado = false;
    let errorCount = 0;

    void agentStreamUrl(`${agentBase(host, agentPort)}/api/v1/services/${service.id}/logs`).then((url) => {
      if (cerrado) return;
      const fuente = new EventSource(url);
      es = fuente;

      fuente.onopen = () => {
        setStatus("connected");
        errorCount = 0;
      };

      fuente.onmessage = (e) => {
        errorCount = 0;
        setLogs((prev) => {
          const next = [...prev, e.data];
          return next.length > 500 ? next.slice(next.length - 500) : next;
        });
      };

      fuente.onerror = () => {
        errorCount++;
        if (errorCount >= 3) {
          setStatus("error");
          fuente.close();
        } else {
          setStatus("reconnecting");
        }
      };
    });

    return () => {
      cerrado = true;
      es?.close();
    };
  }, [service.id, host, agentPort]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  return (
    // `shrink-0`: el panel tiene su alto y no lo negocia. Quien cede es la
    // tabla de arriba, que puede desplazarse dentro de lo suyo.
    <Card className="flex shrink-0 flex-col">
      <CardHeader className="flex shrink-0 flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Terminal className="h-4 w-4" />
          {t("common:servers.logsOf", { name: service.name })}
        </CardTitle>
        <span className="flex items-center gap-1">
          {/* Limpiar la vista, que no existía: un servicio hablador llena las
              quinientas líneas en un minuto y no había forma de dejarlo en
              blanco para ver qué pasa **a partir de ahora**. No corta el flujo
              —sigue conectado— sólo vacía lo que hay en pantalla. */}
          <Button variant="ghost" size="sm" onClick={() => setLogs([])} disabled={logs.length === 0}>
            {t("common:servers.clearLogs")}
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </span>
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
        {/* Alto máximo, no fijo.
            
            Con `h-100` el panel reservaba veinticinco rem hubiera o no logs, y
            entre eso y la tabla de arriba no cabían los dos: `main` recorta lo
            que sobra y lo que sobraba era este panel. Con `max-h` se queda
            pequeño mientras hay poco y deja de robar sitio. */}
        <div className="bg-linear-to-r from-zinc-700 to-zinc-900 rounded-md p-3 max-h-100 min-h-32 overflow-auto whitespace-pre font-mono text-sm text-green-400">
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
  onDeployClick,
}: {
  services: SwarmService[];
  host: string;
  agentPort: number;
  filter: string;
  onFilterChange: (v: string) => void;
  onLogsClick: (svc: SwarmService) => void;
  onSecretsClick: (svc: SwarmService) => void;
  onShellClick: (svc: SwarmService) => void;
  onDeployClick: (svc: SwarmService) => void;
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
          onDeployClick={onDeployClick}
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
  onDeployClick,
}: {
  services: SwarmService[];
  host: string;
  agentPort: number;
  onLogsClick: (svc: SwarmService) => void;
  onSecretsClick: (svc: SwarmService) => void;
  onShellClick: (svc: SwarmService) => void;
  onDeployClick: (svc: SwarmService) => void;
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
      <TableBody className="block">
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
              {fechaYHora(svc.updatedAt)}
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
              <Button variant="ghost" size="sm" onClick={() => onDeployClick(svc)}>
                <Rocket className="h-3 w-3 mr-1" />
                {t("common:deploy.deploy")}
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

/** La pestaña de servicios de un swarm: cada uno con sus logs, reinicio, deploy, shell y secrets. */
export default function ServerServices() {
  const { server, swarm } = useServerContext();
  const navigate = useNavigate();
  const abrirTerminal = useTerminals((s) => s.abrir);
  const [selectedService, setSelectedService] = useState<SwarmService | null>(null);
  const [filter, setFilter] = useState("");
  const [deployFor, setDeployFor] = useState<SwarmService | null>(null);
  const { t } = useT();

  if (swarm.loading && swarm.services.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">{t("common:servers.loading")}</p>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <Card className="flex min-h-0 flex-1 flex-col">
        <CardContent className="min-h-0 flex-1 overflow-auto pt-4">
          <ServicesTab
            services={swarm.services}
            host={server.host}
            agentPort={server.agentPort}
            filter={filter}
            onFilterChange={setFilter}
            onLogsClick={(svc) => setSelectedService((prev) => (prev?.id === svc.id ? null : svc))}
            // El servicio va en la URL, no en el `state` del router: así la
            // pantalla de secrets aguanta una recarga.
            onSecretsClick={(svc) => navigate(`/servers/${server.id}/secrets?service=${encodeURIComponent(svc.name)}`)}
            onShellClick={(svc) => abrirTerminal(server, { kind: "service", name: svc.name })}
            onDeployClick={setDeployFor}
          />
        </CardContent>
      </Card>

      {deployFor && (
        <DeployDialog
          server={server}
          service={deployFor}
          open
          onOpenChange={(v) => !v && setDeployFor(null)}
          onOpenActivity={(deployableId, orgId) => goInOrg(navigate, `/activity?deployable=${deployableId}`, orgId)}
        />
      )}

      {selectedService && (
        <LogsPanel
          service={selectedService}
          host={server.host}
          agentPort={server.agentPort}
          onClose={() => setSelectedService(null)}
        />
      )}
    </div>
  );
}
