/**
 * Lo que se deduce de GitHub a partir de una imagen, y dónde vive el PAT.
 *
 * El PAT de GitHub es uno para toda la app, guardado en el llavero con esta
 * clave (el nombre es histórico: se pensó por servidor). Lo usan la pantalla
 * de Secrets y el deploy, para guardar la llave del CI y para listar commits.
 */
export const GITHUB_PAT_KEY = "PATK_global_usage";

/** `owner/repo` de una imagen, o null si no se puede saber. */
export function inferOwnerRepo(image: string): { owner: string; repo: string } | null {
  // ghcr.io/owner/repo:tag
  const ghcr = image.match(/^ghcr\.io\/([^/]+)\/([^/:@]+)/);
  if (ghcr) return { owner: ghcr[1], repo: ghcr[2] };

  // registry.example.com/owner/repo:tag  (3+ path segments, skip registry)
  const parts = image.split("/");
  if (parts.length >= 3 && parts[0].includes(".")) {
    return { owner: parts[1], repo: parts[2].split(/[:@]/)[0] };
  }

  // owner/repo:tag
  if (parts.length === 2) {
    return { owner: parts[0], repo: parts[1].split(/[:@]/)[0] };
  }

  return null;
}

/** El repo de un servicio: el que se le puso, o el que se deduce de su imagen. */
export function repoOfDeployable(d: { repoFullName: string; imageRepo: string }): string {
  if (d.repoFullName) return d.repoFullName;
  const r = inferOwnerRepo(d.imageRepo);
  return r ? `${r.owner}/${r.repo}` : "";
}
