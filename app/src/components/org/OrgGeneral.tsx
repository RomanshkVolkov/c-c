import { fechaConAno } from "@/lib/fechas";
import { useT } from "@/lib/i18n";
import { useState } from "react";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useOrgsStore } from "@/store/orgs.store";
import { useAuthStore } from "@/store/auth.store";
import DeleteOrgDialog from "@/components/org/DeleteOrgDialog";
import TimezoneSelect from "@/components/TimezoneSelect";
import type { Organization, OrgRole } from "@/types/organization";
import { cn } from "@/lib/utils";
import Picker from "@/components/ui/picker";

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

  const [name, setName] = useState(org.name);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = async (patch: Partial<Organization>) => {
    try {
      await updateOrg(org.id, { name: name.trim() || org.name, ...patch });
    } catch (e) {
      toast.error(t("org:errSave"), { description: String(e) });
    }
  };

  const Toggle = ({
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
          // Apagado con borde: en tema oscuro, `bg-muted` sobre la tarjeta casi
          // no se veía.
          on ? "bg-primary" : "border border-muted-foreground/40 bg-muted",
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
    // Tantas columnas como quepan en el **contenedor**, no según la ventana:
    // con la barra lateral, una ventana «grande» deja un contenido estrecho, y
    // tres columnas fijas aplastaban las reglas a una palabra por línea.
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,20rem),1fr))] gap-4">
      <section className="space-y-3 rounded-xl border bg-card p-4">
        <h2 className="text-sm font-medium">{t("org:identity")}</h2>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">{t("org:name")}</label>
          <Input
            value={name}
            disabled={!canManage}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && name !== org.name && save({})}
          />
        </div>
        {/* The slug is shown and not editable: URLs and integrations are built
            on it, and changing it would break links that already exist
            somewhere nobody here can see. */}
        <Field label={t("org:identifier")} value={org.slug} mono />
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">{t("org:domain")}</label>
          <Input
            defaultValue={org.domain ?? ""}
            disabled={!canManage}
            placeholder="example.com"
            onBlur={(e) => e.target.value !== (org.domain ?? "") && save({ domain: e.target.value })}
          />
        </div>
        <Field
          label={t("org:created")}
          value={fechaConAno(org.createdAt)}
        />
      </section>

      <section className="space-y-2 rounded-xl border bg-card p-4">
        <h2 className="text-sm font-medium">{t("org:rules")}</h2>
        {/* El control baja bajo el texto cuando no cabe al lado. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-1.5">
          <span className="min-w-[10rem] flex-1 text-sm">{t("org:defaultRole")}</span>
          <Picker
            aria-label={t("org:defaultRoleAria")}
            disabled={!canManage}
            value={org.defaultInviteRole ?? "member"}
            onChange={(v) => save({ defaultInviteRole: v as OrgRole })}
            options={["admin", "member", "viewer"].map((r) => ({ value: r, label: r }))}
            size="sm"
            className="text-xs"
          />
        </div>
        {/* La zona del equipo: las reuniones nacen en ella, no en la de quien
            las crea, y cada quien las ve convertidas a su hora. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-1.5">
          <span className="min-w-[10rem] flex-1 text-sm">
            {t("org:teamZone")}
            <span className="block text-xs text-muted-foreground">{t("org:teamZoneHint")}</span>
          </span>
          <TimezoneSelect
            ariaLabel={t("org:teamZone")}
            allowEmpty
            disabled={!canManage}
            value={org.timezone ?? ""}
            teamZone={org.timezone}
            onChange={(zone) => save({ timezone: zone })}
            // Ancho fijo con tope en el de la tarjeta: sin él, el texto de la
            // opción elegida decidía el ancho y empujaba fuera de la tarjeta.
            className="h-8 w-56 max-w-full rounded-md border bg-background px-2 text-xs"
          />
        </div>
        <Toggle
          on={org.clientsSeeOnlyTheirSpace}
          onChange={() => save({ clientsSeeOnlyTheirSpace: !org.clientsSeeOnlyTheirSpace })}
          label={t("org:clientsOwnSpace")}
        />
        <Toggle
          on={org.guestsCanUseDevTools}
          onChange={() => save({ guestsCanUseDevTools: !org.guestsCanUseDevTools })}
          label={t("org:guestsDevTools")}
        />
        <Toggle
          on={org.doneNeedsSubtasksDone}
          onChange={() => save({ doneNeedsSubtasksDone: !org.doneNeedsSubtasksDone })}
          label={t("org:doneNeedsSubtasks")}
        />
        {/* Shown off and disabled rather than hidden: it is on the roadmap, and
            a control that is missing reads as "not possible" while one that is
            greyed reads as "not yet". */}
        <Toggle on={false} onChange={() => {}} disabled label="Require 2FA for admins" />
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
            onClick={() => setConfirmDelete(true)}
          >
            {t("org:deleteOrg")}
          </Button>
        </div>
      </section>

      <DeleteOrgDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
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

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("text-sm", mono && "font-mono text-xs text-muted-foreground")}>{value}</p>
    </div>
  );
}
