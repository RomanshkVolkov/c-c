import type { FolderTree, ListSummary, SpaceTree } from "@/types/task";

/**
 * Los sitios a los que se puede acotar «Mi trabajo», sacados del árbol: cada
 * espacio entero y cada una de sus listas, también las de dentro de carpetas
 * («Carpeta / Lista»). Para el selector del teléfono, donde no hay árbol en
 * la barra lateral (jose, 18-oct-2026).
 *
 * El valor es `space:<id>` o `list:<id>`; `""` es todo. La sala general no
 * sale: es un canal, no tiene tareas.
 */
export interface ScopeOption {
  value: string;
  label: string;
  kind: "space" | "list";
  id: string;
  /** Lo que se guarda en el ámbito: el nombre como lo dice el árbol. */
  name: string;
}

export interface ScopeGroup {
  label: string;
  options: ScopeOption[];
}

function listsOf(folders: FolderTree[], lists: ListSummary[], prefix: string): ScopeOption[] {
  return [
    ...lists.map((l) => ({ value: `list:${l.id}`, label: prefix + l.name, kind: "list" as const, id: l.id, name: l.name })),
    ...folders.flatMap((f) => listsOf(f.folders ?? [], f.lists, `${prefix}${f.name} / `)),
  ];
}

export function scopeGroups(tree: SpaceTree[], wholeSpace: string): ScopeGroup[] {
  return tree
    .filter((sp) => sp.kind !== "general")
    .map((sp) => ({
      label: sp.name,
      options: [
        { value: `space:${sp.id}`, label: wholeSpace, kind: "space" as const, id: sp.id, name: sp.name },
        ...listsOf(sp.folders, sp.lists, ""),
      ],
    }));
}

/** El valor del selector para un ámbito, y de vuelta. */
export const scopeValue = (scope: { kind: string; id: string } | null) => (scope ? `${scope.kind}:${scope.id}` : "");

export function findScope(groups: ScopeGroup[], value: string): ScopeOption | null {
  for (const g of groups) for (const o of g.options) if (o.value === value) return o;
  return null;
}
