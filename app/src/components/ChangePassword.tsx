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
      if (!res.success) throw new Error(res.error ?? "Change failed");

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
      toast.success("Password changed");
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
        <Label>Current password</Label>
        <Input
          type="password"
          value={current}
          autoComplete="current-password"
          onChange={(e) => setCurrent(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label>New password</Label>
        <Input
          type="password"
          value={next}
          autoComplete="new-password"
          placeholder="min 8 characters"
          onChange={(e) => setNext(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label>Confirm new password</Label>
        <Input
          type="password"
          value={confirmPw}
          autoComplete="new-password"
          onChange={(e) => setConfirmPw(e.target.value)}
        />
        {confirmPw.length > 0 && next !== confirmPw && (
          <p className="text-xs text-destructive">Passwords don't match.</p>
        )}
        {next.length > 0 && next === current && (
          <p className="text-xs text-destructive">New password must differ from the current one.</p>
        )}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button className="w-full" onClick={submit} disabled={!valid || submitting}>
        {submitting ? "Saving…" : "Change password"}
      </Button>
    </div>
  );
}

/** Full-screen blocker shown after login when the account must set a new
 *  password (admin-provisioned or reset). No way past it but to change. */
export function ForcedChangePassword() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm space-y-4 rounded-xl border p-6">
        <div className="flex items-center gap-2">
          <KeyRound className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Set a new password</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Your password was set by an administrator. Choose your own to continue.
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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change password</DialogTitle>
          <DialogDescription>Enter your current password and a new one.</DialogDescription>
        </DialogHeader>
        <ChangePasswordForm onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
