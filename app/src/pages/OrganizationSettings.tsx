import { useCallback, useEffect, useState } from "react";
import { Building2, UserPlus, Trash2, Mail, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import UserPicker from "@/components/UserPicker";
import { useConfirm } from "@/components/ConfirmDialog";
import { useOrgsStore } from "@/store/orgs.store";
import { useAuthStore } from "@/store/auth.store";
import type { OrgMember, OrgRole, Invitation } from "@/types/organization";
import type { UserSummary } from "@/types/collections";

const ROLES: OrgRole[] = ["admin", "member", "viewer"];

export default function OrganizationSettings() {
  const current = useOrgsStore((s) => s.currentOrg());
  const superadmin = useAuthStore((s) => !!s.session?.superadmin);
  const confirm = useConfirm();

  const listMembers = useOrgsStore((s) => s.listMembers);
  const addMember = useOrgsStore((s) => s.addMember);
  const updateMemberRole = useOrgsStore((s) => s.updateMemberRole);
  const removeMember = useOrgsStore((s) => s.removeMember);
  const listOrgInvitations = useOrgsStore((s) => s.listOrgInvitations);
  const createInvitation = useOrgsStore((s) => s.createInvitation);
  const revokeInvitation = useOrgsStore((s) => s.revokeInvitation);

  const [members, setMembers] = useState<OrgMember[]>([]);
  const [invites, setInvites] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(false);

  const [picked, setPicked] = useState<UserSummary | null>(null);
  const [role, setRole] = useState<OrgRole>("member");
  const [pickerKey, setPickerKey] = useState(0); // reset picker after use

  const orgId = current?.id;
  const canManage = superadmin || current?.role === "admin";

  const refresh = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      const [m, i] = await Promise.all([
        listMembers(orgId),
        canManage ? listOrgInvitations(orgId) : Promise.resolve([]),
      ]);
      setMembers(m);
      setInvites(i);
    } catch (e) {
      toast.error("Failed to load organization", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setLoading(false);
    }
  }, [orgId, canManage, listMembers, listOrgInvitations]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (!current) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
        No organization selected.
      </div>
    );
  }

  const resetPicker = () => {
    setPicked(null);
    setPickerKey((k) => k + 1);
  };

  const invite = async () => {
    if (!picked || !orgId) return;
    try {
      await createInvitation(orgId, { userId: picked.id, role });
      toast.success(`Invited @${picked.username} to ${current.name}`);
      resetPicker();
      refresh();
    } catch (e) {
      toast.error("Could not send invitation", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  // Direct assignment (no accept step) — for admins/superadmins onboarding a user
  // straight into the org.
  const addDirect = async () => {
    if (!picked || !orgId) return;
    try {
      await addMember(orgId, { userId: picked.id, role });
      toast.success(`Added @${picked.username} to ${current.name}`);
      resetPicker();
      refresh();
    } catch (e) {
      toast.error("Could not add member", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const changeRole = async (userId: string, next: OrgRole) => {
    if (!orgId) return;
    try {
      await updateMemberRole(orgId, userId, next);
      setMembers((prev) => prev.map((m) => (m.userId === userId ? { ...m, role: next } : m)));
    } catch (e) {
      toast.error("Could not change role", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const kick = async (m: OrgMember) => {
    if (!orgId) return;
    const ok = await confirm({
      title: `Remove @${m.username}?`,
      description: `They will lose access to ${current.name} and its resources.`,
      confirmText: "Remove",
      destructive: true,
    });
    if (!ok) return;
    try {
      await removeMember(orgId, m.userId);
      setMembers((prev) => prev.filter((x) => x.userId !== m.userId));
      toast.success(`Removed @${m.username}`);
    } catch (e) {
      toast.error("Could not remove member", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const revoke = async (inv: Invitation) => {
    if (!orgId) return;
    const ok = await confirm({
      title: `Revoke invitation to @${inv.invitedUser}?`,
      confirmText: "Revoke",
      destructive: true,
    });
    if (!ok) return;
    try {
      await revokeInvitation(orgId, inv.id);
      setInvites((prev) => prev.filter((x) => x.id !== inv.id));
    } catch (e) {
      toast.error("Could not revoke invitation", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex-1 overflow-auto p-6 space-y-6 max-w-3xl mx-auto w-full">
        <div className="flex items-center gap-3">
          <Building2 className="h-6 w-6 text-muted-foreground" />
          <div>
            <h1 className="text-xl font-semibold">{current.name}</h1>
            <p className="text-xs capitalize text-muted-foreground">
              Your role: {current.role}
              {superadmin && " · superadmin"}
            </p>
          </div>
        </div>

        {/* Invite */}
        {canManage && (
          <section className="space-y-2">
            <Label className="text-sm font-medium">Invite a user</Label>
            <div className="flex items-start gap-2">
              <div className="flex-1">
                <UserPicker key={pickerKey} onSelect={setPicked} placeholder="Search username…" />
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
              <Button variant="outline" onClick={addDirect} disabled={!picked} title="Add without an invitation">
                Add
              </Button>
              <Button onClick={invite} disabled={!picked}>
                <UserPlus className="size-4 mr-1" /> Invite
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              <strong>Add</strong> assigns the user immediately. <strong>Invite</strong> sends a
              request they accept from their own “Invitations” screen — no email needed.
            </p>
          </section>
        )}

        {/* Pending invitations */}
        {canManage && invites.length > 0 && (
          <section className="space-y-2">
            <Label className="text-sm font-medium flex items-center gap-1.5">
              <Mail className="size-4" /> Pending invitations ({invites.length})
            </Label>
            <div className="rounded-lg border divide-y">
              {invites.map((inv) => (
                <div key={inv.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                  <span className="flex-1 truncate">@{inv.invitedUser}</span>
                  <Badge variant="secondary" className="capitalize">{inv.role}</Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => revoke(inv)}
                    title="Revoke"
                  >
                    <X className="size-3" />
                  </Button>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Members */}
        <section className="space-y-2">
          <Label className="text-sm font-medium">Members ({members.length})</Label>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Username</TableHead>
                  <TableHead className="w-40">Role</TableHead>
                  <TableHead className="text-right w-16">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading && members.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-sm text-muted-foreground py-6">
                      <Loader2 className="inline size-4 animate-spin" /> Loading…
                    </TableCell>
                  </TableRow>
                ) : (
                  members.map((m) => (
                    <TableRow key={m.userId}>
                      <TableCell className="font-medium">{m.username}</TableCell>
                      <TableCell>
                        {canManage ? (
                          <Select
                            value={m.role}
                            onValueChange={(v) => v && changeRole(m.userId, v as OrgRole)}
                          >
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
                        ) : (
                          <span className="capitalize text-muted-foreground">{m.role}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {canManage && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            onClick={() => kick(m)}
                          >
                            <Trash2 className="size-3" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </section>
      </div>
    </div>
  );
}
