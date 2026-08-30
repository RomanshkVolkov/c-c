import { useT } from "@/lib/i18n";
import { useState } from "react";
import { KeyRound } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api, refreshAccessToken, refreshSession } from "@/lib/api";
import { useOrgsStore } from "@/store/orgs.store";
import type { APIResponse } from "@/types/auth";

/** The shared form. On success it mints a fresh token, refreshes the session
 *  (clearing any must-change flag) and reloads the organizations. */
export function ChangePasswordForm({ onDone }: { onDone?: () => void }) {
  const { t } = useT();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid =
    current.length > 0 && next.length >= 8 && next === confirmPw && next !== current;

  const submit = async () => {
    if (!valid) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.post<APIResponse<unknown>>(
        "/api/v1/auth/change-password",
        { currentPassword: current, newPassword: next },
        true,
      );
      if (!res.success) throw new Error(res.error ?? t("common:admin.changeFailed"));

      // A forced change is the first thing a new account does, and its token
      // was minted before an admin added it to any organization — the `orgs`
      // claim is empty and stays empty, so every org-scoped list comes back
      // empty until the next sign-in. Refreshing the token re-reads the
      // memberships; only then is it worth reloading the session and the org
      // list. Order matters: the refresh reuses the session object it already
      // has, so asking for /auth/me afterwards is what clears must-change.
      await refreshAccessToken();
      await refreshSession();
      await useOrgsStore.getState().fetchOrgs();
      toast.success(t("common:admin.passwordChanged"));
      onDone?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label>{t("common:admin.currentPassword")}</Label>
        <Input
          type="password"
          value={current}
          autoComplete="current-password"
          onChange={(e) => setCurrent(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label>{t("common:admin.newPassword")}</Label>
        <Input
          type="password"
          value={next}
          autoComplete="new-password"
          placeholder={t("common:admin.min8chars")}
          onChange={(e) => setNext(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label>{t("common:admin.confirmNewPassword")}</Label>
        <Input
          type="password"
          value={confirmPw}
          autoComplete="new-password"
          onChange={(e) => setConfirmPw(e.target.value)}
        />
        {confirmPw.length > 0 && next !== confirmPw && (
          <p className="text-xs text-destructive">{t("common:admin.passwordsDontMatch")}</p>
        )}
        {next.length > 0 && next === current && (
          <p className="text-xs text-destructive">{t("common:admin.mustDiffer")}</p>
        )}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button className="w-full" onClick={submit} disabled={!valid || submitting}>
        {submitting ? t("common:admin.saving") : t("common:admin.changePassword")}
      </Button>
    </div>
  );
}

/** Full-screen blocker shown after login when the account must set a new
 *  password (admin-provisioned or reset). No way past it but to change. */
export function ForcedChangePassword() {
  const { t } = useT();
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm space-y-4 rounded-xl border p-6">
        <div className="flex items-center gap-2">
          <KeyRound className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{t("common:admin.setNewPassword")}</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          {t("common:admin.setByAdmin")}
        </p>
        <ChangePasswordForm />
      </div>
    </div>
  );
}

/** Voluntary change, from the sidebar. */
export function ChangePasswordDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { t } = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("common:admin.changePassword")}</DialogTitle>
          <DialogDescription>{t("common:admin.enterCurrentAndNew")}</DialogDescription>
        </DialogHeader>
        <ChangePasswordForm onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
