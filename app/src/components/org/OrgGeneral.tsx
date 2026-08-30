import { useT } from "@/lib/i18n";
import { useState } from "react";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useOrgsStore } from "@/store/orgs.store";
import { useAuthStore } from "@/store/auth.store";
import DeleteOrgDialog from "@/components/org/DeleteOrgDialog";
import type { Organization, OrgRole } from "@/types/organization";
import { cn } from "@/lib/utils";

/**
 * What the organization is, how it behaves, and how it ends.
 *
 * Three cards and not one list, because they are three different kinds of
 * decision: naming it is routine, the rules change what other people can see,
 * and the last one cannot be undone. Putting them at the same visual level is
 * how somebody ends up doing the third while meaning the first.
 */
export default function OrgGeneral({
  org,
  canManage,
}: {
  org: Organization;
  canManage: boolean;
}) {
  const { t } = useT();
  const updateOrg = useOrgsStore((s) => s.updateOrg);
  const deleteOrg = useOrgsStore((s) => s.deleteOrg);
  const superadmin = useAuthStore((s) => !!s.session?.superadmin);
  const navigate = useNavigate();

  const [nombre, setNombre] = useState(org.name);
  const [borrar, setBorrar] = useState(false);

  const guardar = async (patch: Partial<Organization>) => {
    try {
      await updateOrg(org.id, { name: nombre.trim() || org.name, ...patch });
    } catch (e) {
      toast.error(t("org:errSave"), { description: String(e) });
    }
  };

  const Interruptor = ({
    on,
    onChange,
    label,
    hint,
    disabled,
  }: {
    on: boolean;
    onChange: () => void;
    label: string;
    hint?: string;
    disabled?: boolean;
  }) => (
    <button
      onClick={onChange}
      disabled={disabled || !canManage}
      className="flex w-full items-center gap-3 rounded px-1 py-1.5 text-left disabled:opacity-60"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm">{label}</span>
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
      <span
        aria-hidden
        className={cn(
          "flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors",
          on ? "bg-primary" : "bg-muted",
        )}
      >
        <span
          className={cn(
            "size-3 rounded-full bg-background transition-transform",
            on && "translate-x-3",
          )}
        />
      </span>
    </button>
  );

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <section className="space-y-3 rounded-xl border bg-card p-4">
        <h2 className="text-sm font-medium">{t("org:identity")}</h2>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">{t("org:name")}</label>
          <Input
            value={nombre}
            disabled={!canManage}
            onChange={(e) => setNombre(e.target.value)}
            onBlur={() => nombre.trim() && nombre !== org.name && guardar({})}
          />
        </div>
        {/* The slug is shown and not editable: URLs and integrations are built
            on it, and changing it would break links that already exist
            somewhere nobody here can see. */}
        <Campo label={t("org:identifier")} value={org.slug} mono />
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">{t("org:domain")}</label>
          <Input
            defaultValue={org.domain ?? ""}
            disabled={!canManage}
            placeholder="example.com"
            onBlur={(e) => e.target.value !== (org.domain ?? "") && guardar({ domain: e.target.value })}
          />
        </div>
        <Campo
          label={t("org:created")}
          value={new Date(org.createdAt).toLocaleDateString(undefined, {
            day: "numeric",
            month: "short",
            year: "numeric",
          })}
        />
      </section>

      <section className="space-y-2 rounded-xl border bg-card p-4">
        <h2 className="text-sm font-medium">{t("org:rules")}</h2>
        <div className="flex items-center gap-2 py-1.5">
          <span className="flex-1 text-sm">{t("org:defaultRole")}</span>
          <select
            aria-label={t("org:defaultRoleAria")}
            disabled={!canManage}
            value={org.defaultInviteRole ?? "member"}
            onChange={(e) => guardar({ defaultInviteRole: e.target.value as OrgRole })}
            className="h-7 rounded border bg-background px-2 text-xs"
          >
            <option value="admin">admin</option>
            <option value="member">member</option>
            <option value="viewer">viewer</option>
          </select>
        </div>
        <Interruptor
          on={org.clientsSeeOnlyTheirSpace}
          onChange={() => guardar({ clientsSeeOnlyTheirSpace: !org.clientsSeeOnlyTheirSpace })}
          label={t("org:clientsOwnSpace")}
        />
        <Interruptor
          on={org.guestsCanUseDevTools}
          onChange={() => guardar({ guestsCanUseDevTools: !org.guestsCanUseDevTools })}
          label={t("org:guestsDevTools")}
        />
        {/* Shown off and disabled rather than hidden: it is on the roadmap, and
            a control that is missing reads as "not possible" while one that is
            greyed reads as "not yet". */}
        <Interruptor on={false} onChange={() => {}} disabled label="Require 2FA for admins" />
      </section>

      <section className="space-y-3 rounded-xl border border-destructive/40 bg-card p-4">
        <h2 className="text-sm font-medium text-destructive">{t("org:dangerZone")}</h2>
        <p className="text-xs text-muted-foreground">
          {t("org:dangerBody")}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled title={t("org:notAvailableYet")}>
            {t("org:transfer")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="border-destructive/60 text-destructive hover:bg-destructive/10"
            disabled={!superadmin}
            // Only a platform superadmin, and the server refuses it to anybody
            // else regardless. Disabled rather than hidden so an org admin can
            // see that the door exists and who to ask.
            title={superadmin ? undefined : t("org:onlySuperadminDeletes")}
            onClick={() => setBorrar(true)}
          >
            {t("org:deleteOrg")}
          </Button>
        </div>
      </section>

      <DeleteOrgDialog
        open={borrar}
        onOpenChange={setBorrar}
        orgName={org.name}
        onConfirm={async () => {
          await deleteOrg(org.id);
          toast.success(t("common:last.orgDeleted", { name: org.name }));
          navigate("/my-work");
        }}
      />
    </div>
  );
}

function Campo({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("text-sm", mono && "font-mono text-xs text-muted-foreground")}>{value}</p>
    </div>
  );
}
