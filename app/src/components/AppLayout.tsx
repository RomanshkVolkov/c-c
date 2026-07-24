import { useEffect } from "react";
import { Outlet } from "react-router-dom";
import { Toaster } from "sonner";
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import AppSidebar from "@/components/AppSidebar";
import UpdateChecker from "@/components/UpdateChecker";
import { useOrgsStore } from "@/store/orgs.store";
import { useReportEvents } from "@/hooks/use-report-events";
import { ensureOrgClaim, refreshSession } from "@/lib/api";
import { useAuthStore } from "@/store/auth.store";
import { useInvitationsStore } from "@/store/invitations.store";
import { ForcedChangePassword } from "@/components/ChangePassword";

export default function AppLayout() {
  const fetchOrgs = useOrgsStore((s) => s.fetchOrgs);
  const fetchInvitations = useInvitationsStore((s) => s.fetchMine);
  const authed = useAuthStore((s) => !!s.accessToken);
  const mustChangePassword = useAuthStore((s) => !!s.session?.mustChangePassword);

  // Load the caller's organizations once the authenticated shell mounts. First
  // upgrade a pre-orgs token (else org-scoped lists come back empty) so the
  // switcher and lists have data without a manual re-login. Also fetch pending
  // invitations for the sidebar badge. Skipped for guests (no token → 401).
  useEffect(() => {
    if (authed) {
      ensureOrgClaim().then(() => {
        refreshSession();
        fetchOrgs();
      });
      fetchInvitations();
    }
  }, [authed, fetchOrgs, fetchInvitations]);

  // Live report notifications (SSE) for the whole authenticated shell.
  useReportEvents();

  // Block the whole shell until an admin-provisioned/reset password is changed.
  if (authed && mustChangePassword) {
    return <ForcedChangePassword />;
  }

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
