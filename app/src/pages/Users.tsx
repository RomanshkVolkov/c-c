import { useT } from "@/lib/i18n";
import { useEffect, useState } from "react";
import { Users as UsersIcon, Plus, Trash2, Pencil, ShieldCheck, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
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
      title: t("common:admin.deleteUserTitle", { username: u.username }),
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
            <Plus className="size-4 mr-1" /> {t("common:admin.newUser")}
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
                    <Loader2 className="inline size-4 animate-spin" /> {t("common:admin.loading")}
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

// Lo que falta para poder crear, campo a campo.
//
// El botón se apagaba con usuario < 3 o contraseña < 8 y no lo decía en ningún
// sitio: el «mínimo 8 caracteres» era un placeholder, que desaparece en cuanto
// se escribe. Aquí sale de una sola lista lo que apaga el botón y lo que se le
// enseña a la persona, para que no puedan volver a decir cosas distintas.
// Las reglas son las de `CreateUserRequest` en el backend.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type CreateField = "username" | "password" | "name" | "email";

function createUserProblems(v: Record<CreateField, string>, t: ReturnType<typeof useT>["t"]) {
  const problems: Partial<Record<CreateField, string>> = {};
  if (v.username.trim().length < 3) problems.username = t("common:admin.usernameShort");
  if (v.password.length < 8) problems.password = t("common:admin.passwordShort", { count: v.password.length });
  if (!v.name.trim()) problems.name = t("common:admin.nameRequired");
  if (!v.email.trim()) problems.email = t("common:admin.emailRequired");
  else if (!EMAIL_SHAPE.test(v.email.trim())) problems.email = t("common:admin.emailInvalid");
  return problems;
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
  // Un campo se queja cuando ya tiene algo o ya se pasó por él: abrir el
  // diálogo y verlo todo en rojo no ayuda.
  const [touched, setTouched] = useState<Partial<Record<CreateField, boolean>>>({});

  const values = { username, password, name, email };
  const problems = createUserProblems(values, t);
  const canSubmit = Object.keys(problems).length === 0;
  const shown = (f: CreateField) => (touched[f] || values[f] !== "" ? problems[f] : undefined);
  const touch = (f: CreateField) => () => setTouched((s) => ({ ...s, [f]: true }));

  const reset = () => {
    setUsername("");
    setPassword("");
    setName("");
    setEmail("");
    setIsSuperadmin(false);
    setTouched({});
  };

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await createUser({
        username: username.trim(),
        password,
        name: name.trim(),
        email: email.trim(),
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

  const hint = (f: CreateField) => {
    const p = shown(f);
    return p ? <p className="text-xs text-destructive">{p}</p> : null;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("common:admin.newUser")}</DialogTitle>
          <DialogDescription>{t("common:admin.createUserLead")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="new-user-username">{t("common:admin.username")}</Label>
            <Input
              id="new-user-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onBlur={touch("username")}
              aria-invalid={!!shown("username")}
              placeholder="jdoe"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
            />
            {hint("username")}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-user-password">{t("common:admin.password")}</Label>
            <PasswordInput
              id="new-user-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onBlur={touch("password")}
              aria-invalid={!!shown("password")}
              autoComplete="new-password"
              placeholder={t("common:admin.min8")}
            />
            {hint("password")}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="new-user-name">{t("common:admin.thName")}</Label>
              <Input
                id="new-user-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={touch("name")}
                aria-invalid={!!shown("name")}
                placeholder="Jane Doe"
              />
              {hint("name")}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-user-email">{t("common:admin.thEmail")}</Label>
              <Input
                id="new-user-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onBlur={touch("email")}
                aria-invalid={!!shown("email")}
                placeholder="jane@x.com"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
              {hint("email")}
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isSuperadmin}
              onChange={(e) => setIsSuperadmin(e.target.checked)}
              className="size-4"
            />
            {t("common:admin.superadminAll")}
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("common:admin.cancel")}</Button>
          <Button
            onClick={submit}
            disabled={submitting || !canSubmit}
            // Apagado nunca en silencio: el título dice todo lo que falta,
            // incluido lo de campos por los que aún no se ha pasado.
            title={canSubmit ? undefined : Object.values(problems).join(" · ")}
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
          <DialogTitle>{t("common:admin.editUser", { username: user?.username ?? "" })}</DialogTitle>
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
            <Label>{t("common:admin.newPasswordOptional")}</Label>
            <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t("common:admin.unchanged")} />
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
              <span className="text-xs text-muted-foreground">{t("common:admin.cantChangeOwnRole")}</span>
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
