import type { SpaceTree } from "@/types/task";

/**
 * Qué canal está en pantalla en `/chat`: el pedido (`?space=`), si no el
 * último en el que estuviste en esta org (`places.store`), si no la sala
 * general, y si no el primero.
 *
 * Es **una** función porque la contestan dos sitios: la página, que pinta ese
 * canal, y el panel de Comunicación, que marca su fila. Si cada uno lo
 * resolviera a su manera, la fila marcada podría no ser la conversación que
 * tienes delante. Un id que ya no está en el árbol —un canal borrado, un
 * enlace viejo— cae al siguiente en vez de dejar la pantalla vacía.
 */
export function resolveSpace(
  tree: SpaceTree[],
  requested: string | null | undefined,
  remembered: string | null | undefined,
): SpaceTree | undefined {
  return (
    (requested ? tree.find((s) => s.id === requested) : undefined) ??
    (remembered ? tree.find((s) => s.id === remembered) : undefined) ??
    tree.find((s) => s.kind === "general") ??
    tree[0]
  );
}

/**
 * Los canales en el orden en que se enseñan: la sala general la primera —es
 * de todos, y es donde cae quien no eligió nada— y luego los de cada espacio.
 */
export function orderedChannels(tree: SpaceTree[]): { general?: SpaceTree; rest: SpaceTree[] } {
  return { general: tree.find((s) => s.kind === "general"), rest: tree.filter((s) => s.kind !== "general") };
}
