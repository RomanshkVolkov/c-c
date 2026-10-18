import { Mail, PanelLeftClose } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { Brand } from "@/components/brand/Brand";
import OrgSwitcher from "@/components/OrgSwitcher";
import { PANELS } from "@/components/sidebar/panels";
import { Button } from "@/components/ui/button";
import { useSidebar } from "@/components/ui/sidebar";
import VoiceMini from "@/components/voice/VoiceMini";
import { useT } from "@/lib/i18n";
import { MODULES } from "@/lib/nav";
import { useAuthStore } from "@/store/auth.store";
import { useInvitationsStore } from "@/store/invitations.store";
import { useLayoutStore } from "@/store/layout.store";

/**
 * El panel: la navegación del módulo que manda, y nada del resto.
 *
 * Arriba la organización (es lo que decide qué enseña todo lo de abajo) y el
 * nombre del módulo, repetido a propósito: el icono del riel ya lo dice, pero
 * un icono es una pista y un nombre es una respuesta. Abajo, lo que pasa
 * *ahora mismo* —la llamada— y las invitaciones si hay alguna esperando: una
 * fila permanente para una lista vacía es una fila que enseña a ignorarla.
 *
 * Se esconde entero cuando el sidebar se pliega al riel
 * (`group-data-[collapsible=icon]:hidden`): el `group` es el `<Sidebar>` de
 * shadcn, que pone `data-collapsible="icon"` al plegarse.
 */
export default function AppPanel() {
  const { t } = useT();
  const navigate = useNavigate();
  const { toggleSidebar } = useSidebar();
  const authed = useAuthStore((s) => !!s.accessToken);
  const activeModule = useLayoutStore((s) => s.activeModule);
  const pendingInvites = useInvitationsStore((s) => s.pending.length);
  // Sin sesión sólo hay un módulo que funcione; el que esté apuntado puede ser
  // de cuando sí la había.
  const moduleKey = authed ? activeModule : "platform";
  const module = MODULES.find((m) => m.key === moduleKey) ?? MODULES[0];
  const Panel = PANELS[module.key];

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col group-data-[collapsible=icon]:hidden">
      <div className="p-2">
        {authed ? <OrgSwitcher /> : <Brand className="px-1 text-sm" />}
      </div>
      <div className="flex h-8 shrink-0 items-center gap-1 pl-3 pr-1">
        <h2 className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t(module.labelKey)}
        </h2>
        <Button
          size="icon-xs"
          variant="ghost"
          title={t("nav:rail.collapsePanel")}
          aria-label={t("nav:rail.collapsePanel")}
          onClick={toggleSidebar}
        >
          <PanelLeftClose className="size-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Al cambiar de módulo en el riel, el panel nuevo entra en vez de
            sustituir al anterior de golpe. */}
        <div key={module.key} className="motion-reveal">
          <Panel />
        </div>
      </div>
      {authed && (
        <div className="shrink-0 border-t border-sidebar-border">
          <VoiceMini />
          {pendingInvites > 0 && (
            <button
              type="button"
              onClick={() => navigate("/invitations")}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
            >
              <Mail className="size-4 shrink-0" />
              <span className="truncate">{t("common:misc.invitationsForYou")}</span>
              <span className="ml-auto inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground">
                {pendingInvites}
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
