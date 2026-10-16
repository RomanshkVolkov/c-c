import { Check, CheckCheck } from "lucide-react";

import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Las palomitas de un mensaje tuyo en un directo, como en WhatsApp: una,
 * enviado; dos en color, leído. Leído es haberse escrito antes de la marca de
 * lectura del otro (`otherReadAt`).
 */
export default function ReadTicks({ read, className }: { read: boolean; className?: string }) {
  const { t } = useT();
  const label = read ? t("chat:readByOther") : t("chat:sentNotRead");
  const Icon = read ? CheckCheck : Check;
  return (
    <Icon
      role="img"
      aria-label={label}
      className={cn("inline size-3.5 shrink-0", read ? "text-primary" : "text-muted-foreground", className)}
    >
      <title>{label}</title>
    </Icon>
  );
}

/** Si un mensaje escrito a `at` ya lo leyó quien lo leyó hasta `readUpTo`. */
export function wasRead(at: string | null | undefined, readUpTo: string | null | undefined): boolean {
  if (!at || !readUpTo) return false;
  return new Date(at).getTime() <= new Date(readUpTo).getTime();
}
