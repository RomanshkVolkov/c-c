/**
 * Los instaladores de la última versión, para ofrecerlos desde la web (a donde
 * lleva la invitación).
 *
 * Se preguntan a la API pública de GitHub y no se escriben a mano: los nombres
 * llevan la versión (`CAC_1.24.1_x64-setup.exe`), así que un enlace fijo se
 * queda viejo con la siguiente release. `releases/latest` es la misma que
 * sirve el `latest.json` del actualizador, así que la web ofrece lo mismo que
 * la app se instala sola. Desde la web hace falta `https://api.github.com` en
 * `connect-src` (`web/security-headers.conf`).
 */

export const RELEASES_URL = "https://github.com/RomanshkVolkov/c-c/releases";
const LATEST_API = "https://api.github.com/repos/RomanshkVolkov/c-c/releases/latest";

export type DownloadOS = "windows" | "mac" | "linux";

export type DownloadKind = "windows" | "mac" | "appimage" | "deb" | "rpm";

export interface Download {
  kind: DownloadKind;
  os: DownloadOS;
  name: string;
  url: string;
  size: number;
}

export interface LatestDownloads {
  version: string;
  downloads: Download[];
}

interface GitHubRelease {
  tag_name: string;
  assets: { name: string; browser_download_url: string; size: number }[];
}

// Lo que se instala a mano. Lo demás de la release es del actualizador (las
// firmas `.sig`, el `.app.tar.gz` de macOS y `latest.json`) y no le sirve a
// nadie que llega desde el navegador.
const KINDS: { kind: DownloadKind; os: DownloadOS; test: RegExp }[] = [
  { kind: "windows", os: "windows", test: /-setup\.exe$/ },
  { kind: "mac", os: "mac", test: /\.dmg$/ },
  { kind: "appimage", os: "linux", test: /\.AppImage$/ },
  { kind: "deb", os: "linux", test: /\.deb$/ },
  { kind: "rpm", os: "linux", test: /\.rpm$/ },
];

/** De una release de GitHub, los instaladores en el orden de `KINDS`. */
export function pickDownloads(release: GitHubRelease): LatestDownloads {
  const downloads: Download[] = [];
  for (const k of KINDS) {
    const a = release.assets.find((x) => k.test.test(x.name));
    if (a) downloads.push({ kind: k.kind, os: k.os, name: a.name, url: a.browser_download_url, size: a.size });
  }
  return { version: release.tag_name.replace(/^v/, ""), downloads };
}

/** El sistema de quien mira, para poner su instalador primero. */
export function detectOS(userAgent: string): DownloadOS | null {
  // Un móvil no instala la app de escritorio: mejor no recomendar nada.
  if (/Android|iPhone|iPad|iPod/i.test(userAgent)) return null;
  if (/Windows/i.test(userAgent)) return "windows";
  if (/Mac OS X|Macintosh/i.test(userAgent)) return "mac";
  if (/Linux|X11/i.test(userAgent)) return "linux";
  return null;
}

export async function fetchLatestDownloads(): Promise<LatestDownloads> {
  const res = await fetch(LATEST_API, { headers: { Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`github ${res.status}`);
  return pickDownloads((await res.json()) as GitHubRelease);
}
