import { activo, desde } from "@/lib/desde";
import { cn } from "@/lib/utils";

/**
 * Si esta persona anda por aquí.
 *
 * Un sitio y una regla: la ventana la decide `activo()` y el texto exacto vive
 * en el `title`, para que el punto se lea de un vistazo y el detalle esté a un
 * hover de distancia.
 *
 * **Nunca dice «online».** La marca se escribe como mucho cada cinco minutos,
 * así que puede venir con ese retraso; prometer tiempo real sería prometer una
 * precisión que el dato no tiene. Lo que sí sostiene es «activo hace 3 min», y
 * eso es justo lo que dice.
 */
export default function PresenceDot({
  lastSeenAt,
  className,
}: {
  lastSeenAt?: string | null;
  className?: string;
}) {
  const aqui = activo(lastSeenAt);
  return (
    <span
      aria-label={aqui ? "active recently" : "not active recently"}
      title={lastSeenAt ? `active ${desde(lastSeenAt)}` : "no recent activity"}
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        aqui ? "bg-success" : "bg-muted-foreground/30",
        className,
      )}
    />
  );
}
