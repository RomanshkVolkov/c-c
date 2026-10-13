import type { FolderTree, SpaceTree } from "@/types/task";

/**
 * Dónde cae un nodo en el árbol de espacios, y qué enseñar al filtrarlo.
 *
 * Puro, sin React ni stores: lo usa el panel de Trabajo para decidir qué
 * ramas van abiertas por defecto (la del nodo activo, y nada más) y qué filas
 * sobreviven al filtro por título.
 */

export type TreeNodeKind = "space" | "folder" | "list";

/**
 * Los ids desde el espacio hasta el nodo, ambos incluidos, o vacío si no está.
 *
 * Es lo que un árbol necesita para saber qué abrir: todo lo que está en el
 * camino al nodo activo es una rama que hay que tener desplegada.
 */
export function pathTo(tree: SpaceTree[], target: { kind: TreeNodeKind; id: string }): string[] {
  const inFolders = (folders: FolderTree[], above: string[]): string[] | null => {
    for (const f of folders) {
      const here = [...above, f.id];
      if (target.kind === "folder" && f.id === target.id) return here;
      if (target.kind === "list" && f.lists.some((l) => l.id === target.id)) return [...here, target.id];
      const deeper = inFolders(f.folders ?? [], here);
      if (deeper) return deeper;
    }
    return null;
  };
  for (const space of tree) {
    if (target.kind === "space" && space.id === target.id) return [space.id];
    if (target.kind === "list" && space.lists.some((l) => l.id === target.id)) return [space.id, target.id];
    const found = inFolders(space.folders, [space.id]);
    if (found) return found;
  }
  return [];
}

/**
 * Qué filas enseñar con un filtro puesto: las que casan, sus antecesores (para
 * que se vea de dónde cuelgan) y sus descendientes (buscar un espacio por
 * nombre enseña lo que tiene dentro). `null` sin filtro: todo.
 *
 * Sin distinguir mayúsculas ni acentos a medias: `includes` sobre minúsculas,
 * que es lo que uno espera de un filtro de lista y no un buscador.
 */
export function filterTree(tree: SpaceTree[], query: string): Set<string> | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const visible = new Set<string>();
  const matches = (name: string) => name.toLowerCase().includes(q);

  const allOf = (f: FolderTree): string[] => [
    f.id,
    ...f.lists.map((l) => l.id),
    ...(f.folders ?? []).flatMap(allOf),
  ];

  // Devuelve si algo de la rama casó, para que los antecesores se queden.
  const walkFolder = (f: FolderTree, ancestors: string[]): boolean => {
    let hit = false;
    if (matches(f.name)) {
      for (const id of [...ancestors, ...allOf(f)]) visible.add(id);
      hit = true;
    }
    for (const l of f.lists) {
      if (matches(l.name)) {
        for (const id of [...ancestors, f.id, l.id]) visible.add(id);
        hit = true;
      }
    }
    for (const child of f.folders ?? []) {
      if (walkFolder(child, [...ancestors, f.id])) hit = true;
    }
    return hit;
  };

  for (const space of tree) {
    if (matches(space.name)) {
      visible.add(space.id);
      for (const l of space.lists) visible.add(l.id);
      for (const f of space.folders) for (const id of allOf(f)) visible.add(id);
    }
    for (const l of space.lists) {
      if (matches(l.name)) {
        visible.add(space.id);
        visible.add(l.id);
      }
    }
    for (const f of space.folders) walkFolder(f, [space.id]);
  }
  return visible;
}
