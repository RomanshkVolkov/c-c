import { useState } from "react";
import { ChevronRight, Wrench } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";

import PanelRow from "@/components/sidebar/PanelRow";
import { useServers } from "@/hooks/use-servers";
import { useT } from "@/lib/i18n";
import { DEV_TOOLS, navItem, visibleNavItems } from "@/lib/nav";
import { isWebBuild } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/store/auth.store";
import type { Server } from "@/types/server";

/**
 * Plataforma: los servidores, uno a uno, y lo que los rodea.
 *
 * Los servidores van listados —no sólo contados como en el riel— porque cada
 * uno es un sitio al que se entra (`/servers/<id>`), y con un punto de estado
 * que dice si contesta. En la web no hay servidores: se gestionan desde el
 * escritorio, y `useServers` ya devuelve vacío en ese build.
 *
 * Sin sesión sólo quedan las herramientas de invitado: es lo único de la app
 * que funciona sin servidor, y por donde empieza quien entra sin cuenta.
 */
const STATUS_DOT: Record<Server["status"], string> = {
  online: "bg-success",
  offline: "bg-destructive",
  error: "bg-destructive",
  pending: "bg-muted-foreground/50",
};

export default function PlatformPanel() {
  const { t } = useT();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const authed = useAuthStore((s) => !!s.accessToken);
  const superadmin = useAuthStore((s) => !!s.session?.superadmin);
  const { servers } = useServers();
  const items = visibleNavItems({ authed, superadmin, web: isWebBuild }).filter((i) => i.group === "platform");
  const serversItem = navItem("/dashboard");
  const showServers = authed && !isWebBuild;
  const rest = items.filter((i) => i.path !== "/dashboard");
  const isAt = (path: string) => pathname === path || pathname.startsWith(path + "/");

  return (
    <div className="flex flex-col px-1">
      {showServers && (
        <>
          <PanelRow
            icon={<serversItem.icon />}
            label={t(serversItem.labelKey)}
            active={pathname === "/dashboard"}
            onClick={() => navigate("/dashboard")}
          />
          {servers.length === 0 ? (
            <p className="px-4 pb-1 text-xs text-muted-foreground">{t("nav:panel.noServers")}</p>
          ) : (
            servers.map((sv) => (
              <PanelRow
                key={sv.id}
                depth={1}
                icon={
                  <span
                    className={cn("size-2 rounded-full", STATUS_DOT[sv.status])}
                    title={t(`nav:panel.serverStatus.${sv.status}`)}
                    aria-label={t(`nav:panel.serverStatus.${sv.status}`)}
                    role="img"
                  />
                }
                label={sv.name}
                active={isAt(`/servers/${sv.id}`)}
                onClick={() => navigate(`/servers/${sv.id}`)}
              />
            ))
          )}
        </>
      )}
      {rest.map((item) => (
        <PanelRow
          key={item.path}
          icon={<item.icon />}
          label={t(item.labelKey)}
          active={isAt(item.path)}
          onClick={() => navigate(item.path)}
        />
      ))}
      {!isWebBuild && <DevToolsMenu />}
    </div>
  );
}

/** DevTools, folded into one row that opens onto the tools you can use. */
function DevToolsMenu() {
  const { t } = useT();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const authed = useAuthStore((s) => !!s.accessToken);
  const inside = pathname.startsWith("/devtools");
  const [open, setOpen] = useState(inside);
  const tools = DEV_TOOLS.filter((tool) => authed || tool.guest);

  return (
    <div>
      <PanelRow
        icon={<Wrench />}
        label={t("common:misc.devtools")}
        active={inside}
        badge={<ChevronRight className={cn("ml-auto size-3.5 transition-transform", open && "rotate-90")} />}
        onClick={() => {
          // Clicking the parent both opens the list and goes somewhere: a row
          // that only expands makes you click twice to reach anything.
          setOpen(true);
          if (!inside) navigate(tools[0]?.path ?? "/devtools");
        }}
      />
      {open &&
        tools.map((tool) => (
          <PanelRow
            key={tool.path}
            depth={1}
            icon={<tool.icon />}
            label={t(tool.labelKey)}
            active={pathname.startsWith(tool.path)}
            onClick={() => navigate(tool.path)}
          />
        ))}
    </div>
  );
}
