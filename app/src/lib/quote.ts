/**
 * El texto de una cita: lo que dice un mensaje, en una línea y sin markdown.
 *
 * La cita encima de una respuesta (como en WhatsApp) es para reconocer a qué
 * se contesta, no para leerlo entero: un `**`, un `[texto](url)` o una imagen
 * crudos en dos líneas de 12px son ruido. Se quita lo que se ve como
 * marcado y se deja el texto; una imagen o un adjunto quedan como su nombre.
 */
export function quoteText(body: string): string {
  return (
    body
      // Bloques de código: su contenido sí, las vallas no.
      .replace(/```[^\n]*\n?/g, "")
      // Imágenes y enlaces: el texto que se ve.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt: string) => (alt ? `🖼 ${alt}` : "🖼"))
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      // Encabezados, citas y viñetas al principio de línea.
      .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
      // Énfasis y código en línea.
      .replace(/(\*\*|__|~~|`)/g, "")
      .replace(/(^|\W)[*_](\S[^*_]*?)[*_](?=\W|$)/g, "$1$2")
      .replace(/\s+/g, " ")
      .trim()
      // Las entidades que escribe el editor: guarda `<` como `&lt;`, y el
      // lector las deshace al pintar, así que aquí también. Sin esto, un
      // «<3» salía como «&lt;3» en la lista de directos (16-oct-2026).
      .replace(/&(lt|gt|quot|#39|apos|nbsp|#(\d+)|amp);/g, (_, name: string, code?: string) =>
        code ? String.fromCharCode(Number(code)) : ENTITIES[name] ?? "",
      )
  );
}

const ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  apos: "'",
  nbsp: " ",
  amp: "&",
};

/**
 * Lleva la vista al mensaje citado y lo resalta un momento. Devuelve false si
 * no está pintado — el hilo va por páginas y puede estar más arriba de lo
 * cargado —, para que quien llama lo diga en vez de no hacer nada.
 *
 * Se busca **dentro del hilo de la cita** (`data-thread`) y no por un id del
 * documento: el chat de la llamada se pinta encima del canal con los mismos
 * mensajes, y un id repetido llevaría la vista al hilo que no se ve.
 */
export function jumpToMessage(id: string, from: Element): boolean {
  const root = from.closest("[data-thread]") ?? document;
  const el = root.querySelector(`[data-msg-id="${CSS.escape(id)}"]`);
  if (!el) return false;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.add("reply-flash");
  window.setTimeout(() => el.classList.remove("reply-flash"), 1600);
  return true;
}
