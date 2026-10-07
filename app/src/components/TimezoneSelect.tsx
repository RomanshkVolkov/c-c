import { useMemo } from "react";
import { useT } from "@/lib/i18n";
import { allZones, myZone, zoneLabel } from "@/lib/timezones";
import Picker from "@/components/ui/picker";

/**
 * Elegir una zona por su ciudad y su desfase de hoy («Cancun (UTC−5)»), no
 * escribiendo «America/Cancun» a mano.
 *
 * Arriba, las que casi siempre se quieren: la del equipo y la de quien mira.
 */
export default function TimezoneSelect({
  value,
  onChange,
  teamZone,
  allowEmpty,
  disabled,
  id,
  ariaLabel,
  className,
}: {
  value: string;
  onChange: (zone: string) => void;
  /** La zona del equipo, si la org tiene. */
  teamZone?: string;
  /** Con «sin decidir» como primera opción (la de la org). */
  allowEmpty?: boolean;
  disabled?: boolean;
  id?: string;
  ariaLabel?: string;
  className?: string;
}) {
  const { t } = useT();
  const zones = useMemo(() => allZones(), []);
  const mine = myZone();
  const suggested = [...new Set([teamZone, mine].filter((z): z is string => !!z))];
  // Una zona guardada que esta plataforma no lista sigue apareciendo: si no,
  // el desplegable enseñaría otra y guardar la cambiaría sin querer.
  const extra = value && !zones.includes(value) && !suggested.includes(value) ? [value] : [];

  return (
    <Picker
      id={id}
      aria-label={ariaLabel}
      disabled={disabled}
      value={value}
      onChange={onChange}
      options={allowEmpty ? [{ value: "", label: t("org:zoneUnset") }] : []}
      groups={[
        {
          label: t("org:zoneSuggested"),
          options: [
            ...suggested.map((z) => ({
              value: z,
              label: `${zoneLabel(z)}${z === teamZone ? ` · ${t("org:zoneTeam")}` : ""}${z === mine ? ` · ${t("org:zoneYours")}` : ""}`,
            })),
            ...extra.map((z) => ({ value: z, label: z })),
          ],
        },
        {
          label: t("org:zoneAll"),
          options: zones.filter((z) => !suggested.includes(z)).map((z) => ({ value: z, label: zoneLabel(z) })),
        },
      ]}
      className={className ?? "text-xs"}
    />
  );
}
