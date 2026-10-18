import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * La flecha de algo que se despliega: gira con muelle al abrirse, en vez de
 * cambiar de icono de golpe. Es la misma flecha siempre; abierta, apunta
 * hacia abajo.
 */
export default function DisclosureChevron({ open, className }: { open: boolean; className?: string }) {
  return (
    <ChevronRight
      aria-hidden
      data-open={open}
      className={cn(
        "transition-[rotate] duration-(--dur-spring) ease-(--ease-spring)",
        open && "rotate-90",
        className,
      )}
    />
  );
}
