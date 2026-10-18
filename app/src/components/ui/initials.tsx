import { personTint } from "@/lib/person-color";
import { cn } from "@/lib/utils";

/**
 * Las iniciales de alguien, en su color (`personTint`).
 *
 * `colorKey` decide el color y tiene que ser lo mismo en todas partes para la
 * misma persona: el `username`, que es lo que traen las tarjetas, los
 * miembros y la sesión. Las tarjetas de «Mi trabajo» sólo traen el nombre, y
 * ahí se usa ese.
 */
export default function Initials({
  colorKey,
  text,
  title,
  className,
}: {
  colorKey: string;
  text: string;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-semibold uppercase",
        personTint(colorKey),
        className,
      )}
    >
      {text}
    </span>
  );
}
