import { isTauri } from "@/lib/platform";

/**
 * Ficheros soltados o pegados desde un gestor de ficheros que llegan sólo como
 * direcciones `file:///…` (WebKitGTK con Thunar: jose, 6-oct-2026). El webview
 * no puede leer una ruta del disco; los bytes los da Rust (`read_dropped_file`,
 * que sólo sirve tipos que se adjuntan). Fuera del escritorio no hay nada que
 * hacer con una ruta.
 */

/** Las direcciones `file://` de un `drop` o un pegado. */
export function fileURIs(dt: DataTransfer): string[] {
  const list = dt.getData("text/uri-list") || "";
  return list
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && l.startsWith("file://"));
}

const TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  avif: "image/avif", heic: "image/heic", pdf: "application/pdf", csv: "text/csv", zip: "application/zip",
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg", mp4: "video/mp4",
  webm: "video/webm", mov: "video/quicktime",
};

/** El nombre del fichero de una dirección `file://`. */
export function nameOf(uri: string): string {
  const last = uri.split("/").pop() ?? "file";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** Lee esas direcciones como ficheros. Las que no se pueden leer, se saltan. */
export async function readDropped(uris: string[]): Promise<File[]> {
  if (!isTauri || uris.length === 0) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  const out: File[] = [];
  for (const uri of uris) {
    try {
      const bytes = await invoke<ArrayBuffer>("read_dropped_file", { uri });
      const name = nameOf(uri);
      const ext = name.split(".").pop()?.toLowerCase() ?? "";
      out.push(new File([bytes], name, { type: TYPES[ext] ?? "application/octet-stream" }));
    } catch {
      // No es de lo que se adjunta, o ya no está: se salta.
    }
  }
  return out;
}
