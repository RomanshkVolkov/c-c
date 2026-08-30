import { useT } from "@/lib/i18n";
import { useEffect, useState } from "react";
import { Mail, Check, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useInvitationsStore } from "@/store/invitations.store";
import { useOrgsStore } from "@/store/orgs.store";

export default function Invitations() {
  const { t } = useT();
  const pending = useInvitationsStore((s) => s.pending);
  const loading = useInvitationsStore((s) => s.loading);
  const fetchMine = useInvitationsStore((s) => s.fetchMine);
  const accept = useInvitationsStore((s) => s.accept);
  const decline = useInvitationsStore((s) => s.decline);
  const fetchOrgs = useOrgsStore((s) => s.fetchOrgs);

  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    fetchMine();
  }, [fetchMine]);

  const onAccept = async (id: string, orgName: string) => {
    setBusy(id);
    try {
      const { renovado } = await accept(id);
      // Si no se pudo renovar la sesión, la invitación **sí** quedó aceptada —
      // decir «no se pudo» sería mentir y llevaría a reintentar sobre una
      // invitación ya gastada. Lo que falta es la credencial nueva, y eso se
      // arregla volviendo a entrar.
      if (renovado) {
        toast.success(t("common:last.joinedOrg", { name: orgName }));
      } else {
        toast.warning(t("common:last.joinedOrg", { name: orgName }), {
          description: t("common:misc.signOutToFinish"),
        });
      }
      await fetchOrgs(); // the new org appears in the switcher immediately
    } catch (e) {
      toast.error(t("common:misc.errAccept"), {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(null);
    }
  };

  const onDecline = async (id: string) => {
    setBusy(id);
    try {
      await decline(id);
    } catch (e) {
      toast.error(t("common:misc.errDecline"), {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex-1 overflow-auto p-6 space-y-4 max-w-2xl mx-auto w-full">
        <div className="flex items-center gap-3">
          <Mail className="h-6 w-6 text-muted-foreground" />
          <h1 className="text-xl font-semibold">{t("common:misc.invitations")}</h1>
        </div>

        {loading && pending.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            <Loader2 className="inline size-4 animate-spin" /> Loading…
          </p>
        ) : pending.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("common:misc.noPendingInvites")}</p>
        ) : (
          <div className="space-y-2">
            {pending.map((inv) => (
              <div
                key={inv.id}
                className="flex items-center gap-3 rounded-lg border p-3"
              >
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{inv.orgName}</p>
                  <p className="text-xs text-muted-foreground">
                    Invited by @{inv.invitedBy} · role{" "}
                    <Badge variant="secondary" className="capitalize">{inv.role}</Badge>
                  </p>
                </div>
                <Button
                  size="sm"
                  onClick={() => onAccept(inv.id, inv.orgName)}
                  disabled={busy === inv.id}
                >
                  <Check className="size-4 mr-1" /> Accept
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onDecline(inv.id)}
                  disabled={busy === inv.id}
                >
                  <X className="size-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
