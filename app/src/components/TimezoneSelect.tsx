import { useMemo } from "react";
import { useT } from "@/lib/i18n";
import { allZones, myZone, zoneLabel } from "@/lib/timezones";

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
    <select
      id={id}
      aria-label={ariaLabel}
      disabled={disabled}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={className ?? "h-8 rounded-md border bg-background px-2 text-xs"}
    >
      {allowEmpty && <option value="">{t("org:zoneUnset")}</option>}
      <optgroup label={t("org:zoneSuggested")}>
        {suggested.map((z) => (
          <option key={`s:${z}`} value={z}>
            {zoneLabel(z)}
            {z === teamZone ? ` · ${t("org:zoneTeam")}` : ""}
            {z === mine ? ` · ${t("org:zoneYours")}` : ""}
          </option>
        ))}
        {extra.map((z) => (
          <option key={`x:${z}`} value={z}>
            {z}
          </option>
        ))}
      </optgroup>
      <optgroup label={t("org:zoneAll")}>
        {zones
          .filter((z) => !suggested.includes(z))
          .map((z) => (
            <option key={z} value={z}>
              {zoneLabel(z)}
            </option>
          ))}
      </optgroup>
    </select>
  );
}
