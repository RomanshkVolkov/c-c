import type { RepoDoc, RepoDocEntry } from "@/types/github";

/**
 * Los .md de un repo como árbol de carpetas, sin React.
 *
 * El backend los da planos, por ruta (`docs/deploy/k8s.md`); las carpetas
 * salen de los segmentos. Dos reglas que copian lo que hace cualquier
 * explorador de código:
 * - **en cada carpeta, primero las carpetas y luego los ficheros**, y entre los
 *   ficheros el `README` primero: es la portada de esa carpeta;
 * - **una carpeta que sólo tiene otra carpeta se aplana** (`docs/guias`), como
 *   en VS Code: si no, un `docs/` con todo dentro de `guias/` es un nivel que
 *   hay que abrir para nada.
 *
 * Claves para el mapa de desplegado (`layout.store.expanded`), sin chocar con
 * las de los nodos y las páginas: `repo:<repoId>` para el repo,
 * `repodir:<repoId>:<ruta>` para una carpeta y `repofile:<id>` para un fichero.
 */
export const repoKey = (repoId: number) => `repo:${repoId}`;
export const repoDirKey = (repoId: number, dir: string) => `repodir:${repoId}:${dir}`;
export const repoFileKey = (id: string) => `repofile:${id}`;

export interface RepoDir {
  /** Lo que se pinta: un segmento, o varios si se aplanó (`docs/guias`). */
  name: string;
  /** La ruta entera desde la raíz del repo; vacía en la raíz. */
  path: string;
  dirs: RepoDir[];
  files: RepoDocEntry[];
}

const isReadme = (f: RepoDocEntry) => /^readme\.(md|markdown)$/i.test(f.path.split("/").pop() ?? "");

export function buildRepoTree(files: RepoDocEntry[]): RepoDir {
  const root: RepoDir = { name: "", path: "", dirs: [], files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let here = root;
    for (const seg of parts.slice(0, -1)) {
      const path = here.path ? `${here.path}/${seg}` : seg;
      let next = here.dirs.find((d) => d.path === path);
      if (!next) {
        next = { name: seg, path, dirs: [], files: [] };
        here.dirs.push(next);
      }
      here = next;
    }
    here.files.push(f);
  }
  const tidy = (d: RepoDir): RepoDir => {
    let out = d;
    // La raíz no se aplana: es el repo, y su nombre ya lo lleva la fila.
    while (out.path && out.files.length === 0 && out.dirs.length === 1) {
      const only = out.dirs[0];
      out = { ...only, name: `${out.name}/${only.name}` };
    }
    return {
      ...out,
      dirs: out.dirs.map(tidy).sort((a, b) => a.name.localeCompare(b.name)),
      files: [...out.files].sort(
        (a, b) => Number(isReadme(b)) - Number(isReadme(a)) || a.title.localeCompare(b.title),
      ),
    };
  };
  return tidy(root);
}

/**
 * Lo que va abierto para que se vea el fichero que lees: su repo y todas las
 * carpetas por encima. Todos los prefijos de su ruta, también los que el
 * aplanado se comió: una clave de más no abre nada que no exista.
 */
export function repoDocPath(doc: Pick<RepoDoc, "repoId" | "path">): string[] {
  const parts = doc.path.split("/").slice(0, -1);
  return [repoKey(doc.repoId), ...parts.map((_, i) => repoDirKey(doc.repoId, parts.slice(0, i + 1).join("/")))];
}
