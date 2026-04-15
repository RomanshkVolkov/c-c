import { useNavigate, useLocation } from "react-router-dom";
import { LayoutDashboard, ImageDown, Send, KeyRound, LogOut } from "lucide-react";
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
import { useAuth } from "@/hooks/use-auth";

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
