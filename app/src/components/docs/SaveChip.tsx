import { AlertCircle, Check, Loader2 } from "lucide-react";

import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { EstadoDeGuardado } from "@/hooks/use-autoguardado";

/**
 * En qué estado está lo que se está escribiendo.
 *
 * `aria-live="polite"` y no `assertive`: un lector de pantalla tiene que poder
 * anunciar «guardado» sin cortar a quien está dictando una frase. El estado
 * quieto no pinta nada — un chip permanente que dice «guardado» deja de leerse a
 * los dos minutos, y entonces tampoco se lee cuando dice «error».
 */
export default function SaveChip({ estado }: { estado: EstadoDeGuardado }) {
  const { t } = useT();
  if (estado === "quieto") return null;
  return (
    <span
      aria-live="polite"
      className={cn(
        "flex items-center gap-1 text-xs",
        estado === "error" ? "text-destructive" : "text-muted-foreground",
        estado === "guardando" && "text-amber-500",
      )}
    >
      {estado === "guardando" && <Loader2 className="size-3 animate-spin" />}
      {estado === "guardado" && <Check className="size-3" />}
      {estado === "error" && <AlertCircle className="size-3" />}
      {t(`work:docs.save_${estado}` as never)}
    </span>
  );
}
