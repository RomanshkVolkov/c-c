import { useState } from "react";
import { Copy, MailPlus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { codigoDe } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { useT } from "@/lib/i18n";
import { phraseFor } from "@/lib/server-errors";
import { useOrgsStore } from "@/store/orgs.store";
import type { OrgRole } from "@/types/organization";

const ROLES: OrgRole[] = ["admin", "member", "viewer"];
// Lo mismo que pide el servidor (`validate:"email"`), sin pretender más.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Dar de alta a alguien que todavía no tiene cuenta: nombre y correo.
 *
 * Le llega un enlace y elige su usuario y su contraseña; quien da de alta no
 * sabe ninguna. Si el correo ya tiene cuenta, el servidor no la duplica: le
 * invita como «Invitar» de al lado, y se dice.
 *
 * Si el correo no sale (SES en sandbox, o sin correo configurado), la cuenta
 * queda creada igual y el enlace se enseña aquí para pasarlo a mano. Sólo
 * entonces: quien tiene el enlace elige la contraseña de otra persona.
 */
export default function OrgCreateAccount({
  orgId,
  orgName,
  defaultRole,
  onDone,
}: {
  orgId: string;
  orgName: string;
  defaultRole: OrgRole;
  /** Algo cambió: un miembro nuevo o una invitación nueva. */
  onDone: () => void;
}) {
  const { t } = useT();
  const createAccount = useOrgsStore((s) => s.createAccount);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OrgRole>(defaultRole);
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState<{ name: string; link: string } | null>(null);

  const ready = name.trim() !== "" && EMAIL.test(email.trim()) && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      const out = await createAccount(orgId, { name: name.trim(), email: email.trim(), role });
      if (out.status === "invited") {
        toast.success(t("common:account.invited", { email: email.trim(), org: orgName }));
      } else if (out.emailSent) {
        toast.success(t("common:account.created", { email: email.trim() }));
      } else if (out.link) {
        setManual({ name: name.trim(), link: out.link });
      }
      setName("");
      setEmail("");
      onDone();
    } catch (e) {
      const code = codigoDe(e) || (e instanceof Error ? e.message : "");
      toast.error(phraseFor(code, t("errors:account-failed")));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 rounded-xl border bg-card p-4">
      <div className="space-y-1">
        <Label className="text-sm font-medium">{t("common:account.createTitle")}</Label>
        <p className="text-xs text-muted-foreground">{t("common:account.createLead")}</p>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="flex flex-wrap items-start gap-2"
      >
        <Input
          aria-label={t("common:account.name")}
          placeholder={t("common:account.name")}
          className="min-w-40 flex-1"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          type="email"
          aria-label={t("common:account.email")}
          placeholder={t("common:account.email")}
          className="min-w-48 flex-1"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
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
        <Button type="submit" disabled={!ready}>
          <MailPlus className="mr-1 size-4" /> {t("common:account.create")}
        </Button>
      </form>

      <Dialog open={manual !== null} onOpenChange={(o) => !o && setManual(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("common:account.linkTitle")}</DialogTitle>
            <DialogDescription>{t("common:account.linkLead", { name: manual?.name ?? "" })}</DialogDescription>
          </DialogHeader>
          <p className="break-all rounded-md bg-muted px-3 py-2 font-mono text-xs" data-testid="account-link">
            {manual?.link}
          </p>
          <DialogFooter>
            <Button
              onClick={() => {
                if (!manual) return;
                void copyText(manual.link).then(() => toast.success(t("common:account.linkCopied")));
              }}
            >
              <Copy className="mr-1 size-4" /> {t("common:account.copyLink")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
