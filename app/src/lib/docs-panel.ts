import { childrenOf } from "@/store/doc-pages.store";
import { repoDocPath, repoFileKey } from "@/lib/repo-tree";
import type { RepoDocsGroup } from "@/types/github";
import { docKey, type DocOwnerKind, type DocPageTreeItem, type FolderTree, type SpaceTree } from "@/types/task";

/**
 * Las cuentas del árbol del panel de Documentación, sin React.
 *
 * El árbol mezcla dos clases de nodo: los del trabajo (espacio → carpeta →
 * lista), cada uno con su documento, y las páginas que cuelgan de cada
 * documento. Se distinguen por la clave: un nodo es `docKey(kind, id)`
 * («list:abc») y una página es `pageKey(id)` («page:xyz»), así que caben en el
 * mismo mapa de desplegado (`layout.store.expanded`) sin chocar.
 */
export const pageKey = (id: string) => `page:${id}`;

/** Un nodo del trabajo con lo que cuelga de él, en el orden del árbol. */
export interface DocNode {
  kind: DocOwnerKind;
  id: string;
  name: string;
  /** Sólo los espacios: su color, como en el árbol de Trabajo. */
  color?: string;
  children: DocNode[];
}

/**
 * Los espacios de trabajo como nodos de documento. La sala general no: es un
 * canal, no un trabajo con documentación (como en `SpacesNavigator`).
 */
export function docNodes(tree: SpaceTree[]): DocNode[] {
  const folder = (f: FolderTree): DocNode => ({
    kind: "folder",
    id: f.id,
    name: f.name,
    children: [...f.folders.map(folder), ...f.lists.map(list)],
  });
  const list = (l: { id: string; name: string }): DocNode => ({ kind: "list", id: l.id, name: l.name, children: [] });
  return tree
    .filter((s) => s.kind !== "general")
    .map((s) => ({
      kind: "space",
      id: s.id,
      name: s.name,
      color: s.color,
      children: [...s.folders.map(folder), ...s.lists.map(list)],
    }));
}

/** Las claves desde el espacio hasta el nodo, el nodo incluido; vacío si no está. */
function nodePath(nodes: DocNode[], target: { kind: DocOwnerKind; id: string }): string[] {
  for (const n of nodes) {
    if (n.kind === target.kind && n.id === target.id) return [docKey(n.kind, n.id)];
    const below = nodePath(n.children, target);
    if (below.length > 0) return [docKey(n.kind, n.id), ...below];
  }
  return [];
}

/**
 * Lo que va desplegado sin que nadie lo pida: el camino hasta el documento
 * abierto, el propio documento (para ver sus páginas) y las páginas por
 * encima de la abierta (`breadcrumb`), para que una página honda abierta por
 * un enlace se vea donde está. Nada más: las hermanas y las hijas nacen
 * plegadas. Un árbol con todo abierto es una lista de doscientas filas.
 */
export function defaultExpanded(
  tree: SpaceTree[],
  activeDoc: { kind: DocOwnerKind; id: string } | null | undefined,
  breadcrumb: { id: string }[] = [],
): Set<string> {
  const open = new Set<string>();
  if (!activeDoc) return open;
  for (const k of nodePath(docNodes(tree), activeDoc)) open.add(k);
  for (const b of breadcrumb) open.add(pageKey(b.id));
  return open;
}

/**
 * Lo que deja el filtro: las claves de los nodos y las páginas cuyo título
 * casa, **más todos sus antepasados**, para que lo encontrado tenga dónde
 * pintarse. `null` sin texto (no se filtra). Sólo mira las páginas ya
 * cargadas (`pagesByOwner`): filtrar no dispara peticiones por cada documento.
 */
export function filterDocsTree(
  tree: SpaceTree[],
  query: string,
  pagesByOwner: Record<string, DocPageTreeItem[]>,
  repoBySpace: Record<string, RepoDocsGroup[]> = {},
): Set<string> | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const keep = new Set<string>();
  const hit = (s: string) => s.toLowerCase().includes(q);

  // Las páginas de un documento que casan, con sus madres. Dice si alguna casó.
  const pages = (owner: string): boolean => {
    const all = pagesByOwner[owner] ?? [];
    let any = false;
    const walk = (parentId: string | null, chain: string[]) => {
      for (const p of childrenOf(all, parentId)) {
        const here = [...chain, pageKey(p.id)];
        if (hit(p.title)) {
          any = true;
          for (const k of here) keep.add(k);
        }
        walk(p.id, here);
      }
    };
    walk(null, []);
    return any;
  };

  // Un nodo se queda si casa él, alguna de sus páginas o algo de debajo. Los
  // antepasados no se apuntan aparte: cada uno se queda por lo mismo, porque
  // lo que casa abajo sube como `true` por la recursión.
  // Los .md de los repos del espacio ya pedidos: casan por título o por
  // ruta, y arrastran su repo y sus carpetas.
  const repoFiles = (spaceId: string): boolean => {
    let any = false;
    for (const g of repoBySpace[spaceId] ?? []) {
      for (const f of g.files) {
        if (!hit(f.title) && !hit(f.path)) continue;
        any = true;
        keep.add(repoFileKey(f.id));
        for (const k of repoDocPath({ repoId: g.repoId, path: f.path })) keep.add(k);
      }
    }
    return any;
  };

  const visit = (n: DocNode): boolean => {
    const key = docKey(n.kind, n.id);
    let any = hit(n.name);
    if (pages(key)) any = true;
    if (n.kind === "space" && repoFiles(n.id)) any = true;
    for (const c of n.children) if (visit(c)) any = true;
    if (any) keep.add(key);
    return any;
  };
  for (const n of docNodes(tree)) visit(n);
  return keep;
}
