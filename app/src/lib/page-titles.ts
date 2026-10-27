/**
 * El título vivo de los bloques de página de una nota.
 *
 * Un bloque de página (lo que deja `/page`) se guarda como
 * `[Título](/notes/<id>)` en su línea, así que su texto es el título que tenía
 * la página **al enlazarla**. Si luego se renombra, el bloque seguiría
 * diciendo el viejo. Al abrir la nota se ponen al día con los títulos del
 * árbol.
 *
 * Sólo los bloques (una línea que no lleva nada más): un enlace en mitad de
 * una frase lleva el texto que le puso quien escribió, y ése no se toca.
 */

const BLOCK = /^(\s*)\[((?:\\.|[^\]\\])*)\]\(\/notes\/([^)\s/?#]+)\)(\s*)$/;

/** Lo que el serializador de markdown escapa con una barra. */
const PUNCT = /[\\`*_{}[\]()#+\-.!|<>~]/g;
const escapeText = (s: string) => s.replace(PUNCT, "\\$&");
const unescapeText = (s: string) => s.replace(/\\(.)/g, "$1");

/**
 * El markdown con los bloques de página al día, o el mismo string si no había
 * nada que cambiar (comparar por identidad basta para saber si guardar).
 *
 * Se compara sin escapes: el editor escapa a su manera al guardar, y comparar
 * el texto escapado haría que cada apertura reescribiera la nota.
 */
export function syncPageTitles(md: string, titleOf: (id: string) => string | undefined): string {
  let changed = false;
  let inFence = false;
  const lines = md.split("\n").map((line) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) return line;
    const m = BLOCK.exec(line);
    if (!m) return line;
    const [, lead, text, id, trail] = m;
    const title = titleOf(id);
    if (!title || unescapeText(text) === title) return line;
    changed = true;
    return `${lead}[${escapeText(title)}](/notes/${id})${trail}`;
  });
  return changed ? lines.join("\n") : md;
}
