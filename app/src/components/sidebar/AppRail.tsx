import type { ReactNode } from "react";
import { Building2, LogIn } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";

import AccountMenu from "@/components/AccountMenu";
import { BrandMark } from "@/components/brand/Brand";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSidebar } from "@/components/ui/sidebar";
import VoiceMini from "@/components/voice/VoiceMini";
import { useCommsUnread } from "@/hooks/use-comms-unread";
import { useServers } from "@/hooks/use-servers";
import { useT } from "@/lib/i18n";
import { moduleHome, visibleModules, type NavModule } from "@/lib/nav";
import { isWebBuild } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/store/auth.store";
import { useInvitationsStore } from "@/store/invitations.store";
import { useLayoutStore } from "@/store/layout.store";

/**
 * El riel: un icono por módulo, siempre a la vista.
 *
 * Es lo que queda del sidebar cuando se pliega, y lo que no cambia al cambiar
 * de módulo. Cada icono lleva su nombre en un tooltip y el activo va marcado:
 * un riel de iconos sin etiqueta es el patrón que las guías de navegación
 * piden evitar, y aquí el nombre se repite además en la cabecera del panel.
 *
 * Pulsar un módulo te devuelve a donde estabas en él —la última ruta que se
 * apuntó—, no a su portada; y pulsar el activo con el panel plegado lo abre:
 * un clic para ver el contenido, sin otro para desplegarlo.
 *
 * Abajo, lo que no es navegación: la llamada en curso (sólo plegado; abierto
 * la lleva el panel), la organización y la cuenta.
 */
export default function AppRail({
  onChangePassword,
  onConnectMcp,
  onNotificationPrefs,
}: {
  onChangePassword: () => void;
  onConnectMcp?: () => void;
  onNotificationPrefs: () => void;
}) {
  const { t } = useT();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const authed = useAuthStore((s) => !!s.accessToken);
  const { open, setOpen } = useSidebar();
  const activeModule = useLayoutStore((s) => s.activeModule);
  const lastRoute = useLayoutStore((s) => s.lastRoute);
  const pendingInvites = useInvitationsStore((s) => s.pending.length);
  // Sólo lo de la org en pantalla. Ver `lib/unread.ts`.
  const { channels, dms } = useCommsUnread();
  // Servers that are not simply running. Counted rather than listed, and drawn
  // in amber: it is a "look at this when you can", not an outage — an outage
  // announces itself elsewhere.
  const serversNeedingAttention = useServers().servers.filter((sv) => sv.status !== "online").length;

  const modules = visibleModules({ authed });
  // La ruta decide qué módulo manda; `activeModule` sólo cuando no es de
  // ninguno (organización, perfil), y entonces el riel marca eso otro.
  const onModuleRoute = modules.some((m) => m.key === activeModule) && !!pathname && !isAside(pathname);
  const badgeOf = (m: NavModule): { count: number; tone: "primary" | "warning" } | null => {
    if (m.key === "comms" && channels + dms > 0) return { count: channels + dms, tone: "primary" };
    if (m.key === "platform" && serversNeedingAttention > 0) return { count: serversNeedingAttention, tone: "warning" };
    return null;
  };

  const go = (m: NavModule) => {
    if (onModuleRoute && m.key === activeModule) {
      if (!open) setOpen(true);
      return;
    }
    navigate(lastRoute[m.key] ?? moduleHome(m, isWebBuild));
  };

  return (
    <nav
      aria-label={t("nav:rail.label")}
      className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-sidebar-border py-2"
    >
      <BrandMark className="mb-2 h-5 w-auto" />
      {modules.map((m) => {
        const active = onModuleRoute && m.key === activeModule;
        const badge = badgeOf(m);
        const label = badge ? `${t(m.labelKey)} (${badge.count})` : t(m.labelKey);
        return (
          <RailButton key={m.key} label={label} active={active} onClick={() => go(m)}>
            <m.icon className="size-5" />
            {badge && (
              <span
                className={cn(
                  "absolute -right-0.5 -top-0.5 min-w-4 rounded-full px-1 text-[9px] font-medium leading-4 ring-2 ring-sidebar",
                  badge.tone === "primary" ? "bg-primary text-primary-foreground" : "bg-warning text-black",
                )}
              >
                {badge.count > 99 ? "99+" : badge.count}
              </span>
            )}
          </RailButton>
        );
      })}

      <div className="mt-auto flex flex-col items-center gap-1">
        {authed && !open && <VoiceMini compacto />}
        {authed && (
          <RailButton
            label={pendingInvites > 0 ? `${t("nav:rail.organization")} (${pendingInvites})` : t("nav:rail.organization")}
            active={pathname.startsWith("/organization") || pathname.startsWith("/invitations")}
            onClick={() => navigate("/organization")}
          >
            <Building2 className="size-5" />
            {pendingInvites > 0 && (
              <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-primary px-1 text-[9px] font-medium leading-4 text-primary-foreground ring-2 ring-sidebar">
                {pendingInvites}
              </span>
            )}
          </RailButton>
        )}
        {authed ? (
          <AccountMenu
            variant="avatar"
            onChangePassword={onChangePassword}
            onConnectMcp={onConnectMcp}
            onNotificationPrefs={onNotificationPrefs}
          />
        ) : (
          <RailButton label={t("common:misc.login")} active={pathname === "/login"} onClick={() => navigate("/login")}>
            <LogIn className="size-5" />
          </RailButton>
        )}
      </div>
    </nav>
  );
}

/** Rutas que no son de ningún módulo: ahí el riel no marca ninguno. */
function isAside(pathname: string): boolean {
  return ["/organization", "/invitations", "/profile", "/login"].some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );
}

function RailButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-current={active ? "page" : undefined}
            onClick={onClick}
            className={cn(
              "relative grid size-9 place-items-center rounded-lg transition-colors",
              active
                ? "bg-sidebar-accent text-sidebar-primary before:absolute before:-left-1.5 before:inset-y-2 before:w-0.5 before:rounded-full before:bg-sidebar-primary"
                : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
            )}
          >
            {children}
          </button>
        }
      />
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}
