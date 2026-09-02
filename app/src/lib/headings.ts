/**
 * Los encabezados de un markdown, y su ancla.
 *
 * Aquí y no dentro del índice porque hacen falta en **dos** sitios: el índice
 * los lista y el renderizador los marca con un `id`. Si cada uno calculara el
 * suyo, bastaría un acento tratado distinto para que el índice apuntara a
 * anclas que no existen — y eso no se ve hasta que alguien pulsa.
 */

export interface Heading {
  text: string;
  level: number;
  id: string;
}

/** «¿Qué es esto?» → `que-es-esto`. */
export function slugify(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    // Quita los diacríticos ya separados por la normalización: sin esto,
    // «Configuración» y «Configuracion» darían anclas distintas.
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Los encabezados de nivel 2 y 3.
 *
 * El 1 se deja fuera a propósito: en un documento con título propio arriba, un
 * `#` dentro del cuerpo es un segundo título y listarlo confunde más que ayuda.
 */
export function headingsOf(markdown: string): Heading[] {
  const out: Heading[] = [];
  let enCodigo = false;
  for (const linea of markdown.split("\n")) {
    // Un ``` abre y cierra: sin esto, un `# comentario` dentro de un bloque de
    // código entraría en el índice como si fuera una sección.
    if (linea.trimStart().startsWith("```")) {
      enCodigo = !enCodigo;
      continue;
    }
    if (enCodigo) continue;
    const m = /^(#{2,3})\s+(.+?)\s*$/.exec(linea);
    if (!m) continue;
    const text = m[2].replace(/[*_`]/g, "").trim();
    if (!text) continue;
    out.push({ text, level: m[1].length, id: slugify(text) });
  }
  return out;
}
