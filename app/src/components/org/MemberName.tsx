import Initials from "@/components/ui/initials";
import { useT } from "@/lib/i18n";
import { inicialesDe, nombreDe } from "@/lib/nombres";
import type { OrgMember } from "@/types/organization";

/**
 * Quién es un miembro, en la tabla de la organización.
 *
 * Quien se dio de alta por correo y no terminó el registro tiene un usuario
 * provisional (`pending-…`) que no eligió nadie: se enseña su nombre y la
 * marca de pendiente, nunca ese usuario.
 */
export default function MemberName({ member: m }: { member: OrgMember }) {
  const { t } = useT();
  if (m.setupPending) {
    const shown = m.name || m.email || "";
    return (
      <span className="flex items-center gap-2">
        <Initials colorKey={m.userId} text={shown.slice(0, 2)} className="size-6 text-[10px]" />
        <span className="min-w-0">
          <span className="block truncate">{shown}</span>
          <span
            className="mt-0.5 inline-block rounded bg-warning/15 px-1.5 text-[10px] font-medium text-warning"
            title={t("common:account.pendingHint")}
          >
            {t("common:account.pending")}
          </span>
        </span>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2">
      <Initials colorKey={m.username} text={inicialesDe(m)} className="size-6 text-[10px]" />
      <span className="min-w-0">
        <span className="block truncate">{nombreDe(m)}</span>
        <span className="block truncate font-mono text-[11px] text-muted-foreground">@{m.username}</span>
      </span>
    </span>
  );
}
