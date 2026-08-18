import { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  Bell,
  Wrench,
  Inbox,
  Hash,
  MessagesSquare,
  ChevronRight,
  LayoutDashboard,
  KanbanSquare,
  NotebookPen,
  ImageDown,
  Send,
  KeyRound,
  Bot,
  Monitor,
  Moon,
  Sun,
  Building2,
  Mail,
  Activity,
  Users,
  LogOut,
  LogIn,
  RefreshCw,
  CheckCircle2,
  Download,
  AlertCircle,
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
import { toast } from "sonner";
import OrgSwitcher from "@/components/OrgSwitcher";
import { Brand, BrandMark } from "@/components/brand/Brand";
import SpacesNavigator from "@/components/tree/SpacesNavigator";
import { ChangePasswordDialog } from "@/components/ChangePassword";
import ConnectMcpDialog from "@/components/ConnectMcpDialog";
import NotificationsPanel from "@/components/NotificationsPanel";
import { useAuth } from "@/hooks/use-auth";
import { useAuthStore } from "@/store/auth.store";
import { useInvitationsStore } from "@/store/invitations.store";
import { useChatStore } from "@/store/chat.store";
import { useDMStore } from "@/store/dm.store";
import { useUpdaterStore } from "@/store/updater.store";
import { useNotificationsStore } from "@/store/notifications.store";
import { useThemeStore, type ThemePreference } from "@/store/theme.store";
import { useOrgsStore } from "@/store/orgs.store";
import { useTasksStore } from "@/store/tasks.store";
import { useAppVersion } from "@/hooks/use-app-version";
import { cn } from "@/lib/utils";

// guest: reachable on-device (no backend). superadmin: only for platform admins.
//
// `group` splits one flat list of ten into the three things a person is
// actually doing: their work, the developer tools, and running the platform.
// Ten equal rows made everything look equally important, which is another way
// of saying nothing did.
const NAV_ITEMS = [
  { label: "Dashboard", path: "/dashboard", icon: LayoutDashboard, guest: false, group: "work" },
  { label: "My work", path: "/my-work", icon: Inbox, guest: false, group: "work" },
  { label: "Tasks", path: "/tasks", icon: KanbanSquare, guest: false, group: "work" },
  { label: "Notes", path: "/notes", icon: NotebookPen, guest: false, group: "work" },
  { label: "Channels", path: "/chat", icon: Hash, guest: false, group: "talk" },
  { label: "Direct messages", path: "/dm", icon: MessagesSquare, guest: false, group: "talk" },
  { label: "Diagnostics", path: "/diagnostics", icon: Activity, guest: false, group: "platform" },
  { label: "Organization", path: "/organization", icon: Building2, guest: false, group: "platform" },
  { label: "Invitations", path: "/invitations", icon: Mail, guest: false, group: "platform" },
  { label: "Users", path: "/users", icon: Users, guest: false, superadmin: true, group: "platform" },
];

/** Rendered in this order; a group with nothing in it draws nothing at all. */
const GROUPS: { key: string; label: string }[] = [
  { key: "work", label: "Work" },
  { key: "talk", label: "Talk" },
  { key: "platform", label: "Platform" },
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
const DEV_TOOLS = [
  { label: "Image", path: "/devtools/image", icon: ImageDown, guest: true },
  { label: "Requests", path: "/devtools/requests", icon: Send, guest: false },
  { label: "Tokens", path: "/devtools/tokens", icon: KeyRound, guest: true },
];

/**
 * Who you are signed in as, and which build you are running.
 *
 * The version was reachable only by hovering the update button, which is the
 * wrong place: the question "what am I running" comes up when something looks
 * wrong, not when you are already thinking about updating. On an app that
 * updates itself it belongs where you can read it without pressing anything.
 */
function AccountRow() {
  const username = useAuthStore((s) => s.session?.username ?? "");
  const superadmin = useAuthStore((s) => !!s.session?.superadmin);
  const org = useOrgsStore((s) => s.currentOrg());
  const version = useAppVersion();
  if (!username) return null;
  const bajo = [superadmin ? "superadmin" : org?.role, version && `v${version}`]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="flex items-center gap-2 px-3 py-1.5">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-medium uppercase text-primary">
        {username.slice(0, 2)}
      </span>
      <div className="min-w-0">
        <p className="truncate text-xs font-medium">{username}</p>
        {bajo && <p className="truncate text-[11px] text-muted-foreground">{bajo}</p>}
      </div>
    </div>
  );
}

/**
 * Who you are working as, above everything else in the sidebar.
 *
 * The organization decides what every screen below shows, and the only sign of
 * which one you were in was a switcher you had to open. Naming it — with your
 * role, how many people are in it and how many spaces it has — means you can
 * tell at a glance whether you are about to write in a client's space or your
 * own.
 *
 * The member count is served with the organization rather than counted here:
 * doing it in the client would mean pulling the whole member list of every
 * organization on screen just to show a number beside its name.
 */
function OrgHeader() {
  const org = useOrgsStore((s) => s.currentOrg());
  const spaces = useTasksStore((s) => s.tree.length);
  if (!org) return null;
  const partes = [
    org.role,
    org.memberCount ? `${org.memberCount} member${org.memberCount === 1 ? "" : "s"}` : "",
    spaces ? `${spaces} space${spaces === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return (
    <div className="px-3 pb-1 pt-2">
      <p className="truncate text-sm font-medium">{org.name}</p>
      <p className="truncate text-xs text-muted-foreground">{partes.join(" · ")}</p>
    </div>
  );
}

/** DevTools, folded into one row that opens onto the tools you can use. */
function DevToolsMenu() {
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
        tooltip="DevTools"
        onClick={() => {
          // Clicking the parent both opens the list and goes somewhere: a row
          // that only expands makes you click twice to reach anything.
          setOpen(true);
          if (!dentro) navigate(tools[0]?.path ?? "/devtools");
        }}
      >
        <Wrench className="size-4" />
        <span>DevTools</span>
        <ChevronRight className={cn("ml-auto size-3.5 transition-transform", open && "rotate-90")} />
      </SidebarMenuButton>
      {open && (
        <SidebarMenuSub>
          {tools.map((t) => (
            <SidebarMenuSubItem key={t.path}>
              <SidebarMenuSubButton
                isActive={pathname.startsWith(t.path)}
                onClick={() => navigate(t.path)}
              >
                <t.icon className="size-3.5" />
                <span>{t.label}</span>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          ))}
        </SidebarMenuSub>
      )}
    </SidebarMenuItem>
  );
}

export default function AppSidebar() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { logout } = useAuth();
  const authed = useAuthStore((s) => !!s.accessToken);
  const superadmin = useAuthStore((s) => !!s.session?.superadmin);
  const pendingInvites = useInvitationsStore((s) => s.pending.length);
  // Both counts already live in their stores for the tree and the switcher;
  // reading them here costs nothing and is what makes the group worth having.
  const sinLeerCanales = useChatStore((s) =>
    Object.values(s.unreadBySpace).reduce((a, b) => a + b, 0),
  );
  const sinLeerDirectos = useDMStore((s) =>
    s.conversations.reduce((a, c) => a + c.unread, 0),
  );
  const [pwOpen, setPwOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const unreadNotifications = useNotificationsStore((s) => s.items.filter((i) => !i.read).length);
  const collapsed = useSidebar().state === "collapsed";
  const items = (authed ? NAV_ITEMS : NAV_ITEMS.filter((i) => i.guest)).filter(
    (i) => !i.superadmin || superadmin,
  );

  return (
    <Sidebar collapsible="icon" variant="sidebar">
      <SidebarHeader>
        {/* The brand sits outside the `authed` check below: signed out, the
            sidebar still shows guest navigation, and a product with no name on
            it looks broken. Collapsed it drops to the mark alone, which is the
            same drawing as the window icon. */}
        <div className={cn("flex items-center", collapsed ? "justify-center" : "px-1")}>
          {collapsed ? (
            <BrandMark className="h-5 w-auto" />
          ) : (
            <Brand className="text-sm" />
          )}
        </div>
      </SidebarHeader>
      {authed && !collapsed && <OrgHeader />}
      {authed && (
        <SidebarHeader>
          {/* Collapsed, the header is one icon wide. The org switcher was still
              being rendered into it with flex-1, so it squeezed down to a sliver
              nobody could read or click and pushed the bell off-centre — the
              only part of the sidebar that didn't react to collapsing, because
              the menu below gets its behaviour from SidebarMenuButton and this
              was hand-rolled. */}
          <div
            className={cn(
              "flex items-center gap-1",
              collapsed && "justify-center",
            )}
          >
            {!collapsed && (
              <div className="min-w-0 flex-1">
                <OrgSwitcher />
              </div>
            )}
            <button
              type="button"
              title="Notifications"
              onClick={() => setNotifOpen(true)}
              className="relative shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Bell className="size-4" />
              {unreadNotifications > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-xs font-medium text-primary-foreground">
                  {unreadNotifications > 9 ? "9+" : unreadNotifications}
                </span>
              )}
            </button>
          </div>
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
              <SidebarGroupLabel>{grupo.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {deEsteGrupo.map((item) => {
                    const badge =
                      item.path === "/invitations" && pendingInvites > 0
                        ? pendingInvites
                        : item.path === "/chat" && sinLeerCanales > 0
                          ? sinLeerCanales
                          : item.path === "/dm" && sinLeerDirectos > 0
                            ? sinLeerDirectos
                            : null;
                    return (
                      <SidebarMenuItem key={item.path}>
                        <SidebarMenuButton
                          isActive={pathname.startsWith(item.path)}
                          tooltip={badge ? `${item.label} (${badge})` : item.label}
                          onClick={() => navigate(item.path)}
                        >
                          <item.icon className="size-4" />
                          <span>{item.label}</span>
                          {badge && (
                            <span className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground">
                              {badge}
                            </span>
                          )}
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
        {authed && !collapsed && <AccountRow />}
        <SidebarMenu>
          <SidebarMenuItem>
            <ThemeToggle />
          </SidebarMenuItem>
          <SidebarMenuItem>
            <UpdateCheckButton />
          </SidebarMenuItem>
          {authed && (
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="Change password" onClick={() => setPwOpen(true)}>
                <KeyRound className="size-4" />
                <span>Change password</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          {authed && (
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="Connect Claude Code" onClick={() => setMcpOpen(true)}>
                <Bot className="size-4" />
                <span>Connect Claude Code</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          <SidebarMenuItem>
            {authed ? (
              <SidebarMenuButton
                tooltip="Logout"
                onClick={() => {
                  logout();
                  navigate("/login");
                }}
              >
                <LogOut className="size-4" />
                <span>Logout</span>
              </SidebarMenuButton>
            ) : (
              <SidebarMenuButton tooltip="Sign in" onClick={() => navigate("/login")}>
                <LogIn className="size-4" />
                <span>Sign in</span>
              </SidebarMenuButton>
            )}
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
      <ChangePasswordDialog open={pwOpen} onOpenChange={setPwOpen} />
      <ConnectMcpDialog open={mcpOpen} onOpenChange={setMcpOpen} />
      <NotificationsPanel open={notifOpen} onOpenChange={setNotifOpen} />
    </Sidebar>
  );
}

// Cycles system → light → dark. A three-way toggle beats a switch here: the
// default should follow the OS, but an ops console is often used in conditions
// (bright room, screen share) where you want to override it.
function ThemeToggle() {
  const preference = useThemeStore((s) => s.preference);
  const setPreference = useThemeStore((s) => s.setPreference);

  const next: Record<ThemePreference, ThemePreference> = {
    system: "light",
    light: "dark",
    dark: "system",
  };
  const label: Record<ThemePreference, string> = {
    system: "Theme: system",
    light: "Theme: light",
    dark: "Theme: dark",
  };
  const Icon = preference === "system" ? Monitor : preference === "light" ? Sun : Moon;

  return (
    <SidebarMenuButton
      tooltip={label[preference]}
      onClick={() => setPreference(next[preference])}
    >
      <Icon className="size-4" />
      <span>{label[preference]}</span>
    </SidebarMenuButton>
  );
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function UpdateCheckButton() {
  const checking = useUpdaterStore((s) => s.checking);
  const downloading = useUpdaterStore((s) => s.downloading);
  const available = useUpdaterStore((s) => s.available);
  const lastCheckedAt = useUpdaterStore((s) => s.lastCheckedAt);
  const lastError = useUpdaterStore((s) => s.lastError);
  const checkForUpdate = useUpdaterStore((s) => s.checkForUpdate);
  const installUpdate = useUpdaterStore((s) => s.installUpdate);
  const version = useAppVersion();

  const handleClick = async () => {
    const id = toast.loading("Checking for updates…");
    try {
      const info = await checkForUpdate();
      if (info) {
        toast.success(`Update v${info.version} available`, {
          id,
          description: info.body
            ? info.body.split("\n").slice(0, 3).join("\n")
            : undefined,
          action: { label: "Install", onClick: () => installUpdate() },
          duration: 10_000,
        });
      } else {
        toast.success("You are up to date", { id });
      }
    } catch (e) {
      toast.error("Update check failed", {
        id,
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  let label = version ? `v${version}` : "Check updates";
  let tooltip = version ? `Running v${version} — check for updates` : "Check for updates";
  let Icon = RefreshCw;
  let iconClass = "";

  if (downloading) {
    label = "Updating…";
    tooltip = "Downloading update";
    Icon = Download;
  } else if (checking) {
    label = "Checking…";
    tooltip = "Checking for updates";
    Icon = RefreshCw;
    iconClass = "animate-spin";
  } else if (available) {
    label = `Update to v${available.version}`;
    tooltip = `Running v${version || "?"} — v${available.version} is available`;
    Icon = Download;
    iconClass = "text-primary";
  } else if (lastError) {
    label = "Check failed";
    tooltip = `Last check failed: ${lastError}`;
    Icon = AlertCircle;
    iconClass = "text-destructive";
  } else if (lastCheckedAt) {
    label = version ? `v${version} · up to date` : "Up to date";
    tooltip = `${version ? `Running v${version}. ` : ""}Up to date — checked ${formatRelativeTime(lastCheckedAt)}`;
    Icon = CheckCircle2;
    iconClass = "text-success";
  }

  return (
    <SidebarMenuButton
      tooltip={tooltip}
      disabled={checking || downloading}
      onClick={handleClick}
    >
      <Icon className={cn("size-4", iconClass)} />
      <span>{label}</span>
    </SidebarMenuButton>
  );
}
