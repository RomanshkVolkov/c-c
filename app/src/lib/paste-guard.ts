/**
 * Pegar una imagen en un campo de texto no hace nada útil: un `<input>` no
 * guarda imágenes. Y en la app de escritorio dejaba la ventana colgada (jose,
 * 16-oct-2026, en la URL del webhook de una integración). Así que se para
 * **antes** de que el navegador intente meterla, y se dice por qué.
 *
 * Sólo en campos de texto de verdad (`input`, `textarea`). Un editor
 * (`contenteditable`, el de markdown) sí sabe qué hacer con una imagen, y sigue
 * igual. Y sólo cuando lo pegado son ficheros sin texto: una imagen copiada de
 * una web suele traer también su dirección como texto, y eso sí se pega.
 *
 * Medido en WebKitGTK solo, sin la app: el pegado llega como `Files`, sin texto,
 * y el campo se queda vacío. Si el cuelgue fuera de antes (al leer el
 * portapapeles), esto no lo evitaría: ver la tarjeta en cac.
 */
export function shouldBlockPaste(target: EventTarget | null, data: DataTransfer | null): boolean {
  if (!data || data.files.length === 0) return false;
  if ((data.getData("text/plain") ?? "").length > 0) return false;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return false;
  return !target.closest("[contenteditable='true'], [contenteditable='']");
}

/** Instala la guarda en todo el documento; devuelve cómo quitarla. */
export function installPasteGuard(onBlocked: () => void): () => void {
  const handler = (e: ClipboardEvent) => {
    if (!shouldBlockPaste(e.target, e.clipboardData)) return;
    e.preventDefault();
    e.stopPropagation();
    onBlocked();
  };
  // En la fase de captura: antes que cualquier otro que escuche el pegado.
  document.addEventListener("paste", handler, true);
  return () => document.removeEventListener("paste", handler, true);
}
