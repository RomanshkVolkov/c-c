import {
  Activity,
  FileText,
  Hash,
  Inbox,
  LayoutDashboard,
  MessagesSquare,
  NotebookPen,
  Server,
  Users,
  Workflow,
} from "lucide-react";

import type { MessageKey } from "@/lib/i18n";

/**
 * A dónde se puede ir desde la navegación. Lo comparten la barra lateral y la
 * hoja «Más» del móvil (`components/mobile/MoreSheet.tsx`): escrita dos veces,
 * bastaba con añadir una pantalla en una para que el teléfono no llegara a ella.
 */

// guest: reachable on-device (no backend). superadmin: only for platform admins.
//
// `group` splits one flat list of ten into the three things a person is
// actually doing: their work, the developer tools, and running the platform.
// Ten equal rows made everything look equally important, which is another way
// of saying nothing did.
export const NAV_ITEMS: {
  labelKey: MessageKey;
  path: string;
  icon: typeof LayoutDashboard;
  guest: boolean;
  superadmin?: boolean;
  group: string;
}[] = [
  { labelKey: "nav:item.overview", path: "/overview", icon: LayoutDashboard, guest: false, group: "work" },
  { labelKey: "nav:item.myWork", path: "/my-work", icon: Inbox, guest: false, group: "work" },
  // Sin entrada para tareas: el árbol de espacios de aquí abajo **es** esa
  // navegación. Una fila «Tareas» que lleva a la última lista abierta compite
  // con el árbol por el mismo trabajo y deja al usuario sin saber cuál manda.
  // La documentación sí tiene fila propia, al contrario que las tareas: el
  // árbol de abajo navega por espacios, y la pregunta que contesta esta pantalla
  // —«qué está sin revisar»— cruza todos.
  { labelKey: "nav:item.docs", path: "/docs", icon: FileText, guest: false, group: "work" },
  { labelKey: "nav:item.notes", path: "/notes", icon: NotebookPen, guest: false, group: "work" },
  { labelKey: "nav:item.channels", path: "/chat", icon: Hash, guest: false, group: "talk" },
  { labelKey: "nav:item.directMessages", path: "/dm", icon: MessagesSquare, guest: false, group: "talk" },
  // The dashboard is the servers screen; named for what it holds rather than
  // for the layout it happens to use.
  { labelKey: "nav:item.servers", path: "/dashboard", icon: Server, guest: false, group: "platform" },
  // La actividad de CI (R9): qué hizo GitHub Actions con cada repo y qué
  // desplegó cac. El icono `Activity` ya lo lleva Diagnóstico.
  { labelKey: "nav:item.activity", path: "/activity", icon: Workflow, guest: false, group: "platform" },
  { labelKey: "nav:item.diagnostics", path: "/diagnostics", icon: Activity, guest: false, group: "platform" },
  { labelKey: "nav:item.users", path: "/users", icon: Users, guest: false, superadmin: true, group: "platform" },
];

/** Rendered in this order; a group with nothing in it draws nothing at all. */
export const GROUPS: { key: string; labelKey: MessageKey }[] = [
  { key: "work", labelKey: "nav:group.work" },
  { key: "talk", labelKey: "nav:group.talk" },
  { key: "platform", labelKey: "nav:group.platform" },
];

export type NavItem = (typeof NAV_ITEMS)[number];

/**
 * Lo que esta persona ve: sin sesión, sólo lo de invitado; en la web, sin
 * servidores (se gestionan desde el escritorio); Usuarios, sólo superadmin.
 */
export function visibleNavItems({
  authed,
  superadmin,
  web,
}: {
  authed: boolean;
  superadmin: boolean;
  web: boolean;
}): NavItem[] {
  return NAV_ITEMS.filter((i) => authed || i.guest)
    .filter((i) => !(web && i.path === "/dashboard"))
    .filter((i) => !i.superadmin || superadmin);
}
