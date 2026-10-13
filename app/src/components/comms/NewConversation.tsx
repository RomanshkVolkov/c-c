import { useState } from "react";
import { Loader2, Search } from "lucide-react";
import { toast } from "sonner";

import PresenceDot from "@/components/PresenceDot";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useT } from "@/lib/i18n";
import { nombreDe } from "@/lib/nombres";
import { useAuthStore } from "@/store/auth.store";
import { useDMStore } from "@/store/dm.store";
import { useOrgsStore } from "@/store/orgs.store";
import { usePeopleStore } from "@/store/people.store";

/**
 * Escribirle a alguien de la org: un buscador y la gente.
 *
 * Toda la gente, también con quien ya hay hilo: «escribirle a Ana» es la misma
 * intención exista o no la conversación, y el servidor trata abrir como
 * idempotente justo por eso —nombrar a alguien dos veces nunca hace un segundo
 * hilo—. Separarlos obligaba a saber de antemano en cuál de las dos listas
 * buscar.
 *
 * Sólo la gente de la organización en pantalla, y eso lo impone también el
 * servidor: la búsqueda rechaza una org de la que no eres, y abrir vuelve a
 * comprobar que la compartís.
 */
export default function NewConversation({
  open,
  onOpenChange,
  onPicked,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPicked: () => void;
}) {
  const { t } = useT();
  const orgId = useOrgsStore((s) => s.currentOrgId);
  // `byOrg[orgId]` y el `?? []` fuera: un selector tiene que devolver la misma
  // referencia si nada cambió, y un array derivado nunca lo hace. Con
  // `current()` como selector la pantalla entraba en bucle (React #185).
  const people = usePeopleStore((s) => (orgId ? s.byOrg[orgId] : undefined)) ?? [];
  const openWith = useDMStore((s) => s.openWith);
  // Uno mismo fuera: el servidor rechaza una conversación contigo, así que
  // ofrecerla sería proponer algo que la app va a negar.
  const me = useAuthStore((s) => s.session?.id);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);

  const term = query.trim().toLowerCase();
  const shown = people.filter(
    (p) =>
      p.id !== me &&
      (!term || p.username.toLowerCase().includes(term) || nombreDe(p).toLowerCase().includes(term)),
  );

  const start = async (userId: string) => {
    if (!orgId || busy) return;
    setBusy(true);
    try {
      await openWith(orgId, userId);
      onOpenChange(false);
      setQuery("");
      onPicked();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("nav:comms.newConversation")}</DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-1.5 rounded-md border bg-background px-2">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            type="search"
            className="h-8 w-full bg-transparent text-sm outline-none"
            placeholder={t("common:last.findSomebody")}
            aria-label={t("common:last.findSomebody")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          {busy && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
        </div>
        {shown.length === 0 ? (
          <p className="px-2 py-1 text-xs text-muted-foreground">{t("common:misc.nobodyElse")}</p>
        ) : (
          <ul className="-mx-1 max-h-72 space-y-0.5 overflow-y-auto">
            {shown.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                  onClick={() => void start(p.id)}
                >
                  <PresenceDot lastSeenAt={p.lastSeenAt} />
                  <span className="truncate">{nombreDe(p)}</span>
                  {p.name && p.name.trim() && (
                    <span className="truncate text-xs text-muted-foreground">@{p.username}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
