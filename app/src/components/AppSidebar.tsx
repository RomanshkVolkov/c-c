import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";

import { ChangePasswordDialog } from "@/components/ChangePassword";
import ConnectMcpDialog from "@/components/ConnectMcpDialog";
import AppPanel from "@/components/sidebar/AppPanel";
import AppRail from "@/components/sidebar/AppRail";
import { useNavData } from "@/components/sidebar/useNavData";
import { Sidebar, SidebarRail } from "@/components/ui/sidebar";
import { docsRoute } from "@/lib/doc-mode";
import { moduleOf } from "@/lib/nav";
import { isWebBuild } from "@/lib/platform";
import { useLayoutStore } from "@/store/layout.store";
import { useOrgsStore } from "@/store/orgs.store";
import { useTasksStore } from "@/store/tasks.store";
import { useNotifUI } from "@/store/notifui.store";

/**
 * La barra lateral: un riel de módulos y un panel con la navegación del que
 * manda (12-oct-2026; ver `lib/nav.ts`, `MODULES`).
 *
 * Un solo `<Sidebar collapsible="icon">` de shadcn, y el modo icono **es** el
 * riel: plegado mide `--sidebar-width-icon` (3rem), que es justo lo que ocupa
 * el riel; abierto, 19rem (riel más panel, puesto en `AppLayout`). Así
 * `useSidebar().open` significa «panel abierto», y ⌘B, el borde de plegado y
 * `useEncogerEnLlamada` siguen funcionando sin tocarlos.
 *
 * Qué módulo manda lo decide la ruta, aquí, y se apunta junto con la ruta
 * misma: el icono del riel te devuelve a donde estabas en ese módulo. En las
 * rutas que no son de ninguno (organización, perfil) el panel se queda con el
 * último, para no quedarse nunca en blanco.
 *
 * Una excepción: leer un documento en `/tasks` (el conmutador «Docs» de una
 * lista) es Documentación, aunque la ruta sea de Trabajo. Es el panel de
 * Documentación el que lleva las páginas de ese documento; con el de Trabajo
 * no habría forma de llegar a ellas en el escritorio.
 */
export default function AppSidebar() {
  useNavData();
  const { pathname, search } = useLocation();
  const setActiveModule = useLayoutStore((s) => s.setActiveModule);
  const rememberRoute = useLayoutStore((s) => s.rememberRoute);
  const activeDoc = useTasksStore((s) => s.activeDoc);
  const currentOrgId = useOrgsStore((s) => s.currentOrgId);
  const readingOnTasks = docsRoute(activeDoc, currentOrgId, pathname) === "/tasks";
  useEffect(() => {
    const m = readingOnTasks ? "docs" : moduleOf(pathname);
    if (!m) return;
    setActiveModule(m);
    // `/tasks` no se apunta como el sitio de Documentación: volver a él con el
    // documento ya cerrado sería volver a un tablero.
    if (!readingOnTasks) rememberRoute(m, pathname + search);
  }, [pathname, search, readingOnTasks, setActiveModule, rememberRoute]);

  const [pwOpen, setPwOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  // Dos cosas distintas tras dos entradas: la campana —que vive en la barra de
  // arriba— abre lo que pasó, y el menú de cuenta abre qué quieres que te
  // cuenten. Eran el mismo diálogo, así que pedir tus preferencias te enseñaba
  // tu bandeja.
  const setPrefsOpen = useNotifUI((s) => s.setPrefsOpen);

  return (
    <Sidebar collapsible="icon" variant="sidebar">
      <div className="flex h-full min-h-0 w-full">
        <AppRail
          onChangePassword={() => setPwOpen(true)}
          onConnectMcp={isWebBuild ? undefined : () => setMcpOpen(true)}
          onNotificationPrefs={() => setPrefsOpen(true)}
        />
        <AppPanel />
      </div>
      <SidebarRail />
      <ChangePasswordDialog open={pwOpen} onOpenChange={setPwOpen} />
      <ConnectMcpDialog open={mcpOpen} onOpenChange={setMcpOpen} />
    </Sidebar>
  );
}
