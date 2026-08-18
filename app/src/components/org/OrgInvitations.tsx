import { useState } from "react";
import { Mail, UserPlus, RotateCw, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import UserPicker from "@/components/UserPicker";
import { useConfirm } from "@/components/ConfirmDialog";
import { useOrgsStore } from "@/store/orgs.store";
import { desde, faltan, vencio, iniciales } from "@/lib/desde";
import type { Invitation, OrgRole } from "@/types/organization";

const ROLES: OrgRole[] = ["admin", "member", "viewer"];

/**
 * Invitar a alguien, y qué pasó con lo ya invitado.
 *
 * Dos verbos que se confunden y por eso van explicados debajo del formulario:
 * **añadir directo** mete a la persona en el acto, **invitar** le manda una
 * solicitud que acepta desde su propia app. No hay correo de por medio.
 *
 * La lista de pendientes incluye las **caducadas**, y por eso existe
 * «Reenviar»: sin ellas a la vista, una invitación vencida no se podía ni
 * retirar ni repetir —chocaba con la guarda de «ya hay una pendiente»— y el
 * único camino era ir a la base de datos.
 */
export default function OrgInvitations({
  orgId,
  orgName,
  invites,
  setInvites,
  canManage,
  defaultRole,
  onAdded,
}: {
  orgId: string;
  orgName: string;
  invites: Invitation[];
  setInvites: (f: (prev: Invitation[]) => Invitation[]) => void;
  canManage: boolean;
  defaultRole: OrgRole;
  onAdded: () => void;
}) {
  const confirm = useConfirm();
  const createInvitation = useOrgsStore((s) => s.createInvitation);
  const revokeInvitation = useOrgsStore((s) => s.revokeInvitation);
  const resendInvitation = useOrgsStore((s) => s.resendInvitation);
  const listOrgInvitations = useOrgsStore((s) => s.listOrgInvitations);
  const addMember = useOrgsStore((s) => s.addMember);

  const [picked, setPicked] = useState<{ id: string; username: string } | null>(null);
  const [pickerKey, setPickerKey] = useState(0);
  const [role, setRole] = useState<OrgRole>(defaultRole);
  const [ocupado, setOcupado] = useState<string | null>(null);

  const limpiar = () => {
    setPicked(null);
    setPickerKey((k) => k + 1);
  };

  const invitar = async () => {
    if (!picked) return;
    try {
      await createInvitation(orgId, { userId: picked.id, role });
      toast.success(`Invited @${picked.username} to ${orgName}`);
      limpiar();
      setInvites(() => []);
      listOrgInvitations(orgId).then((i) => setInvites(() => i)).catch(() => {});
    } catch (e) {
      toast.error("Could not send invitation", {
        description: e instanceof Error ? e.message : undefined,
      });
    }
  };

  const anadirDirecto = async () => {
    if (!picked) return;
    try {
      await addMember(orgId, { userId: picked.id, role });
      toast.success(`@${picked.username} added to ${orgName}`);
      limpiar();
      onAdded();
    } catch (e) {
      toast.error("Could not add the user", {
        description: e instanceof Error ? e.message : undefined,
      });
    }
  };

  const reenviar = async (inv: Invitation) => {
    setOcupado(inv.id);
    try {
      await resendInvitation(orgId, inv.id);
      const frescas = await listOrgInvitations(orgId);
      setInvites(() => frescas);
      toast.success(`Invitation to @${inv.invitedUser} renewed`);
    } catch (e) {
      toast.error("Could not resend the invitation", {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setOcupado(null);
    }
  };

  const revocar = async (inv: Invitation) => {
    const ok = await confirm({
      title: `Revoke invitation to @${inv.invitedUser}?`,
      description: "They will no longer be able to accept it.",
      confirmText: "Revoke",
      destructive: true,
    });
    if (!ok) return;
    try {
      await revokeInvitation(orgId, inv.id);
      setInvites((prev) => prev.filter((x) => x.id !== inv.id));
    } catch (e) {
      toast.error("Could not revoke invitation", {
        description: e instanceof Error ? e.message : undefined,
      });
    }
  };

  return (
    <div className="space-y-4">
      {canManage && (
        <section className="space-y-3 rounded-xl border bg-card p-4">
          <Label className="text-sm font-medium">Invite someone</Label>
          <div className="flex flex-wrap items-start gap-2">
            <div className="min-w-56 flex-1">
              <UserPicker key={pickerKey} onSelect={setPicked} placeholder="Search by @username…" />
            </div>
            <Select value={role} onValueChange={(v) => v && setRole(v as OrgRole)}>
              <SelectTrigger className="w-32 capitalize">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((r) => (
                  <SelectItem key={r} value={r} className="capitalize">
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" onClick={anadirDirecto} disabled={!picked}>
              Add directly
            </Button>
            <Button onClick={invitar} disabled={!picked}>
              <UserPlus className="mr-1 size-4" /> Send invitation
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            <strong>Add directly</strong> assigns the person right away.{" "}
            <strong>Invite</strong> sends them a request they accept from their own app — no
            email needed.
          </p>
        </section>
      )}

      <section className="space-y-2">
        <Label className="flex items-center gap-1.5 text-sm font-medium">
          <Mail className="size-4" /> Pending ({invites.length})
        </Label>
        {invites.length === 0 ? (
          <p className="rounded-xl border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
            No pending invitations.
          </p>
        ) : (
          <ul className="divide-y overflow-hidden rounded-xl border bg-card">
            {invites.map((inv) => {
              const caducada = vencio(inv.expiresAt);
              return (
                <li key={inv.id} className="flex flex-wrap items-center gap-3 px-3.5 py-2.5 text-sm">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium">
                    {iniciales(inv.invitedUser)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">@{inv.invitedUser}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      invited by @{inv.invitedBy} · {desde(inv.createdAt)}
                    </span>
                  </span>
                  <Badge variant="secondary" className="capitalize">
                    {inv.role}
                  </Badge>
                  <Badge
                    variant="outline"
                    className={caducada ? "border-destructive/40 text-destructive" : ""}
                  >
                    {caducada ? "expired" : faltan(inv.expiresAt) || "pending"}
                  </Badge>
                  {canManage && (
                    <span className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => reenviar(inv)}
                        disabled={ocupado === inv.id}
                        title="Give it a fresh 14 days"
                      >
                        <RotateCw className="mr-1 size-3" /> Resend
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => revocar(inv)}
                        title="Revoke"
                      >
                        <X className="mr-1 size-3" /> Revoke
                      </Button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
