import { Suspense, useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Search } from "lucide-react";
import CommandPalette from "@/components/CommandPalette";
import TaskDetailDrawer from "@/components/TaskDetailDrawer";
import { Toaster } from "sonner";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import AppSidebar from "@/components/AppSidebar";
import NotificationsPanel from "@/components/NotificationsPanel";
import NotificationPrefsDialog from "@/components/NotificationPrefsDialog";
import { useNotifUI } from "@/store/notifui.store";
import { useInboxStore } from "@/store/inbox.store";
import { Bell } from "lucide-react";
import UpdateChecker from "@/components/UpdateChecker";
import StaleBinaryNotice from "@/components/StaleBinaryNotice";
import IncomingCall from "@/components/voice/IncomingCall";
import FollowMove from "@/components/voice/FollowMove";
import MeetingCall from "@/components/meetings/MeetingCall";
import ConnectionBanner from "@/components/ConnectionBanner";
import MobileTabBar from "@/components/mobile/MobileTabBar";
import { useIsMobile } from "@/hooks/use-mobile";
import { isWebBuild } from "@/lib/platform";
import { viaMediaScheme } from "@/lib/media";
import { useOpenedFromPush } from "@/hooks/use-opened-from-push";
import { useMediaTicket } from "@/lib/url-ticket";
import { useOrgsStore } from "@/store/orgs.store";
import { useVoice } from "@/store/voice.store";
import { useReportEvents } from "@/hooks/use-report-events";
import { useWebviewCrash } from "@/hooks/use-webview-crash";
import { ensureOrgClaim, refreshSession } from "@/lib/api";
import { useAuthStore } from "@/store/auth.store";
import { useInvitationsStore } from "@/store/invitations.store";
import { useLayoutStore } from "@/store/layout.store";
import { useThemeStore } from "@/store/theme.store";
import { useT } from "@/lib/i18n";
import { ForcedChangePassword } from "@/components/ChangePassword";
import RepoDocNavigator from "@/components/docs/RepoDocNavigator";

export default function AppLayout() {
  const section = useLocation().pathname.split("/")[1] ?? "";
  const { t } = useT();
  // El panel del sidebar, abierto o plegado al riel; recordado entre arranques.
  const sidebarOpen = useLayoutStore((s) => s.panelOpen);
  const setSidebarOpen = useLayoutStore((s) => s.setPanelOpen);
  const fetchOrgs = useOrgsStore((s) => s.fetchOrgs);
  const fetchInvitations = useInvitationsStore((s) => s.fetchMine);
  const authed = useAuthStore((s) => !!s.accessToken);
  const mustChangePassword = useAuthStore((s) => !!s.session?.mustChangePassword);
  // sonner renders in its own tree and ignores the .dark class.
  const theme = useThemeStore((s) => s.resolved);
  const mobile = useIsMobile();

  // Load the caller's organizations once the authenticated shell mounts. First
  // upgrade a pre-orgs token (else org-scoped lists come back empty) so the
  // switcher and lists have data without a manual re-login. Also fetch pending
  // invitations for the sidebar badge. Skipped for guests (no token → 401).
  // Abierta desde un aviso del teléfono: esa fila, leída (W2).
  useOpenedFromPush();

  useEffect(() => {
    if (authed) {
      ensureOrgClaim().then(() => {
        refreshSession();
        fetchOrgs();
      });
      fetchInvitations();
    }
  }, [authed, fetchOrgs, fetchInvitations]);

  // Una recarga no cuelga la llamada —vive en Rust—, así que la página nueva
  // tiene que engancharse a ella. Sin esto, el micrófono seguía abierto y nada
  // en pantalla lo decía. Ver `useVoice.reanudar`.
  const resumeCall = useVoice((s) => s.reanudar);
  useEffect(() => {
    if (authed) void resumeCall();
  }, [authed, resumeCall]);

  // Live report notifications (SSE) for the whole authenticated shell.
  useReportEvents();

  // Si la página vuelve de que su proceso se muriera, se ficha (ver el hook).
  useWebviewCrash(authed);

  // El pase de adjuntos de la web (ver lib/url-ticket.ts). En el escritorio no
  // hace falta —sus adjuntos van con cabecera—, salvo en `bun tauri dev`, que
  // los carga como la web (ver viaMediaScheme).
  const mediaReady = useMediaTicket(!viaMediaScheme() && authed);

  // ⌘K anywhere, and Escape closes it because the dialog handles that itself.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const panelOpen = useNotifUI((s) => s.panelOpen);
  const setPanelOpen = useNotifUI((s) => s.setPanelOpen);
  const prefsOpen = useNotifUI((s) => s.prefsOpen);
  const setPrefsOpen = useNotifUI((s) => s.setPrefsOpen);
  const unread = useInboxStore((s) => s.unread);
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

  // En la web, las imágenes llevan un pase de adjuntos en la URL, y se pide
  // antes de pintar nada: una imagen pintada sin él no se vuelve a pedir.
  if (!mediaReady) return null;


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
       copiado, y cambiarlo allí se pierde la próxima vez que se regenere.

       Y por `style`, el ancho: 19rem son el riel (3rem, el ancho del modo
       icono) y el panel (16rem). shadcn aplica `style` después de sus propias
       variables, así que esto manda. Controlado desde `layout.store`: la
       cookie que escribe shadcn no la leía nadie, y el sidebar arrancaba
       siempre abierto. */
    <SidebarProvider
      className="h-svh overflow-hidden"
      style={{ "--sidebar-width": "19rem" } as React.CSSProperties}
      open={sidebarOpen}
      onOpenChange={setSidebarOpen}
    >
      <AppSidebar />
      {/* `min-h-0` por lo mismo que el `min-w-0` que ya trae: un elemento flex
          se niega a encogerse por debajo de su contenido, así que sin esto el
          techo de arriba no llega hasta abajo. El comentario de shadcn explica
          el caso horizontal; éste es el mismo en vertical. */}
      <SidebarInset className="min-h-0">
        <ConnectionBanner />
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          {/* Sin hamburguesa en el teléfono: ahí manda el menú de abajo
              (`MobileTabBar`). La barra lateral sólo existe en pantalla ancha,
              donde se pliega desde su propio borde. */}
          {/* Centred and always there, because a search you have to remember a
              shortcut for is one most people never find. Clicking it opens the
              same palette ⌘K does. */}
          <button
            onClick={() => setPaletteOpen(true)}
            className="mx-auto flex w-full max-w-md items-center gap-2 rounded-md border bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/60"
          >
            <Search className="size-3.5" />
            <span>{t("common:palette.searchPlaceholder")}</span>
            <kbd className="ml-auto font-mono text-[10px] opacity-70">⌘K</kbd>
          </button>
          {/* La campana, a la derecha del todo. Estaba metida en la cabecera
              del sidebar, que es donde vive la organización: lo que te ha
              pasado a ti no es una propiedad de la organización, y ahí abajo a
              la izquierda quedaba lejos de donde uno mira cuando algo suena. */}
          <button
            type="button"
            title={t("common:last.notifications")}
            aria-label={t("common:last.notifications")}
            onClick={() => setPanelOpen(true)}
            className="motion-press relative ml-2 shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Bell className="size-4" />
            {unread > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground">
                {unread > 9 ? "9+" : unread}
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
        {/* Las páginas de escritorio llegan en su propio trozo (ver App). */}
        {/* Cada sección entra al llegar a ella (`motion-page`): la clave es el
            primer tramo de la ruta, así que cambiar de pestaña dentro de un
            servidor no vuelve a animar la pantalla entera. */}
        <div key={section} className="motion-page flex min-h-0 min-w-0 flex-1 flex-col">
          <Suspense fallback={null}>
            <Outlet />
          </Suspense>
        </div>
        {/* Mounted here and not per screen. Opening a task is global state, so
            drawing it has to be too: it used to live inside the board, which
            meant "my work", the channels and the dashboard could all ask for a
            task and nothing would appear. */}
        <TaskDetailDrawer />
        {/* Un .md del repo pedido desde donde no hay router (chat, un include). */}
        <RepoDocNavigator />
        <MobileTabBar />
      </SidebarInset>
      {/* Encima de todo, y montado una sola vez: una llamada puede entrar
          mientras miras un servidor o una nota, no sólo desde un canal. */}
      <IncomingCall />
      <FollowMove />
      <MeetingCall />
      {/* El actualizador y el aviso de «binario reemplazado» son de la app de
          escritorio: en web la versión nueva llega al recargar. */}
      {!isWebBuild && <UpdateChecker />}
      {!isWebBuild && <StaleBinaryNotice />}
      {/* Arriba en el teléfono: abajo está el menú, y un aviso encima de él
          tapa justo el botón que ibas a pulsar. */}
      <Toaster richColors closeButton position={mobile ? "top-center" : "bottom-right"} theme={theme} />
    </SidebarProvider>
  );
}
