import { callIdInBody } from "@/components/markdown/card-menu";
import { horaCorta } from "@/lib/fechas";
import { quoteText } from "@/lib/quote";

/**
 * Lo que sale debajo del nombre de un canal o un directo en la lista, como en
 * WhatsApp: la última línea, en limpio y con quién la dijo.
 *
 * En un canal va el nombre («Bea: …»), porque hablan varios; en un directo
 * no, que ya se sabe quién es, salvo que sea lo tuyo («Tú: …»). Una línea del
 * sistema no la firma nadie, y el resumen de una llamada se dice con palabras
 * en vez de enseñar su markdown.
 */
export function previewLine(
  last: { body: string; kind?: "user" | "system"; authorName?: string; mine: boolean },
  labels: { you: string; callEnded: string },
  withAuthor: boolean,
): string {
  if (last.kind === "system") return callIdInBody(last.body) ? labels.callEnded : quoteText(last.body);
  const text = quoteText(last.body);
  if (last.mine) return `${labels.you}: ${text}`;
  return withAuthor && last.authorName ? `${last.authorName}: ${text}` : text;
}

/**
 * La hora de la fila: la del mensaje si es de hoy, «Ayer», el día de la
 * semana si es de esta semana, y la fecha si es de antes. Con los captadores
 * locales: es el día de quien mira, no el de Greenwich.
 */
export function listTime(iso: string, now: Date, locale: string, yesterday: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(at)) / 86_400_000);
  // La misma hora que lleva cada mensaje en la conversación.
  if (days <= 0) return horaCorta(iso);
  if (days === 1) return yesterday;
  if (days < 7) return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(at);
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "numeric", year: "2-digit" }).format(at);
}
