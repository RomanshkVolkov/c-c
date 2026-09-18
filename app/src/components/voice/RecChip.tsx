import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * El punto rojo de «se está grabando».
 *
 * Tres decisiones, y las tres tienen prueba:
 *
 *   - **No es sólo color.** Dice «REC» y el nombre de quien graba. Un punto
 *     rojo a secas deja fuera a quien no lo distingue, y encima un rojo puede
 *     leerse igual como «activo» que como «error».
 *   - **`role="status"`.** Un lector de pantalla tiene que anunciarlo cuando
 *     aparece, no cuando alguien vaya a buscarlo con el tabulador.
 *   - **El parpadeo se apaga** con `prefers-reduced-motion`. Algo que late en
 *     una esquina durante una reunión de una hora no es un detalle para quien
 *     le afecta.
 */
export default function RecChip({
  by,
  className,
}: {
  /** Cómo se llama quien graba. Vacío mientras no se sepa. */
  by?: string;
  className?: string;
}) {
  const { t } = useT();

  return (
    <span
      role="status"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full bg-destructive/15 px-2 py-0.5",
        "text-xs font-semibold text-destructive",
        className,
      )}
    >
      <span
        aria-hidden
        className="size-1.5 rounded-full bg-destructive motion-safe:animate-pulse"
      />
      {by ? t("recordings:chip", { name: by }) : t("recordings:chipUnknown")}
    </span>
  );
}
