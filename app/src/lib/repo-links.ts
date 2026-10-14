/**
 * Los enlaces y las imágenes de un .md del repo, leído en cac (docs as code).
 *
 * Un README enlaza a sus vecinos con rutas relativas (`../deploy.md`,
 * `./img/arq.png`), que en GitHub resuelve la página. Aquí no hay página del
 * repo: o se resuelven contra la ruta del fichero, o un enlace a otro .md
 * acabaría abriendo el navegador en una dirección que no existe.
 */

/** Lo que es de fuera: con esquema (`https:`, `mailto:`) o `//host`. */
const isAbsolute = (href: string) => /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");

/**
 * Una ruta relativa resuelta contra el fichero que la escribe. Una que
 * empieza por `/` es desde la raíz del repo, como en GitHub. `null` si se sale
 * del repo.
 */
export function resolveRepoPath(fromPath: string, rel: string): string | null {
  const base = rel.startsWith("/") ? [] : fromPath.split("/").slice(0, -1);
  const out = [...base];
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join("/");
}

export type RepoHref =
  | { kind: "anchor"; hash: string }
  | { kind: "repoDoc"; id: string; hash: string }
  | { kind: "external"; url: string };

/**
 * A dónde lleva un enlace de un .md del repo.
 * - `#ancla`: dentro del mismo fichero.
 * - Un .md relativo que está en la copia: ese fichero, en cac.
 * - Cualquier otra ruta relativa: su página en GitHub (un fichero de código,
 *   una carpeta, un .md que no se copió).
 * - Lo absoluto, tal cual.
 */
export function resolveRepoHref(
  doc: { path: string; fullName: string; branch: string },
  href: string,
  idByPath: Record<string, string>,
): RepoHref {
  if (href.startsWith("#")) return { kind: "anchor", hash: href.slice(1) };
  if (isAbsolute(href)) return { kind: "external", url: href };
  const [beforeHash, hash = ""] = href.split("#");
  const rel = beforeHash.split("?")[0];
  const path = resolveRepoPath(doc.path, decodeURIComponent(rel));
  if (path === null) return { kind: "external", url: `https://github.com/${doc.fullName}` };
  const id = idByPath[path];
  if (id) return { kind: "repoDoc", id, hash };
  return {
    kind: "external",
    url: `https://github.com/${doc.fullName}/blob/${doc.branch}/${path}${hash ? `#${hash}` : ""}`,
  };
}

/**
 * La imagen de un .md del repo. Una relativa se pide a cac, que la baja del
 * repo con el token de la App (`/api/v1/repo-docs/raw/…`): en un repo privado
 * GitHub no se la daría a un `<img>`. Lo absoluto —una insignia de
 * shields.io— no se toca.
 */
export function repoImageSrc(doc: { path: string; repoId: number }, src: string): string | null {
  if (isAbsolute(src)) return src;
  const path = resolveRepoPath(doc.path, decodeURIComponent(src.split(/[?#]/)[0]));
  if (!path) return null;
  return `/api/v1/repo-docs/raw/${doc.repoId}?path=${encodeURIComponent(path)}`;
}

/**
 * Si una URL es la de un .md en GitHub (`github.com/<owner>/<repo>/blob/<rama>/<ruta>.md`),
 * su repo y su ruta. La rama es el primer segmento después de `blob`: una
 * rama con barras se lee mal, y entonces cac no lo encuentra y el enlace sigue
 * siendo un enlace a GitHub, que es lo que era.
 */
export function matchRepoBlobUrl(href: string): { repo: string; path: string } | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.hostname.toLowerCase() !== "github.com") return null;
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts.length < 5 || parts[2] !== "blob") return null;
  const path = parts.slice(4).map(decodeURIComponent).join("/");
  if (!/\.(md|markdown)$/i.test(path)) return null;
  return { repo: `${parts[0]}/${parts[1]}`, path };
}
