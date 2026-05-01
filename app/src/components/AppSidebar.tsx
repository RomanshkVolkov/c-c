import { useNavigate, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  ImageDown,
  Send,
  KeyRound,
  LogOut,
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
import { useAuth } from "@/hooks/use-auth";
import { useUpdaterStore } from "@/store/updater.store";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { label: "Dashboard", path: "/dashboard", icon: LayoutDashboard },
  { label: "Image Tool", path: "/image-tool", icon: ImageDown },
  { label: "Requests", path: "/requests", icon: Send },
  { label: "Crypto Tools", path: "/crypto", icon: KeyRound },
];

export default function AppSidebar() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { logout } = useAuth();

  return (
    <Sidebar collapsible="icon" variant="sidebar">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              tooltip="CAC"
              onClick={() => navigate("/dashboard")}
            >
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold text-sm">
                C
              </div>
              <span className="font-semibold truncate">CAC</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Menu</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map((item) => (
                <SidebarMenuItem key={item.path}>
                  <SidebarMenuButton
                    isActive={pathname.startsWith(item.path)}
                    tooltip={item.label}
                    onClick={() => navigate(item.path)}
                  >
                    <item.icon className="size-4" />
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <UpdateCheckButton />
          </SidebarMenuItem>
          <SidebarMenuItem>
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
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
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

  let label = "Check updates";
  let tooltip = "Check for updates";
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
    label = `Update v${available.version}`;
    tooltip = `Update v${available.version} available`;
    Icon = Download;
    iconClass = "text-primary";
  } else if (lastError) {
    label = "Check failed";
    tooltip = `Last check failed: ${lastError}`;
    Icon = AlertCircle;
    iconClass = "text-destructive";
  } else if (lastCheckedAt) {
    label = "Up to date";
    tooltip = `Up to date — checked ${formatRelativeTime(lastCheckedAt)}`;
    Icon = CheckCircle2;
    iconClass = "text-green-500";
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
