import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

import { useCommsUnread } from "@/hooks/use-comms-unread";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useLayoutStore, type CommsPath } from "@/store/layout.store";

/**
 * «Canales | Directos», arriba de la lista en el teléfono: las dos mitades de
 * «Comunicación», cada una con sus sin leer. Va en la cabecera de las dos
 * listas en vez del título, y apunta en cuál estás para que el botón del menú
 * inferior vuelva ahí.
 *
 * Un selector y no una lista mezclada: con canales de clientes y directos
 * juntos se pierde de un vistazo qué es de quién.
 */
export default function CommsSwitch({ current }: { current: CommsPath }) {
  const { t } = useT();
  const navigate = useNavigate();
  const setComms = useLayoutStore((s) => s.setComms);
  const { channels, dms } = useCommsUnread();

  useEffect(() => setComms(current), [current, setComms]);

  const opcion = (path: CommsPath, texto: string, n: number) => (
    <button
      type="button"
      role="tab"
      aria-selected={current === path}
      onClick={() => current !== path && navigate(path)}
      className={cn(
        "flex flex-1 items-center justify-center gap-1.5 rounded-md py-1 text-sm",
        current === path ? "bg-background font-medium shadow-sm" : "text-muted-foreground",
      )}
    >
      {texto}
      {n > 0 && (
        <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] text-primary-foreground">
          {n > 99 ? "99+" : n}
        </span>
      )}
    </button>
  );

  return (
    <div role="tablist" aria-label={t("nav:mobile.comms")} className="flex flex-1 gap-1 rounded-lg bg-muted p-0.5">
      {opcion("/chat", t("nav:mobile.channels"), channels)}
      {opcion("/dm", t("nav:mobile.directs"), dms)}
    </div>
  );
}
