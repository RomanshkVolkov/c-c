import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  Bell,
  LayoutDashboard,
  Bug,
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
  SidebarRail,
} from "@/components/ui/sidebar";
import { toast } from "sonner";
import OrgSwitcher from "@/components/OrgSwitcher";
import { ChangePasswordDialog } from "@/components/ChangePassword";
import ConnectMcpDialog from "@/components/ConnectMcpDialog";
import NotificationsPanel from "@/components/NotificationsPanel";
import { useAuth } from "@/hooks/use-auth";
import { useAuthStore } from "@/store/auth.store";
import { useInvitationsStore } from "@/store/invitations.store";
import { useUpdaterStore } from "@/store/updater.store";
import { useNotificationsStore } from "@/store/notifications.store";
import { useThemeStore, type ThemePreference } from "@/store/theme.store";
import { cn } from "@/lib/utils";

// guest: reachable on-device (no backend). superadmin: only for platform admins.
const NAV_ITEMS = [
  { label: "Dashboard", path: "/dashboard", icon: LayoutDashboard, guest: false },
  { label: "Tasks", path: "/tasks", icon: KanbanSquare, guest: false },
  { label: "Notes", path: "/notes", icon: NotebookPen, guest: false },
  { label: "Reports", path: "/reports", icon: Bug, guest: false },
  { label: "Image Tool", path: "/image-tool", icon: ImageDown, guest: true },
  { label: "Requests", path: "/requests", icon: Send, guest: false },
  { label: "Crypto Tools", path: "/crypto", icon: KeyRound, guest: true },
  { label: "Diagnostics", path: "/diagnostics", icon: Activity, guest: false },
  { label: "Organization", path: "/organization", icon: Building2, guest: false },
  { label: "Invitations", path: "/invitations", icon: Mail, guest: false },
  { label: "Users", path: "/users", icon: Users, guest: false, superadmin: true },
];

export default function AppSidebar() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { logout } = useAuth();
  const authed = useAuthStore((s) => !!s.accessToken);
  const superadmin = useAuthStore((s) => !!s.session?.superadmin);
  const pendingInvites = useInvitationsStore((s) => s.pending.length);
  const [pwOpen, setPwOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const unreadNotifications = useNotificationsStore((s) => s.items.filter((i) => !i.read).length);
  const items = (authed ? NAV_ITEMS : NAV_ITEMS.filter((i) => i.guest)).filter(
    (i) => !i.superadmin || superadmin,
  );

  return (
    <Sidebar collapsible="icon" variant="sidebar">
      {authed && (
        <SidebarHeader>
          <div className="flex items-center gap-1">
            <div className="min-w-0 flex-1">
              <OrgSwitcher />
            </div>
            <button
              type="button"
              title="Notifications"
              onClick={() => setNotifOpen(true)}
              className="relative shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Bell className="size-4" />
              {unreadNotifications > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-medium text-primary-foreground">
                  {unreadNotifications > 9 ? "9+" : unreadNotifications}
                </span>
              )}
            </button>
          </div>
        </SidebarHeader>
      )}

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Menu</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {items.map((item) => {
                const badge =
                  item.path === "/invitations" && pendingInvites > 0 ? pendingInvites : null;
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
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
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
  // Which build am I actually running? Without this the only answer was the
  // release notes on GitHub, and an installed app that updates on its own is
  // exactly where that question comes up.
  const [version, setVersion] = useState("");
  useEffect(() => {
    void import("@tauri-apps/api/app")
      .then(({ getVersion }) => getVersion())
      .then(setVersion)
      .catch(() => {}); // running in a plain browser
  }, []);

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
