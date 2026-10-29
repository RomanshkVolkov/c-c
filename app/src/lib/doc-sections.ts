import { docHref } from "@/components/markdown/card-menu";
import type { DecisionLink, DocSection } from "@/types/task";

/**
 * Las secciones de un documento, como las ve la pantalla
 * (command-and-control-91).
 *
 * El servidor da a cada título un id y las decisiones que lo sostienen
 * (`DocSection`); aquí se casan con los títulos que pinta el markdown.
 */

/**
 * Cómo se comparan dos títulos: sin mayúsculas, sin acentos y sin las marcas
 * de markdown, igual que `domain.SectionKey` del backend. El servidor guarda
 * `**Correo**` tal cual y el markdown pinta «Correo».
 */
export function headingKey(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .join(" ");
}

/**
 * Las secciones de un markdown por la línea (desde 1) de su título.
 *
 * Los títulos se cuentan con las reglas del backend (`domain.SplitSections`) y
 * del MCP: de uno a seis `#` y un espacio, nunca dentro de un bloque de
 * código. El título `i` es la sección de puesto `i` **si su título casa**; si
 * no, la sección está atrasada y el título se queda sin ella antes que con la
 * de otro. Por la línea y no por el orden en que se pintan: pintar dos veces
 * (el modo estricto de React lo hace) no puede cambiar la respuesta.
 */
export function sectionsByLine(body: string, sections: DocSection[] | undefined): Map<number, DocSection> {
  const out = new Map<number, DocSection>();
  if (!sections?.length) return out;
  const byIndex = new Map(sections.map((s) => [s.index, s]));
  let fence = "";
  let index = 0;
  body.split("\n").forEach((line, i) => {
    const t = line.trimStart();
    const marker = t.startsWith("```") ? "```" : t.startsWith("~~~") ? "~~~" : "";
    if (!fence && marker) fence = marker;
    else if (fence && marker === fence) fence = "";
    if (fence || marker) return;
    const m = /^(#{1,6}) (.*)$/.exec(line);
    if (!m) return;
    const text = m[2].trim().replace(/#+$/, "").trim();
    const s = byIndex.get(index);
    if (s && s.level === m[1].length && headingKey(s.heading) === headingKey(text)) out.set(i + 1, s);
    index++;
  });
  return out;
}

/** El enlace a la sección de un enlace de decisión: su documento, su pestaña o página, y ella. */
export function sectionHref(l: DecisionLink): string | null {
  if (!l.ownerKind || !l.ownerId) return null;
  const base = docHref(l.ownerKind, l.ownerId, l.pageId ? undefined : l.tab, l.pageId || undefined);
  return l.sectionId && !l.sectionRemoved ? `${base}&section=${l.sectionId}` : base;
}

/**
 * Salta a la sección que pidió un enlace, cuando ya está pintada. Quien pinta
 * el documento la llama tras cada pintado; si la sección no está (otra
 * pestaña, aún cargando), la petición sigue esperando.
 */
export function scrollToSection(root: ParentNode, id: string | null): boolean {
  if (!id) return false;
  const el = root.querySelector(`[data-section-id=${JSON.stringify(id)}]`);
  if (!el) return false;
  el.scrollIntoView({ block: "start" });
  return true;
}
