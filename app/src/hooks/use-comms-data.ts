import { useEffect } from "react";

import { useDMStore } from "@/store/dm.store";
import { useOrgsStore } from "@/store/orgs.store";
import { usePeopleStore } from "@/store/people.store";
import { watchOccupancy } from "@/store/voice-occupancy";

/**
 * Lo que necesita la lista de Comunicación mientras está en pantalla: las
 * conversaciones, la gente de la org (para «Nueva conversación») y quién anda
 * por la voz de cada canal.
 *
 * Una vez por org: depende de `orgId`, no sólo de las acciones de zustand, que
 * nunca cambian de identidad. Con sólo ellas, cambiar de organización no volvía
 * a pedir nada y la única forma de ver a los colegas de la nueva era recargar
 * la app («click derecho y reload», el reporte que lo destapó en `DMSwitcher`).
 *
 * El hilo abierto **no** se cierra aquí al cambiar de org: eso lo hace
 * `store/org-switch.ts`, que ve todos los cambios y no sólo los que pasan con
 * esta lista montada.
 *
 * Lo no leído de los canales no va aquí: lo pide `useNavData` para todo el
 * sidebar, porque el contador del riel se ve desde cualquier módulo.
 */
export function useCommsData() {
  const orgId = useOrgsStore((s) => s.currentOrgId);
  const fetchConversations = useDMStore((s) => s.fetchConversations);
  const fetchPeople = usePeopleStore((s) => s.fetchPeople);

  useEffect(() => {
    if (!orgId) return;
    fetchConversations().catch(() => {});
    fetchPeople(orgId).catch(() => {});
  }, [orgId, fetchConversations, fetchPeople]);

  useEffect(() => watchOccupancy(orgId), [orgId]);
}
