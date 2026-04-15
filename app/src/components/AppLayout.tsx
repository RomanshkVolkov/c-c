import { Outlet } from "react-router-dom";
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import AppSidebar from "@/components/AppSidebar";
import UpdateChecker from "@/components/UpdateChecker";

export default function AppLayout() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4 md:hidden">
          <SidebarTrigger />
        </header>
        <Outlet />
      </SidebarInset>
      <UpdateChecker />
    </SidebarProvider>
  );
}
