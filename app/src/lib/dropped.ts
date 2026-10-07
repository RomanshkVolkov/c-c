import { isTauri } from "@/lib/platform";

/**
 * Ficheros soltados o pegados desde un gestor de ficheros que llegan sólo como
 * direcciones `file:///…` (WebKitGTK con Thunar: jose, 6-oct-2026). El webview
 * no puede leer una ruta del disco; los bytes los da Rust (`read_dropped_file`,
 * que sólo sirve tipos que se adjuntan). Fuera del escritorio no hay nada que
 * hacer con una ruta.
 */

/**
 * Si un arrastre trae ficheros, o la lista de direcciones de un gestor de
 * ficheros. Durante el arrastre todavía no se puede leer el contenido, sólo
 * los tipos.
 */
export function carriesFiles(dt: DataTransfer | null | undefined): boolean {
  const types = Array.from(dt?.types ?? []);
  return types.includes("Files") || types.includes("text/uri-list");
}

/**
 * Acepta el arrastre de un fichero: cancela el `dragover` **y dice «copiar»**.
 * WebKit no entrega el `drop` a la página si el `dropEffect` no casa con lo que
 * ofrece el origen; en su lugar hace su propia inserción, y la ruta del
 * fichero acababa escrita en el mensaje (Thunar en Linux, jose, 6-oct-2026).
 * ProseMirror ya cancelaba el `dragover`, pero sin `dropEffect` no basta.
 * Devuelve si lo aceptó.
 */
export function acceptFileDrag(event: DragEvent): boolean {
  if (!carriesFiles(event.dataTransfer)) return false;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  return true;
}

/**
 * Las direcciones `file://` de un `drop` o un pegado. Se buscan en este orden:
 *
 * 1. `text/uri-list`, la forma estándar.
 * 2. `text/html`: WebKitGTK anuncia la lista pero **la deja vacía** —no le
 *    enseña direcciones `file://` a una página— y la ruta sólo viaja dentro
 *    del HTML del arrastre (Thunar, jose, 6-oct-2026), y además **como texto**
 *    de un `<a>` sin `href`: `<a style="…">file:///…/logo.png</a>`. Se toman
 *    los `href` y `src` que son `file://`, y el texto de un elemento cuando
 *    **entero** es una dirección `file://`.
 * 3. `text/plain`, sólo si **todo** el texto son direcciones `file://`: un
 *    mensaje que menciona una no es soltar un fichero.
 */
export function fileURIs(dt: DataTransfer): string[] {
  const lines = (s: string) =>
    s
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  const list = lines(dt.getData("text/uri-list") || "").filter((l) => l.startsWith("file://"));
  if (list.length > 0) return list;
  const html = dt.getData("text/html") || "";
  if (html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const attrs = Array.from(doc.querySelectorAll("[href], [src]")).map(
      (el) => el.getAttribute("href") ?? el.getAttribute("src") ?? "",
    );
    const texts = Array.from(doc.body.querySelectorAll("*")).map((el) => (el.textContent ?? "").trim());
    const found = [...attrs, ...texts].filter((u) => /^file:\/\/\S+$/.test(u));
    if (found.length > 0) return [...new Set(found)];
  }
  const plain = lines(dt.getData("text/plain") || "");
  return plain.length > 0 && plain.every((l) => l.startsWith("file://")) ? plain : [];
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

/**
 * Lo que trae un `drop` o un pegado: los ficheros que el navegador entrega, y
 * las direcciones `file://` cuando sólo entrega eso. **Síncrono, en el momento
 * del evento**: después el `DataTransfer` ya no deja leer nada. Las
 * direcciones se convierten en ficheros con `readDropped`.
 */
export function takeTransfer(dt: DataTransfer): { files: File[]; uris: string[] } {
  // `files` es lo normal, pero WebKit a veces sólo los da en `items`; y un
  // item y un fichero pueden ser el mismo.
  const all = [
    ...Array.from(dt.files ?? []),
    ...Array.from(dt.items ?? [])
      .filter((i) => i.kind === "file")
      .map((i) => i.getAsFile())
      .filter((f): f is File => !!f),
  ];
  const seen = new Set<string>();
  const files = all.filter((f) => {
    const key = `${f.name}:${f.size}:${f.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { files, uris: files.length > 0 || !isTauri ? [] : fileURIs(dt) };
}

/**
 * Que un fichero soltado donde nadie lo recoge no se lleve la app. Lo que hace
 * el navegador por defecto es **abrirlo en la ventana**: soltar sobre la barra
 * lateral dejaba la imagen a pantalla completa y había que volver atrás (jose,
 * 7-oct-2026). Fuera de una zona para soltar o de un editor, el arrastre de un
 * fichero dice «aquí no» y soltarlo no hace nada.
 *
 * En la fase de burbuja de la ventana: las zonas y los editores ya cancelaron
 * el evento antes, y eso (`defaultPrevented`) es lo que dice que alguien lo
 * recogió. Devuelve la función para quitarlo.
 */
export function guardWindowAgainstFileDrops(target: Window = window): () => void {
  const over = (e: DragEvent) => {
    if (e.defaultPrevented || !carriesFiles(e.dataTransfer)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
  };
  const drop = (e: DragEvent) => {
    if (e.defaultPrevented || !carriesFiles(e.dataTransfer)) return;
    e.preventDefault();
  };
  target.addEventListener("dragover", over);
  target.addEventListener("drop", drop);
  return () => {
    target.removeEventListener("dragover", over);
    target.removeEventListener("drop", drop);
  };
}

