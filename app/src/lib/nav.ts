import {
  Activity,
  BookOpen,
  Briefcase,
  FileText,
  Hash,
  ImageDown,
  Inbox,
  KeyRound,
  LayoutDashboard,
  MessagesSquare,
  Megaphone,
  NotebookPen,
  Send,
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
// Cómo se agrupan en el escritorio lo dice `MODULES`, no esta lista.
export const NAV_ITEMS: {
  labelKey: MessageKey;
  path: string;
  icon: typeof LayoutDashboard;
  guest: boolean;
  superadmin?: boolean;
}[] = [
  { labelKey: "nav:item.overview", path: "/overview", icon: LayoutDashboard, guest: false },
  { labelKey: "nav:item.myWork", path: "/my-work", icon: Inbox, guest: false },
  // Sin entrada para tareas: el árbol de espacios del panel de Trabajo **es**
  // esa navegación. Una fila «Tareas» que lleva a la última lista abierta
  // compite con el árbol por el mismo trabajo y deja al usuario sin saber cuál
  // manda. La documentación sí tiene fila propia, al contrario que las tareas:
  // el árbol navega por espacios, y la pregunta que contesta esta pantalla
  // —«qué está sin revisar»— cruza todos.
  { labelKey: "nav:item.docs", path: "/docs", icon: FileText, guest: false },
  { labelKey: "nav:item.notes", path: "/notes", icon: NotebookPen, guest: false },
  { labelKey: "nav:item.channels", path: "/chat", icon: Hash, guest: false },
  { labelKey: "nav:item.directMessages", path: "/dm", icon: MessagesSquare, guest: false },
  // El muro de feedback y comunicados: lo que las orgs y la plataforma se dicen.
  { labelKey: "nav:item.feedback", path: "/feedback", icon: Megaphone, guest: false },
  // The dashboard is the servers screen; named for what it holds rather than
  // for the layout it happens to use.
  { labelKey: "nav:item.servers", path: "/dashboard", icon: Server, guest: false },
  // La actividad de CI (R9): qué hizo GitHub Actions con cada repo y qué
  // desplegó cac. El icono `Activity` ya lo lleva Diagnóstico.
  { labelKey: "nav:item.activity", path: "/activity", icon: Workflow, guest: false },
  { labelKey: "nav:item.diagnostics", path: "/diagnostics", icon: Activity, guest: false },
  { labelKey: "nav:item.users", path: "/users", icon: Users, guest: false, superadmin: true },
];

export type NavItem = (typeof NAV_ITEMS)[number];

/** La entrada de una ruta, para quien quiera pintarla con su icono y rótulo. */
export function navItem(path: string): NavItem {
  const item = NAV_ITEMS.find((i) => i.path === path);
  if (!item) throw new Error(`no nav item for ${path}`);
  return item;
}

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

/**
 * The on-device tools, as one entry that opens.
 *
 * They were three of the ten rows in a flat menu, which put "compress an image"
 * at the same level as "Users". Folded into one, the menu says what is work and
 * what is a workbench.
 *
 * Rendered whether or not there is a session: signed out these are the only
 * part of the app that does anything, and they are how the guest flow starts.
 */
export const DEV_TOOLS: { labelKey: MessageKey; path: string; icon: typeof ImageDown; guest: boolean }[] = [
  { labelKey: "nav:devTools.image", path: "/devtools/image", icon: ImageDown, guest: true },
  { labelKey: "nav:devTools.requests", path: "/devtools/requests", icon: Send, guest: false },
  { labelKey: "nav:devTools.tokens", path: "/devtools/tokens", icon: KeyRound, guest: true },
];

// ─── Los módulos del riel ────────────────────────────────────────────────────

/**
 * Los módulos: lo que va en el riel de la barra lateral (12-oct-2026).
 *
 * El sidebar era una columna con once filas fijas y, debajo, el árbol entero
 * de espacios desplegado; y Documentación, Canales y Directos abrían cada uno
 * su propia barra al lado. Ahora el riel lleva **cuatro** módulos y un solo
 * panel enseña la navegación del que está activo —como Slack, ClickUp 4.0 o
 * VS Code—, así que añadir un módulo (Marketing, mañana) es una entrada aquí
 * y un panel en `components/sidebar/panels.ts`. Una prueba exige que las dos
 * listas coincidan.
 *
 * Los componentes de panel **no** van aquí a propósito: este fichero lo
 * importa la hoja «Más» del móvil, y traer los paneles arrastraría sus stores
 * a ese grafo.
 */
export type ModuleKey = "work" | "docs" | "comms" | "platform";

export interface NavModule {
  key: ModuleKey;
  icon: typeof LayoutDashboard;
  labelKey: MessageKey;
  /** Prefijos de ruta que ponen a este módulo al mando del panel. */
  routes: string[];
  /** A dónde lleva el icono la primera vez, antes de que haya un sitio recordado. */
  home: string;
  /** En la web, cuando `home` no existe en ese build. */
  webHome?: string;
  /** Visible sin sesión. */
  guest: boolean;
}

export const MODULES: NavModule[] = [
  // Notas cae en Trabajo porque es trabajo (su fila está en `NAV_ITEMS` bajo
  // `work`), y conserva su propia barra en `/notes` hasta la siguiente tanda.
  { key: "work", icon: Briefcase, labelKey: "nav:module.work", routes: ["/my-work", "/overview", "/tasks", "/notes"], home: "/my-work", guest: false },
  { key: "docs", icon: BookOpen, labelKey: "nav:module.docs", routes: ["/docs"], home: "/docs", guest: false },
  { key: "comms", icon: MessagesSquare, labelKey: "nav:module.comms", routes: ["/chat", "/dm", "/call", "/feedback"], home: "/chat", guest: false },
  {
    key: "platform",
    icon: Server,
    labelKey: "nav:module.platform",
    routes: ["/dashboard", "/servers", "/activity", "/diagnostics", "/users", "/devtools"],
    home: "/dashboard",
    webHome: "/activity",
    guest: true,
  },
];

/**
 * Qué módulo manda en una ruta, o `null` si ninguno (organización,
 * invitaciones, perfil, login): entonces el panel sigue enseñando el último
 * que mandó, para no quedarse nunca en blanco.
 *
 * Por prefijo entero —`/docs` y `/docs/…`—, no por `startsWith` a secas: con
 * eso `/dm` casaría con `/dmx` y, peor, `/call` con cualquier ruta que
 * empezara igual.
 */
export function moduleOf(pathname: string): ModuleKey | null {
  for (const m of MODULES) {
    if (m.routes.some((r) => pathname === r || pathname.startsWith(r + "/"))) return m.key;
  }
  return null;
}

/** Sin sesión, sólo lo que funciona sin servidor: las herramientas. */
export function visibleModules({ authed }: { authed: boolean }): NavModule[] {
  return MODULES.filter((m) => authed || m.guest);
}

/** A dónde lleva el icono de un módulo sin un sitio recordado. */
export function moduleHome(m: NavModule, web: boolean): string {
  return web ? (m.webHome ?? m.home) : m.home;
}
