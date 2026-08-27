import type { InboxItem } from "@/store/inbox.store";

/**
 * Una fila por conversación, no una por mensaje.
 *
 * Diez mensajes de un canal eran diez filas en la campana, y a la tercera dejas
 * de leerlas. Aquí se pliegan en una con el último y un contador, como un
 * teléfono.
 *
 * Toda la decisión de **qué va con qué** vive en `groupKeyOf`, y toda la de
 * **cómo se lee** en `summarize`. Las dos son funciones puras: se prueban sin
 * montar un panel, y son donde de verdad se puede equivocar uno.
 */

/** Las familias que se pliegan. Sale del `kind`, nunca del enlace. */
type Family = "chat" | "dm" | "item" | "none";

function familyOf(kind: string): Family {
  if (kind.startsWith("chat:")) return "chat";
  if (kind.startsWith("dm:")) return "dm";
  if (kind.startsWith("task:") || kind.startsWith("report:")) return "item";
  // Los recordatorios de reunión **no se pliegan**, y es a propósito: su enlace
  // es el de la sala —el mismo formato que un mensaje de canal— y la fila no
  // lleva la identidad de la reunión por ninguna parte. Agruparlos por su sala
  // metería la daily y la retro del mismo canal en un solo montón, y confundir
  // dos citas del calendario es peor que no plegarlas: son pocas y se leen.
  return "none";
}

/** El id que lleva un enlace, si es de la forma que se espera. */
function idFromLink(link: string, param: string): string {
  const q = link.indexOf("?");
  if (q < 0) return "";
  return new URLSearchParams(link.slice(q + 1)).get(param) ?? "";
}

/**
 * De qué conversación es esto.
 *
 * El servidor la manda en `groupKey` desde que existe la columna. Para todo lo
 * anterior se deduce del enlace — pero **la familia sale del `kind`**, y el
 * enlace sólo aporta el id. Al revés sería un fallo: `/chat?space=X` es tanto un
 * mensaje del canal como un recordatorio de una reunión en esa sala.
 *
 * Cuando no se puede saber devuelve `""`, y `groupInbox` lo trata como una fila
 * suelta. Nunca las junta: un montón de avisos inconexos bajo una clave vacía
 * sería peor que la lista plana de la que venimos.
 */
export function groupKeyOf(
  n: Pick<InboxItem, "kind" | "link" | "groupKey">,
): string {
  if (n.groupKey) return n.groupKey;

  switch (familyOf(n.kind)) {
    case "chat": {
      const id = idFromLink(n.link, "space");
      return id ? `space:${id}` : "";
    }
    case "dm": {
      const id = idFromLink(n.link, "c");
      return id ? `dm:${id}` : "";
    }
    case "item": {
      // `open` es el formato viejo de la pantalla de reportes, que sigue vivo en
      // filas de hace meses.
      const id = idFromLink(n.link, "task") || idFromLink(n.link, "open");
      return id ? `item:${id}` : "";
    }
    default:
      return "";
  }
}

export interface NotificationGroup {
  /** La clave, o el id de la propia fila cuando no se pudo agrupar. */
  key: string;
  /** Tal como llegaron: el primero es el que se enseña plegado. */
  items: InboxItem[];
  /** Si es una sola fila: se pinta como siempre, sin galón ni contador. */
  alone: boolean;
}

/**
 * Pliega una lista ya filtrada.
 *
 * **Quien llame tiene que haber separado antes lo leído de lo no leído.** Un
 * grupo con las dos cosas no se puede colocar: arriba subiría filas ya leídas
 * por encima del rótulo «Read», y abajo escondería avisos nuevos debajo de él.
 *
 * El orden entre grupos es el del miembro más nuevo de cada uno, así que un
 * grupo aparece donde habría aparecido su notificación más reciente. Nunca por
 * tamaño: un canal charlatán y viejo se plantaría arriba del todo para siempre.
 */
export function groupInbox(items: InboxItem[]): NotificationGroup[] {
  const byKey = new Map<string, InboxItem[]>();
  const loose: NotificationGroup[] = [];

  for (const n of items) {
    const key = groupKeyOf(n);
    if (!key) {
      // Sin clave no hay conversación a la que pertenecer. Va sola, con su
      // propio id, para que dos avisos inconexos no acaben en el mismo saco.
      loose.push({ key: n.id, items: [n], alone: true });
      continue;
    }
    const already = byKey.get(key);
    if (already) already.push(n);
    else byKey.set(key, [n]);
  }

  const groups: NotificationGroup[] = [...byKey.entries()].map(([key, items]) => ({
    key,
    items,
    alone: items.length === 1,
  }));

  return [...groups, ...loose].sort((a, b) => newestOf(b).localeCompare(newestOf(a)));
}

/**
 * El instante del miembro más reciente.
 *
 * Comparando las fechas como texto: vienen del servidor en ISO 8601 con zona
 * `Z`, y ese formato ordena igual como cadena que como fecha. Evita construir un
 * `Date` por comparación, y sobre todo evita que una fecha ilegible se convierta
 * en `NaN` y desordene la lista entera en silencio.
 */
function newestOf(g: NotificationGroup): string {
  let max = "";
  for (const n of g.items) if (n.createdAt > max) max = n.createdAt;
  return max;
}

export interface GroupSummary {
  /** El nombre de la conversación: «#portento», «Ana», el título de la tarea. */
  title: string;
  /** La segunda línea: el último mensaje, o un recuento. */
  detail: string;
  /** Cuántas hay dentro. `0` cuando va sola — no se pinta contador. */
  count: number;
  /** Si hay una mención dentro, para que se vea sin abrir. */
  mention: boolean;
  /** Si algo de dentro lo escribió un agente por el MCP. */
  agent: boolean;
  /** A dónde lleva pulsarla: donde ocurrió lo más reciente. */
  link: string;
}

/**
 * Cómo se lee un grupo plegado.
 *
 * El rótulo y el detalle **cambian de sitio según la familia**, y por eso esto
 * no es una plantilla única: en un canal el nombre está en el título de la fila
 * y el mensaje en el cuerpo; en una tarea es al revés — el cuerpo es el título
 * de la tarea y el título dice qué pasó («Bea replied»).
 */
export function summarize(g: NotificationGroup): GroupSummary {
  const newest = g.items.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
  const family = familyOf(newest.kind);
  const count = g.alone ? 0 : g.items.length;

  const base = {
    count,
    mention: g.items.some((n) => n.kind === "chat:mention"),
    agent: g.items.some((n) => n.via === "mcp"),
    link: newest.link,
    title: labelOf(newest),
  };

  if (family === "dm") {
    // **En un directo nunca se enseña el texto.** El servidor manda el cuerpo
    // vacío a propósito —una fila de la campana la puede leer quien pase por
    // detrás, o quien esté viendo tu pantalla compartida— y poner un recuento
    // es lo que hace un teléfono con las vistas previas apagadas: informa sin
    // destapar nada.
    return { ...base, detail: count > 1 ? `${count} new messages` : "New message" };
  }

  // En tareas y reportes el título de la fila dice qué pasó, y el rótulo del
  // grupo ya se llevó el nombre de la tarea.
  if (family === "item") return { ...base, detail: newest.title };

  return { ...base, detail: newest.body };
}

/**
 * El nombre de la conversación tal como lo diría una persona.
 *
 * Se toma del miembro **más nuevo** —no del más viejo— para que un canal
 * renombrado se cure con el siguiente mensaje: el rótulo va congelado en cada
 * fila, igual que hoy va congelado el título.
 *
 * Mientras el servidor no mande `groupLabel`, se apaña con lo que hay: en chat
 * el título ya es «#canal», salvo cuando te nombraron, que llega envuelto en
 * «Mentioned in ». Quitar ese envoltorio es lo único que se hace a mano, y es
 * temporal — con la columna, esto se queda en una línea.
 */
function labelOf(n: InboxItem): string {
  if (n.groupLabel) return n.groupLabel;

  switch (familyOf(n.kind)) {
    case "chat":
      return n.title.replace(/^Mentioned in /, "");
    case "dm":
      return n.title.replace(/ te escribió$/, "");
    case "item":
      return n.body || n.title;
    default:
      return n.title;
  }
}
