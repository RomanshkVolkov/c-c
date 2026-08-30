import { useT, type MessageKey } from "@/lib/i18n";
import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  Wrench,
  Server,
  Building2,
  Mail,
  Inbox,
  Hash,
  MessagesSquare,
  ChevronRight,
  LayoutDashboard,
  NotebookPen,
  ImageDown,
  Send,
  KeyRound,
  Activity,
  Users,
  LogIn,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import OrgSwitcher from "@/components/OrgSwitcher";
import { Brand, BrandMark } from "@/components/brand/Brand";
import AccountMenu from "@/components/AccountMenu";
import SpacesNavigator from "@/components/tree/SpacesNavigator";
import { ChangePasswordDialog } from "@/components/ChangePassword";
import ConnectMcpDialog from "@/components/ConnectMcpDialog";
import { useNotifUI } from "@/store/notifui.store";
import { useAuthStore } from "@/store/auth.store";
import { useServers } from "@/hooks/use-servers";
import { useInvitationsStore } from "@/store/invitations.store";
import { useChatStore } from "@/store/chat.store";
import { useDMStore } from "@/store/dm.store";
import { useInboxStore } from "@/store/inbox.store";
import { useOrgsStore } from "@/store/orgs.store";
import VoiceMini from "@/components/voice/VoiceMini";
import { cn } from "@/lib/utils";

// guest: reachable on-device (no backend). superadmin: only for platform admins.
//
// `group` splits one flat list of ten into the three things a person is
// actually doing: their work, the developer tools, and running the platform.
// Ten equal rows made everything look equally important, which is another way
// of saying nothing did.
const NAV_ITEMS: {
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
  { labelKey: "nav:item.notes", path: "/notes", icon: NotebookPen, guest: false, group: "work" },
  { labelKey: "nav:item.channels", path: "/chat", icon: Hash, guest: false, group: "talk" },
  { labelKey: "nav:item.directMessages", path: "/dm", icon: MessagesSquare, guest: false, group: "talk" },
  // The dashboard is the servers screen; named for what it holds rather than
  // for the layout it happens to use.
  { labelKey: "nav:item.servers", path: "/dashboard", icon: Server, guest: false, group: "platform" },
  { labelKey: "nav:item.diagnostics", path: "/diagnostics", icon: Activity, guest: false, group: "platform" },
  { labelKey: "nav:item.users", path: "/users", icon: Users, guest: false, superadmin: true, group: "platform" },
];

/** Rendered in this order; a group with nothing in it draws nothing at all. */
const GROUPS: { key: string; labelKey: MessageKey }[] = [
  { key: "work", labelKey: "nav:group.work" },
  { key: "talk", labelKey: "nav:group.talk" },
  { key: "platform", labelKey: "nav:group.platform" },
];

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
const DEV_TOOLS: { labelKey: MessageKey; path: string; icon: typeof ImageDown; guest: boolean }[] = [
  { labelKey: "nav:devTools.image", path: "/devtools/image", icon: ImageDown, guest: true },
  { labelKey: "nav:devTools.requests", path: "/devtools/requests", icon: Send, guest: false },
  { labelKey: "nav:devTools.tokens", path: "/devtools/tokens", icon: KeyRound, guest: true },
];

/** DevTools, folded into one row that opens onto the tools you can use. */
function DevToolsMenu() {
  const { t } = useT();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const authed = useAuthStore((s) => !!s.accessToken);
  const dentro = pathname.startsWith("/devtools");
  const [open, setOpen] = useState(dentro);
  const tools = DEV_TOOLS.filter((t) => authed || t.guest);

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={dentro}
        tooltip={t("common:misc.devtools")}
        onClick={() => {
          // Clicking the parent both opens the list and goes somewhere: a row
          // that only expands makes you click twice to reach anything.
          setOpen(true);
          if (!dentro) navigate(tools[0]?.path ?? "/devtools");
        }}
      >
        <Wrench className="size-4" />
        <span>{t("common:misc.devtools")}</span>
        <ChevronRight className={cn("ml-auto size-3.5 transition-transform", open && "rotate-90")} />
      </SidebarMenuButton>
      {open && (
        <SidebarMenuSub>
          {tools.map((tool) => (
            <SidebarMenuSubItem key={tool.path}>
              <SidebarMenuSubButton
                isActive={pathname.startsWith(tool.path)}
                onClick={() => navigate(tool.path)}
              >
                <tool.icon className="size-3.5" />
                <span>{t(tool.labelKey)}</span>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          ))}
        </SidebarMenuSub>
      )}
    </SidebarMenuItem>
  );
}

export default function AppSidebar() {
  const { t } = useT();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const authed = useAuthStore((s) => !!s.accessToken);
  const superadmin = useAuthStore((s) => !!s.session?.superadmin);
  const pendingInvites = useInvitationsStore((s) => s.pending.length);
  // Both counts already live in their stores for the tree and the switcher;
  // reading them here costs nothing and is what makes the group worth having.
  // Servers that are not simply running. Counted rather than listed, and drawn
  // in amber: it is a "look at this when you can", not an outage — an outage
  // announces itself elsewhere.
  const servidoresEnAtencion = useServers().servers.filter((sv) => sv.status !== "online").length;
  const sinLeerCanales = useChatStore((s) =>
    Object.values(s.unreadBySpace).reduce((a, b) => a + b, 0),
  );
  const sinLeerDirectos = useDMStore((s) =>
    s.conversations.reduce((a, c) => a + c.unread, 0),
  );
  const [pwOpen, setPwOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  // Dos cosas distintas tras dos entradas: la campana —que ahora vive en la
  // barra de arriba— abre lo que pasó, y el menú de cuenta abre qué quieres
  // que te cuenten. Eran el mismo diálogo, así que pedir tus preferencias te
  // enseñaba tu bandeja.
  const setPrefsOpen = useNotifUI((s) => s.setPrefsOpen);
  // From the server, not from what this session happened to witness. That is
  // the whole point: the badge now means "since you last read it" rather than
  // "since you last launched me".
  const currentOrgId = useOrgsStore((s) => s.currentOrgId);
  const loadInbox = useInboxStore((s) => s.load);
  useEffect(() => {
    if (authed) loadInbox(currentOrgId).catch(() => {});
  }, [authed, currentOrgId, loadInbox]);
  const collapsed = useSidebar().state === "collapsed";
  const items = (authed ? NAV_ITEMS : NAV_ITEMS.filter((i) => i.guest)).filter(
    (i) => !i.superadmin || superadmin,
  );

  return (
    <Sidebar collapsible="icon" variant="sidebar">
      {/* La marca sólo cuando no hay una fila de organización que la lleve:
          sin sesión —el sidebar sigue mostrando las herramientas de invitado, y
          un producto sin nombre parece roto— o plegado, que es cuando el
          selector no se dibuja. Con sesión y desplegado, el nombre de la app
          vive dentro de esa fila y repetirlo encima era el bloque de más. */}
      {(!authed || collapsed) && (
        <SidebarHeader>
          <div className={cn("flex items-center", collapsed ? "justify-center" : "px-1")}>
            {collapsed ? (
              <BrandMark className="h-5 w-auto" />
            ) : (
              <Brand className="text-sm" />
            )}
          </div>
        </SidebarHeader>
      )}
      {authed && !collapsed && (
        <SidebarHeader>
          <OrgSwitcher />
        </SidebarHeader>
      )}

      <SidebarContent>
        {GROUPS.map((grupo) => {
          const deEsteGrupo = items.filter((i) => i.group === grupo.key);
          // El grupo de plataforma se dibuja igualmente porque DevTools cuelga
          // de él, y sin sesión es lo único que la app puede hacer.
          const conHerramientas = grupo.key === "platform";
          if (deEsteGrupo.length === 0 && !conHerramientas) return null;
          return (
            <SidebarGroup key={grupo.key}>
              <SidebarGroupLabel>{t(grupo.labelKey)}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {deEsteGrupo.map((item) => {
                    const badge =
                      item.path === "/invitations" && pendingInvites > 0
                        ? pendingInvites
                        : item.path === "/dashboard" && servidoresEnAtencion > 0
                          ? servidoresEnAtencion
                        : item.path === "/chat" && sinLeerCanales > 0
                          ? sinLeerCanales
                          : item.path === "/dm" && sinLeerDirectos > 0
                            ? sinLeerDirectos
                            : null;
                    return (
                      <SidebarMenuItem key={item.path}>
                        <SidebarMenuButton
                          isActive={pathname.startsWith(item.path)}
                          tooltip={badge ? `${t(item.labelKey)} (${badge})` : t(item.labelKey)}
                          onClick={() => navigate(item.path)}
                        >
                          <item.icon className="size-4" />
                          <span>{t(item.labelKey)}</span>
                          {badge &&
                            (item.path === "/dashboard" ? (
                              <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground">
                                <span className="size-1.5 rounded-full bg-warning" />
                                {badge}
                              </span>
                            ) : (
                              <span className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground">
                                {badge}
                              </span>
                            ))}
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                  {conHerramientas && <DevToolsMenu />}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          );
        })}

        {/* The spaces tree. Only signed in — it is the one group whose contents
            come from the server — and only expanded, because a tree needs width
            to be a tree and the collapsed rail is one icon across. */}
        {authed && !collapsed && <SpacesNavigator />}
      </SidebarContent>

      <SidebarFooter>
        {/* Encima de la cuenta y de la organización: es lo único de aquí abajo
            que pasa *ahora mismo*, y lo que pasa ahora va arriba. */}
        {authed && <VoiceMini compacto={collapsed} />}
        {/* The organization, above the account and below everything else.
            It is neither navigation nor a setting of yours: it is the place
            those two meet, and the hint says what is inside so nobody has to
            open it to find out that "people" lives there. Invitations only
            appears when some are waiting — a permanent row for an empty list
            is a row that teaches you to ignore it. */}
        {authed && !collapsed && (
          <button
            onClick={() => navigate("/organization")}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
              pathname.startsWith("/organization")
                ? "bg-accent text-accent-foreground"
                : "hover:bg-accent",
            )}
          >
            <Building2 className="size-4 shrink-0" />
            <span className="truncate">{t("common:misc.organization")}</span>
            <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
              people · invitations
            </span>
          </button>
        )}
        {authed && !collapsed && pendingInvites > 0 && (
          <button
            onClick={() => navigate("/invitations")}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
          >
            <Mail className="size-4 shrink-0" />
            <span className="truncate">{t("common:misc.invitationsForYou")}</span>
            <span className="ml-auto inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground">
              {pendingInvites}
            </span>
          </button>
        )}

        {/* Everything that is about you rather than about the work, behind one
            row. Six stacked items put "change my password" at the same level as
            the navigation, and made logging out — the last of them — the
            easiest thing in the sidebar to hit by accident. */}
        {authed && !collapsed && (
          <AccountMenu
            onChangePassword={() => setPwOpen(true)}
            onConnectMcp={() => setMcpOpen(true)}
            onNotificationPrefs={() => setPrefsOpen(true)}
          />
        )}
        {!authed && (
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton tooltip={t("common:misc.login")} onClick={() => navigate("/login")}>
                <LogIn className="size-4" />
                <span>{t("common:misc.login")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        )}
      </SidebarFooter>

      <SidebarRail />
      <ChangePasswordDialog open={pwOpen} onOpenChange={setPwOpen} />
      <ConnectMcpDialog open={mcpOpen} onOpenChange={setMcpOpen} />
    </Sidebar>
  );
}


