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

export function listasDelArbol(tree: SpaceTree[]): ListaConRuta[] {
  const out: ListaConRuta[] = [];
  for (const sp of tree) {
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
