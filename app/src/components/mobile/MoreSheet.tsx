import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Building2, Mail } from "lucide-react";

import AccountMenu from "@/components/AccountMenu";
import { ChangePasswordDialog } from "@/components/ChangePassword";
import OrgSwitcher from "@/components/OrgSwitcher";
import SpacesNavigator from "@/components/tree/SpacesNavigator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useT } from "@/lib/i18n";
import { visibleNavItems } from "@/lib/nav";
import { isWebBuild } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/store/auth.store";
import { useInvitationsStore } from "@/store/invitations.store";
import { useNotifUI } from "@/store/notifui.store";

/** Lo que ya tiene botón propio en el menú de abajo. */
const EN_EL_MENU = new Set(["/my-work", "/chat", "/dm"]);

/**
 * «Más», en el teléfono: todo lo que no cabe en los tres botones de abajo.
 *
 * Una hoja que sube desde abajo, donde ya está el pulgar, y no un cajón desde
 * el lado. Lleva lo que antes sólo se alcanzaba por la hamburguesa —que ya no
 * existe en el móvil—, así que **nada puede quedarse fuera**: el resto de
 * pantallas (de `lib/nav.ts`, las mismas que la barra lateral), el árbol de
 * espacios para entrar a un tablero, la organización y la cuenta.
 */
export default function MoreSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { t } = useT();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const superadmin = useAuthStore((s) => !!s.session?.superadmin);
  const pendingInvites = useInvitationsStore((s) => s.pending.length);
  const setPrefsOpen = useNotifUI((s) => s.setPrefsOpen);
  const [pwOpen, setPwOpen] = useState(false);

  const destinos = visibleNavItems({ authed: true, superadmin, web: isWebBuild }).filter(
    (i) => !EN_EL_MENU.has(i.path),
  );

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          className="max-h-[85dvh] gap-0 overflow-y-auto rounded-t-xl bg-sidebar p-0 pb-[env(safe-area-inset-bottom)] text-sidebar-foreground"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>{t("nav:mobile.more")}</SheetTitle>
            <SheetDescription>{t("nav:mobile.moreHint")}</SheetDescription>
          </SheetHeader>
          {/* El asa: dice que la hoja se arrastra hacia abajo para cerrarla. */}
          <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-muted-foreground/30" aria-hidden />

          <div className="px-2 pt-2">
            <OrgSwitcher />
          </div>

          <nav aria-label={t("nav:mobile.goTo")} className="grid grid-cols-3 gap-1 px-3 py-3">
            {destinos.map((item) => (
              <button
                key={item.path}
                type="button"
                onClick={() => navigate(item.path)}
                className={cn(
                  "flex flex-col items-center gap-1 rounded-lg px-1 py-2.5 text-center text-xs",
                  pathname.startsWith(item.path) ? "bg-accent font-medium text-accent-foreground" : "hover:bg-accent/60",
                )}
              >
                <item.icon className="size-5" />
                <span className="line-clamp-2">{t(item.labelKey)}</span>
              </button>
            ))}
          </nav>

          {/* Los espacios y sus listas: la única forma de entrar a un tablero. */}
          <div className="border-t">
            <SpacesNavigator />
          </div>

          <div className="space-y-0.5 border-t px-2 py-2">
            <button
              type="button"
              onClick={() => navigate("/organization")}
              className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent"
            >
              <Building2 className="size-4 shrink-0" />
              {t("common:misc.organization")}
            </button>
            {pendingInvites > 0 && (
              <button
                type="button"
                onClick={() => navigate("/invitations")}
                className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent"
              >
                <Mail className="size-4 shrink-0" />
                <span className="flex-1">{t("common:misc.invitationsForYou")}</span>
                <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground">
                  {pendingInvites}
                </span>
              </button>
            )}
            <AccountMenu
              onChangePassword={() => setPwOpen(true)}
              onNotificationPrefs={() => setPrefsOpen(true)}
            />
          </div>
        </SheetContent>
      </Sheet>
      <ChangePasswordDialog open={pwOpen} onOpenChange={setPwOpen} />
    </>
  );
}
