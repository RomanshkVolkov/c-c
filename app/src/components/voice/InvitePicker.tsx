import { nombreDe } from "@/lib/nombres";
import { useT } from "@/lib/i18n";
import { useEffect, useState } from "react";
import { Phone, UserPlus } from "lucide-react";
import { iniciales } from "@/lib/desde";
import { useOrgsStore } from "@/store/orgs.store";
import { usePeopleStore } from "@/store/people.store";
import { useVoice } from "@/store/voice.store";

/**
 * A quién llamar para que se venga.
 *
 * Una lista corta y no un buscador: el equipo cabe en la pantalla, y a quien
 * llamas por voz es casi siempre alguien con quien ya estabas hablando. Un
 * campo de búsqueda aquí es un paso de más para elegir entre cinco nombres.
 *
 * Los que ya están dentro no aparecen. Llamar a quien te está oyendo es un
 * pitido gratis para los dos.
 */
export default function InvitePicker({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  const orgId = useOrgsStore((s) => s.currentOrgId);
  // Se lee `byOrg` y no `current()` porque un selector que devuelve un array
  // nuevo cada vez repinta para siempre — ver el comentario de `NOBODY` en
  // `people.store.ts`. Indexar el mapa devuelve siempre la misma referencia.
  const equipo = usePeopleStore((s) => (orgId ? s.byOrg[orgId] : undefined));
  const fetchPeople = usePeopleStore((s) => s.fetchPeople);
  const dentro = useVoice((s) => s.gente);
  const yo = useVoice((s) => s.yo);
  const timbrar = useVoice((s) => s.timbrar);
  const [pedido, setPedido] = useState<string | null>(null);

  useEffect(() => {
    fetchPeople().catch(() => {});
  }, [fetchPeople]);

  const aqui = new Set([...(yo ? [yo] : []), ...dentro.map((p) => p.identity)]);
  const fuera = (equipo ?? []).filter((p) => !aqui.has(p.id));

  return (
    <div className="absolute right-4 top-14 z-50 w-64 rounded-lg border bg-popover p-1 shadow-lg">
      {fuera.length === 0 ? (
        <p className="px-3 py-4 text-center text-xs text-muted-foreground">
          {t("common:misc.everyoneHere")}
        </p>
      ) : (
        <ul className="max-h-72 overflow-y-auto">
          {fuera.map((p) => (
            <li key={p.id}>
              <button
                onClick={() => {
                  setPedido(p.id);
                  void timbrar(p.id, p.username).finally(onClose);
                }}
                disabled={pedido === p.id}
                className="flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent"
              >
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent text-[10px] font-bold text-accent-foreground">
                  {iniciales(nombreDe(p))}
                </span>
                <span className="min-w-0 flex-1 truncate">{nombreDe(p)}</span>
                <Phone className="size-3.5 shrink-0 text-muted-foreground" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** El botón que lo abre, para que la cabecera no tenga que saber nada más. */
export function InviteButton({ abierto, onToggle }: { abierto: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={abierto}
      title="Call someone into this room"
      className="flex h-8 items-center gap-1.5 rounded-md border bg-card px-2.5 text-[13px] hover:bg-accent"
    >
      <UserPlus className="size-[15px]" /> Invite
    </button>
  );
}
