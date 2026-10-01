import { useEffect } from "react";
import { NavLink, Outlet, useNavigate, useOutletContext, useParams } from "react-router-dom";
import { ArrowLeft, RefreshCw, SquareTerminal } from "lucide-react";
import { useT } from "@/lib/i18n";
import { useServer } from "@/hooks/use-server";
import { useSwarm } from "@/hooks/use-swarm";
import { useTerminals } from "@/store/terminal.store";
import { useConfirm } from "@/components/ConfirmDialog";
import TerminalPanel from "@/components/terminal/TerminalPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import K8sHub from "@/pages/K8sHub";
import type { Server } from "@/types/server";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive"> = {
  online: "default",
  offline: "destructive",
  pending: "secondary",
  error: "destructive",
};

/** Lo que el layout comparte con cada pestaña. */
export interface ServerContext {
  server: Server;
  refreshServer: () => Promise<void>;
  swarm: ReturnType<typeof useSwarm>;
}

export const useServerContext = () => useOutletContext<ServerContext>();

/**
 * Un servidor: la cabecera, las pestañas y el terminal.
 *
 * El servidor sale de la URL (`useServer`), nunca del `state` del router, que
 * no sobrevive a recargar. Un kubernetes sigue con su consola, que en esta
 * tanda es de sólo lectura.
 */
export default function ServerLayout() {
  const { id } = useParams();
  const { t } = useT();
  const navigate = useNavigate();
  const { server, loading, missing, refresh } = useServer(id);

  useEffect(() => {
    if (missing) navigate("/dashboard", { replace: true });
  }, [missing, navigate]);

  if (loading || !server) {
    return <p className="p-6 text-sm text-muted-foreground">{t("common:servers.loading")}</p>;
  }
  if (server.type === "kubernetes") return <K8sHub server={server} />;
  return <SwarmLayout server={server} refreshServer={refresh} />;
}

function SwarmLayout({ server, refreshServer }: { server: Server; refreshServer: () => Promise<void> }) {
  const { t } = useT();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const swarm = useSwarm(server.host, server.agentPort);

  const abrirTerminal = useTerminals((s) => s.abrir);
  const cerrarTerminales = useTerminals((s) => s.cerrarTodas);
  const maximizado = useTerminals((s) => s.maximizado);
  const sesiones = useTerminals((s) => s.sesiones);

  // Los terminales viven en el layout y no en una pestaña: cambiar de pestaña
  // no los cierra, salir del servidor sí. Sin esto quedaría un `ssh` por
  // sesión sin nada que lo represente en la UI: vivo, invisible e imposible de
  // cerrar salvo reiniciando la app.
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

  const tabs = [
    { to: "", end: true, label: t("common:servers.tabs.overview") },
    { to: "services", label: `${t("common:servers.tabs.services")}${swarm.loading ? "" : ` (${swarm.services.length})`}` },
    { to: "nodes", label: `${t("common:servers.tabs.nodes")}${swarm.loading ? "" : ` (${swarm.nodes.length})`}` },
    { to: "stats", label: t("common:servers.tabs.stats") },
    { to: "secrets", label: t("common:servers.tabs.secrets") },
  ];

  const context: ServerContext = { server, refreshServer, swarm };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <header className="flex shrink-0 items-center gap-3 border-b px-6 py-3">
        <Button variant="ghost" size="sm" onClick={() => void volver()} aria-label={t("common:servers.back")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex flex-1 items-center gap-3">
          <span className="text-lg font-semibold">{server.name}</span>
          <span className="font-mono text-sm text-muted-foreground">
            {server.host}:{server.agentPort}
          </span>
          <Badge variant={STATUS_VARIANT[server.status] ?? "secondary"}>{server.status}</Badge>
        </div>
        <Button
          variant="outline"
          size="sm"
          title={t("common:servers.terminalTitle")}
          onClick={() => abrirTerminal(server, { kind: "host" })}
        >
          <SquareTerminal className="mr-1 h-4 w-4" />
          {t("common:servers.terminal")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void Promise.all([refreshServer(), swarm.refresh()])}
          disabled={swarm.loading}
        >
          <RefreshCw className={`mr-1 h-4 w-4 ${swarm.loading ? "animate-spin" : ""}`} />
          {t("common:servers.refresh")}
        </Button>
      </header>

      <nav className="flex shrink-0 border-b px-6" aria-label={t("common:servers.tabsLabel")}>
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) =>
              `px-4 py-2 text-sm font-medium transition-colors ${
                isActive ? "border-b-2 border-primary text-foreground" : "text-muted-foreground hover:text-foreground"
              }`
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>

      <main
        className={`min-h-0 flex-1 flex-col gap-4 overflow-auto p-6 ${maximizado && sesiones.length > 0 ? "hidden" : "flex"}`}
      >
        {swarm.error && (
          <div className="shrink-0 rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {swarm.error}
          </div>
        )}
        <Outlet context={context} />
      </main>

      <TerminalPanel />
    </div>
  );
}
