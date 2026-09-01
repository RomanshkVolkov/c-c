import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import { Search } from "lucide-react";
import CommandPalette from "@/components/CommandPalette";
import TaskDetailDrawer from "@/components/TaskDetailDrawer";
import { Toaster } from "sonner";
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import AppSidebar from "@/components/AppSidebar";
import NotificationsPanel from "@/components/NotificationsPanel";
import NotificationPrefsDialog from "@/components/NotificationPrefsDialog";
import { useNotifUI } from "@/store/notifui.store";
import { useInboxStore } from "@/store/inbox.store";
import { Bell } from "lucide-react";
import UpdateChecker from "@/components/UpdateChecker";
import IncomingCall from "@/components/voice/IncomingCall";
import MeetingCall from "@/components/meetings/MeetingCall";
import ConnectionBanner from "@/components/ConnectionBanner";
import { useOrgsStore } from "@/store/orgs.store";
import { useReportEvents } from "@/hooks/use-report-events";
import { ensureOrgClaim, refreshSession } from "@/lib/api";
import { useAuthStore } from "@/store/auth.store";
import { useInvitationsStore } from "@/store/invitations.store";
import { useThemeStore } from "@/store/theme.store";
import { ForcedChangePassword } from "@/components/ChangePassword";

export default function AppLayout() {
  const fetchOrgs = useOrgsStore((s) => s.fetchOrgs);
  const fetchInvitations = useInvitationsStore((s) => s.fetchMine);
  const authed = useAuthStore((s) => !!s.accessToken);
  const mustChangePassword = useAuthStore((s) => !!s.session?.mustChangePassword);
  // sonner renders in its own tree and ignores the .dark class.
  const theme = useThemeStore((s) => s.resolved);

  // Load the caller's organizations once the authenticated shell mounts. First
  // upgrade a pre-orgs token (else org-scoped lists come back empty) so the
  // switcher and lists have data without a manual re-login. Also fetch pending
  // invitations for the sidebar badge. Skipped for guests (no token → 401).
  useEffect(() => {
    if (authed) {
      ensureOrgClaim().then(() => {
        refreshSession();
        fetchOrgs();
      });
      fetchInvitations();
    }
  }, [authed, fetchOrgs, fetchInvitations]);

  // Live report notifications (SSE) for the whole authenticated shell.
  useReportEvents();

  // ⌘K anywhere, and Escape closes it because the dialog handles that itself.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const panelOpen = useNotifUI((s) => s.panelOpen);
  const setPanelOpen = useNotifUI((s) => s.setPanelOpen);
  const prefsOpen = useNotifUI((s) => s.prefsOpen);
  const setPrefsOpen = useNotifUI((s) => s.setPrefsOpen);
  const sinLeer = useInboxStore((s) => s.unread);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Todo lo de arriba son hooks, y **por eso el corte va aquí abajo**.
  //
  // Estaba justo encima de los seis anteriores, y eso convertía el alta de
  // cualquier persona nueva en un pantallazo: un admin le pone contraseña,
  // entra, ve esta pantalla —el componente corre con seis hooks menos—, la
  // cambia, `mustChangePassword` pasa a falso, y el mismo componente vuelve a
  // dibujarse con seis hooks más. React lleva la cuenta por posición y tira la
  // aplicación entera, que además es ésta: `AppLayout` envuelve todo.
  //
  // Lo encontró `react-hooks/rules-of-hooks` a los cinco minutos de existir.
  if (authed && mustChangePassword) {
    return <ForcedChangePassword />;
  }


  return (
    /* El techo de toda la aplicación, y va aquí y no en `components/ui/`.
       
       shadcn deja el marco en `min-h-svh`: altura **mínima**, que es lo correcto
       para una página que crece y se lee haciendo scroll. cac no es eso — es un
       armazón donde cada panel desborda dentro de lo suyo — y sin techo el
       `overflow-y-auto` de la lista de un chat **nunca se activa**: quien hacía
       scroll era el documento.
       
       De ahí salían tres cosas que parecían tres bugs: el área de escribir
       quedaba bajo el pliegue, `scrollTop = scrollHeight` era un no-op sobre un
       elemento que no desborda —por eso un canal abría arriba del todo— y el
       `onScroll` que carga mensajes antiguos no se disparaba jamás.
       
       Por `className` y no editando `components/ui/sidebar.tsx`: eso es shadcn
       copiado, y cambiarlo allí se pierde la próxima vez que se regenere. */
    <SidebarProvider className="h-svh overflow-hidden">
      <AppSidebar />
      {/* `min-h-0` por lo mismo que el `min-w-0` que ya trae: un elemento flex
          se niega a encogerse por debajo de su contenido, así que sin esto el
          techo de arriba no llega hasta abajo. El comentario de shadcn explica
          el caso horizontal; éste es el mismo en vertical. */}
      <SidebarInset className="min-h-0">
        <ConnectionBanner />
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="md:hidden" />
          {/* Centred and always there, because a search you have to remember a
              shortcut for is one most people never find. Clicking it opens the
              same palette ⌘K does. */}
          <button
            onClick={() => setPaletteOpen(true)}
            className="mx-auto flex w-full max-w-md items-center gap-2 rounded-md border bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/60"
          >
            <Search className="size-3.5" />
            <span>Search tasks, messages, people…</span>
            <kbd className="ml-auto font-mono text-[10px] opacity-70">⌘K</kbd>
          </button>
          {/* La campana, a la derecha del todo. Estaba metida en la cabecera
              del sidebar, que es donde vive la organización: lo que te ha
              pasado a ti no es una propiedad de la organización, y ahí abajo a
              la izquierda quedaba lejos de donde uno mira cuando algo suena. */}
          <button
            type="button"
            title="Notifications"
            onClick={() => setPanelOpen(true)}
            className="relative ml-2 shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Bell className="size-4" />
            {sinLeer > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground">
                {sinLeer > 9 ? "9+" : sinLeer}
              </span>
            )}
          </button>
        </header>
        <NotificationsPanel
          open={panelOpen}
          onOpenChange={setPanelOpen}
          onOpenPrefs={() => setPrefsOpen(true)}
        />
        <NotificationPrefsDialog open={prefsOpen} onOpenChange={setPrefsOpen} />
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
        <Outlet />
        {/* Mounted here and not per screen. Opening a task is global state, so
            drawing it has to be too: it used to live inside the board, which
            meant "my work", the channels and the dashboard could all ask for a
            task and nothing would appear. */}
        <TaskDetailDrawer />
      </SidebarInset>
      {/* Encima de todo, y montado una sola vez: una llamada puede entrar
          mientras miras un servidor o una nota, no sólo desde un canal. */}
      <IncomingCall />
      <MeetingCall />
      <UpdateChecker />
      <Toaster richColors closeButton position="bottom-right" theme={theme} />
    </SidebarProvider>
  );
}
