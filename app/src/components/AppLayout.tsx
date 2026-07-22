import { useEffect } from "react";
import { Outlet } from "react-router-dom";
import { Toaster } from "sonner";
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import AppSidebar from "@/components/AppSidebar";
import UpdateChecker from "@/components/UpdateChecker";
import { useOrgsStore } from "@/store/orgs.store";
import { useReportEvents } from "@/hooks/use-report-events";
import { ensureOrgClaim } from "@/lib/api";

export default function AppLayout() {
  const fetchOrgs = useOrgsStore((s) => s.fetchOrgs);

  // Load the caller's organizations once the authenticated shell mounts. First
  // upgrade a pre-orgs token (else org-scoped lists come back empty) so the
  // switcher and lists have data without a manual re-login.
  useEffect(() => {
    ensureOrgClaim().then(fetchOrgs);
  }, [fetchOrgs]);

  // Live report notifications (SSE) for the whole authenticated shell.
  useReportEvents();

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
      <Toaster richColors closeButton position="bottom-right" />
    </SidebarProvider>
  );
}
