/**
 * Los enlaces de un texto plano, para pintarlos como enlaces sin pasar por
 * markdown. Lo usa el chat de la llamada, que es texto plano a propósito
 * (mientras alguien habla se pasa una frase o un enlace) y por eso pintaba las
 * URLs como texto: había que seleccionarlas y copiarlas a mano.
 *
 * Sólo `http://` y `https://`. La puntuación con la que se suele cerrar una frase
 * («mira https://x.com/a.») no es del enlace, y un `)` final sólo lo es si
 * abre otro dentro (`https://es.wikipedia.org/wiki/Foo_(bar)`).
 */
export type TextPart = { kind: "text"; text: string } | { kind: "link"; href: string };

const URL = /https?:\/\/[^\s<>"'`]+/g;
const TRAILING = /[.,;:!?'"»]+$/;

function trimUrl(raw: string): string {
  let url = raw.replace(TRAILING, "");
  while (url.endsWith(")") && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) {
    url = url.slice(0, -1).replace(TRAILING, "");
  }
  return url;
}

export function linkify(text: string): TextPart[] {
  const out: TextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(URL)) {
    const href = trimUrl(m[0]);
    const start = m.index ?? 0;
    if (start > last) out.push({ kind: "text", text: text.slice(last, start) });
    out.push({ kind: "link", href });
    last = start + href.length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}
