import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import { Search } from "lucide-react";
import CommandPalette from "@/components/CommandPalette";
import { Toaster } from "sonner";
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import AppSidebar from "@/components/AppSidebar";
import UpdateChecker from "@/components/UpdateChecker";
import ConnectionBanner from "@/components/ConnectionBanner";
import { useOrgsStore } from "@/store/orgs.store";
import { useReportEvents } from "@/hooks/use-report-events";
import { ensureOrgClaim, refreshSession } from "@/lib/api";
import { useAuthStore } from "@/store/auth.store";
import { useInvitationsStore } from "@/store/invitations.store";
import { useThemeStore } from "@/store/theme.store";
import { ForcedChangePassword } from "@/components/ChangePassword";

export default function AppLayout() {
  const fetchOrgs = useOrgsStore((s) => s.fetchOrgs);
  const fetchInvitations = useInvitationsStore((s) => s.fetchMine);
  const authed = useAuthStore((s) => !!s.accessToken);
  const mustChangePassword = useAuthStore((s) => !!s.session?.mustChangePassword);
  // sonner renders in its own tree and ignores the .dark class.
  const theme = useThemeStore((s) => s.resolved);

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

  // ⌘K anywhere, and Escape closes it because the dialog handles that itself.
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <ConnectionBanner />
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="md:hidden" />
          {/* Centred and always there, because a search you have to remember a
              shortcut for is one most people never find. Clicking it opens the
              same palette ⌘K does. */}
          <button
            onClick={() => setPaletteOpen(true)}
            className="mx-auto flex w-full max-w-md items-center gap-2 rounded-md border bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/60"
          >
            <Search className="size-3.5" />
            <span>Search tasks, messages, people…</span>
            <kbd className="ml-auto font-mono text-[10px] opacity-70">⌘K</kbd>
          </button>
        </header>
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
        <Outlet />
      </SidebarInset>
      <UpdateChecker />
      <Toaster richColors closeButton position="bottom-right" theme={theme} />
    </SidebarProvider>
  );
}
