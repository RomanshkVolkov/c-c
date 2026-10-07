import type { SpaceTree } from "@/types/task";

/**
 * Las listas del árbol, dichas por su ruta.
 *
 * Una bandeja se guarda como un uuid, y un uuid no le dice nada a nadie: en dos
 * sitios distintos —la ficha de una integración y el diálogo de un canal— hacía
 * falta traducirlo a «Boaty · web · Tasks». Aquí porque el recorrido es el
 * mismo, y porque una lista puede colgar del espacio o de una carpeta y
 * olvidarse de la segunda rama es fácil.
 *
 * La ruta lleva el espacio a propósito: dos clientes con una lista «Bugs» son
 * indistinguibles sin él, y elegir la del cliente equivocado es enseñarle su
 * trabajo a otro.
 */
export interface ListaConRuta {
  id: string;
  ruta: string;
}

/**
 * @param orgId Si se pasa, sólo las listas de esa organización.
 *
 * No es un filtro de comodidad: ofrecer como bandeja la lista de otra
 * organización es enseñarle el trabajo de un cliente a gente que no tiene nada
 * que ver con él. El servidor lo rechaza —`inbox-other-org`— pero llegar a que
 * lo rechace ya es un fallo de la pantalla, que ofreció algo imposible.
 */
export function listasDelArbol(tree: SpaceTree[], orgId?: string): ListaConRuta[] {
  const out: ListaConRuta[] = [];
  for (const sp of tree) {
    if (orgId && sp.orgId !== orgId) continue;
    for (const l of sp.lists ?? []) out.push({ id: l.id, ruta: `${sp.name} · ${l.name}` });
    for (const f of sp.folders ?? []) {
      for (const l of f.lists ?? []) {
        out.push({ id: l.id, ruta: `${sp.name} · ${f.name} · ${l.name}` });
      }
    }
  }
  return out;
}

/**
 * La ruta de una lista, o `null` si no está en este árbol.
 *
 * `null` no es «no hay bandeja»: es «hay una y no es de aquí» —de otra
 * organización, o borrada—. Quien llame decide cómo lo cuenta; lo que no debe
 * hacer es pintar el uuid.
 */
export function rutaDeLista(tree: SpaceTree[], listId: string | undefined): string | null {
  if (!listId) return null;
  return listasDelArbol(tree).find((l) => l.id === listId)?.ruta ?? null;
}

/**
 * Las listas agrupadas por espacio, para un desplegable: el espacio es la
 * cabecera y cada opción dice sólo «carpeta · lista». La ruta entera en cada
 * opción era lo que hacía el menú más ancho que la ventana (7-oct-2026).
 */
export function groupListsBySpace(lists: ListaConRuta[]): { label: string; options: { value: string; label: string }[] }[] {
  const groups = new Map<string, { value: string; label: string }[]>();
  for (const l of lists) {
    const cut = l.ruta.indexOf(" · ");
    const space = cut < 0 ? l.ruta : l.ruta.slice(0, cut);
    const rest = cut < 0 ? l.ruta : l.ruta.slice(cut + 3);
    if (!groups.has(space)) groups.set(space, []);
    groups.get(space)!.push({ value: l.id, label: rest });
  }
  return [...groups].map(([label, options]) => ({ label, options }));
}

