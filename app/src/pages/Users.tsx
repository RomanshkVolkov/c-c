import { useT } from "@/lib/i18n";
import { useEffect, useState } from "react";
import { Users as UsersIcon, Plus, Trash2, Pencil, ShieldCheck, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useUsersStore } from "@/store/users.store";
import { useAuthStore } from "@/store/auth.store";
import { useConfirm } from "@/components/ConfirmDialog";
import type { AdminUser } from "@/types/user";

export default function Users() {
  const { t } = useT();
  const users = useUsersStore((s) => s.users);
  const loading = useUsersStore((s) => s.loading);
  const error = useUsersStore((s) => s.error);
  const fetchUsers = useUsersStore((s) => s.fetchUsers);
  const deleteUser = useUsersStore((s) => s.deleteUser);
  const meId = useAuthStore((s) => s.session?.id);
  const confirm = useConfirm();

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<AdminUser | null>(null);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const handleDelete = async (u: AdminUser) => {
    const ok = await confirm({
      title: `Delete user @${u.username}?`,
      description: t("common:admin.deleteUserBody"),
      confirmText: t("common:admin.delete"),
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteUser(u.id);
      toast.success(t("common:last.userDeleted", { name: u.username }));
    } catch (e) {
      toast.error(t("common:admin.errDeleteUser"), {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="min-h-0 flex-1 overflow-auto p-6 space-y-4 max-w-4xl mx-auto w-full">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <UsersIcon className="h-6 w-6 text-muted-foreground" />
            <h1 className="text-xl font-semibold">{t("common:admin.users")}</h1>
          </div>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4 mr-1" /> New user
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          {t("common:admin.usersLead")}
        </p>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("common:admin.thUsername")}</TableHead>
                <TableHead>{t("common:admin.thName")}</TableHead>
                <TableHead>{t("common:admin.thEmail")}</TableHead>
                <TableHead>{t("common:admin.thRole")}</TableHead>
                <TableHead className="text-right">{t("common:admin.thActions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && users.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-sm text-muted-foreground py-6">
                    <Loader2 className="inline size-4 animate-spin" /> Loading…
                  </TableCell>
                </TableRow>
              ) : users.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-sm text-muted-foreground py-6">
                    {t("common:admin.noUsers")}
                  </TableCell>
                </TableRow>
              ) : (
                users.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell className="font-medium">{u.username}</TableCell>
                    <TableCell className="text-muted-foreground">{u.name || "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{u.email || "—"}</TableCell>
                    <TableCell>
                      {u.isSuperadmin ? (
                        <Badge className="gap-1">
                          <ShieldCheck className="size-3" /> Superadmin
                        </Badge>
                      ) : (
                        <Badge variant="secondary">{t("common:admin.user")}</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right space-x-1">
                      <Button variant="ghost" size="sm" onClick={() => setEditing(u)}>
                        <Pencil className="size-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => handleDelete(u)}
                        disabled={u.id === meId}
                        title={u.id === meId ? t("common:admin.cantDeleteYourself") : t("common:admin.deleteUser")}
                      >
                        <Trash2 className="size-3" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <CreateUserDialog open={createOpen} onOpenChange={setCreateOpen} />
      <EditUserDialog user={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

function CreateUserDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { t } = useT();
  const createUser = useUsersStore((s) => s.createUser);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [isSuperadmin, setIsSuperadmin] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setUsername("");
    setPassword("");
    setName("");
    setEmail("");
    setIsSuperadmin(false);
  };

  const submit = async () => {
    if (username.trim().length < 3 || password.length < 8) return;
    setSubmitting(true);
    try {
      await createUser({
        username: username.trim(),
        password,
        name: name.trim() || undefined,
        email: email.trim() || undefined,
        isSuperadmin,
      });
      toast.success(t("common:last.userCreated", { name: username.trim() }));
      reset();
      onOpenChange(false);
    } catch (e) {
      toast.error(t("common:admin.errCreateUser"), {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("common:admin.newUser")}</DialogTitle>
          <DialogDescription>
            Creates a platform user. Share the credentials with them; they can be
            invited to organizations afterward.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label>{t("common:admin.username")}</Label>
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="jdoe"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("common:admin.password")}</Label>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t("common:admin.min8")} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Name (optional)</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Doe" />
            </div>
            <div className="space-y-1.5">
              <Label>Email (optional)</Label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="jane@x.com"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isSuperadmin}
              onChange={(e) => setIsSuperadmin(e.target.checked)}
              className="size-4"
            />
            Superadmin (sees & manages all organizations)
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("common:admin.cancel")}</Button>
          <Button
            onClick={submit}
            disabled={submitting || username.trim().length < 3 || password.length < 8}
          >
            {submitting ? t("common:admin.creating") : t("common:admin.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditUserDialog({ user, onClose }: { user: AdminUser | null; onClose: () => void }) {
  const { t } = useT();
  const updateUser = useUsersStore((s) => s.updateUser);
  const meId = useAuthStore((s) => s.session?.id);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSuperadmin, setIsSuperadmin] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (user) {
      setName(user.name);
      setEmail(user.email);
      setPassword("");
      setIsSuperadmin(user.isSuperadmin);
    }
  }, [user]);

  const submit = async () => {
    if (!user) return;
    setSubmitting(true);
    try {
      await updateUser(user.id, {
        name,
        email,
        isSuperadmin,
        ...(password ? { password } : {}),
      });
      toast.success(t("common:last.userUpdated", { name: user.username }));
      onClose();
    } catch (e) {
      toast.error(t("common:admin.errUpdateUser"), {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={!!user} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit @{user?.username}</DialogTitle>
          <DialogDescription>{t("common:admin.blankKeeps")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t("common:admin.thName")}</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>{t("common:admin.thEmail")}</Label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>New password (optional)</Label>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t("common:admin.unchanged")} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isSuperadmin}
              onChange={(e) => setIsSuperadmin(e.target.checked)}
              disabled={user?.id === meId}
              className="size-4"
            />
            {t("common:admin.superadmin")}
            {user?.id === meId && (
              <span className="text-xs text-muted-foreground">(can't change your own)</span>
            )}
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("common:admin.cancel")}</Button>
          <Button onClick={submit} disabled={submitting || !!password && password.length < 8}>
            {submitting ? t("common:admin.saving") : t("common:admin.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
