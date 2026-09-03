import type { UserSummary } from "@/types/collections";
import type { CommentAuthor, ReportTelemetry } from "@/types/report";

export type TaskPriority = "none" | "low" | "normal" | "high" | "urgent";
export type TaskStatusKind = "open" | "active" | "done";

/** Ordered worst→best so pickers and sorts agree. */
export const PRIORITIES: TaskPriority[] = ["urgent", "high", "normal", "low", "none"];

/**
 * How each priority is drawn.
 *
 * Read through `priorityMeta()`, never indexed directly: the server has grown a
 * value this table didn't have before, and reading `.className` off the
 * resulting undefined took the whole drawer down — a blank screen for one
 * unrecognised string.
 */
export const PRIORITY_META: Record<TaskPriority, { label: string; className: string }> = {
  urgent: { label: "Urgent", className: "text-error" },
  high: { label: "High", className: "text-warning" },
  normal: { label: "Normal", className: "text-info" },
  low: { label: "Low", className: "text-muted-foreground" },
  none: { label: "None", className: "text-muted-foreground/60" },
};

/**
 * The drawing for a priority, including ones this build has never heard of.
 *
 * `medium` is the stored name for what this API calls `normal`; anything else
 * unknown is shown by its own name rather than crashing or pretending to be
 * something it isn't.
 */
export function priorityMeta(p: string): { label: string; className: string } {
  const known = PRIORITY_META[p as TaskPriority];
  if (known) return known;
  if (p === "medium") return PRIORITY_META.normal;
  return { label: p || "None", className: "text-muted-foreground/60" };
}

export interface TaskTag {
  id: string;
  orgId: string;
  name: string;
  color: string;
}

export interface TaskStatus {
  id: string;
  listId: string;
  name: string;
  color: string;
  kind: TaskStatusKind;
  /**
   * El estado canónico que esta columna representa: `pending`, `in_progress`,
   * `resolved` o `closed`. Pásalo por `normalizeStatus` para compararlo.
   *
   * Lo manda el servidor a propósito. `kind` no vale para identificar una
   * columna —«Done» y «Closed» son las dos `done`— y sacarlo del id partiéndolo
   * por la barra sería copiar aquí una regla que es suya.
   */
  status: string;
}

/** Who can see the work in a place: a client's channel, or nobody outside. */
export type ItemVisibility = "public" | "internal";

export interface ListSummary {
  id: string;
  name: string;
  /**
   * The client channel this list belongs to, if any — its own binding or the one
   * it inherits from its space.
   *
   * Present here so the navigator can mark those lists. Which lists a client can
   * see into is exactly the thing that must not be invisible.
   */
  projectId?: string;
  taskCount: number;
  /** Las que quedan por hacer, frente a `taskCount` que son todas las vivas. */
  openCount: number;
}

export interface FolderTree {
  id: string;
  name: string;
  /** Folders hold folders since the tree gained nesting. Empty for a flat one. */
  folders: FolderTree[];
  lists: ListSummary[];
}

export interface SpacePerson {
  userId: string;
  username: string;
}

export interface SpaceTree {
  id: string;
  orgId: string;
  name: string;
  color: string;
  projectId?: string;
  /**
   * "general" es la sala de toda la organización: canal y llamada, sin tareas.
   * Vacío —o ausente— es un espacio corriente, que es lo que son todos los que
   * ya existían.
   */
  kind?: string;
  folders: FolderTree[];
  lists: ListSummary[];
  /**
   * Quién carga trabajo abierto aquí dentro. Es la única pertenencia real que
   * tiene un espacio: no hay miembros por espacio —quien está en la
   * organización llega a todos— así que «quién está aquí» sólo se responde por
   * lo que la gente sostiene.
   */
  people: SpacePerson[];
}

/**
 * One line of the dashboard's pending list. Comes from `GET /api/v1/tasks`,
 * which crosses every list in the org — unlike a board, which is one list — so
 * a row has to say where it came from.
 */
export interface OpenTask {
  id: string;
  seq: number;
  title: string;
  priority: TaskPriority;
  dueAt?: string | null;
  /**
   * El estado crudo. Hay que quedarse con éste y no con `statusKind` para
   * agrupar: la clase mete `done` y `closed` en el mismo saco, y una tarea
   * cerrada —que es un estado que llega de verdad por la integración
   * server-to-server— desaparecería dentro de «terminadas».
   *
   * Pásalo por `normalizeStatus`: un servidor sin renombrar todavía responde
   * `pending` y `resolved`.
   */
  status: string;
  statusName: string;
  statusKind: TaskStatusKind;
  listId: string;
  listName: string;
  spaceId: string;
  spaceName: string;
  updatedAt: string;
  /** Done / total, so a card says what you would open it to find out. */
  subtasksDone: number;
  subtasksTotal: number;
  /** The primary assignee's name; the card shows their initials. */
  assignee?: string;
}

export interface TaskCard {
  id: string;
  seq: number;
  title: string;
  priority: TaskPriority;
  statusId: string;
  dueAt?: string | null;
  hasDescription: boolean;
  commentCount: number;
  attachmentCount: number;
  subtaskCount: number;
  subtaskDone: number;
  tags: TaskTag[];
  assignees: UserSummary[];
  updatedAt: string;
  /** Report taxonomy, so the board can filter without opening each card. */
  category?: string;
  area?: string;
  /** When it arrived — what the calendar view groups by. */
  createdAt: string;
}

export interface BoardResponse {
  list: ListSummary;
  statuses: TaskStatus[];
  tasks: TaskCard[];
}

export interface TaskAttachment {
  id: string;
  taskId: string;
  commentId?: string | null;
  url: string;
  fileName: string;
  /**
   * Ausente cuando el servidor no tiene ninguno: el campo es `omitempty`, y el
   * ingest de imágenes de un cliente nunca lo escribe. Decía `string` y era
   * mentira — una llamada a `.startsWith` sobre él tumbó la pantalla de tareas
   * entera en cuanto una tarjeta con captura de cliente entró en pantalla.
   */
  contentType?: string;
  bytes: number;
}

export interface TaskComment {
  id: string;
  /**
   * Who wrote it, tagged. The flat fields below only ever name people with a
   * cac account, so the client's own replies used to render anonymous.
   */
  author?: CommentAuthor;
  authorUserId: string;
  authorName: string;
  /**
   * Who reads this line. Sent per comment because a thread of replies looks
   * identical whether the client can see them or not, and the only other way to
   * find out is to open their side and compare.
   */
  visibility?: ItemVisibility;
  /** `system` is a status line cac wrote, not somebody's words. */
  kind?: "user" | "system";
  /**
   * La entrada del registro que salió de este comentario, si salió alguna.
   *
   * El id y no un booleano: un booleano diría que hubo una decisión sin decir
   * cuál, y lo que hace falta desde el hilo es poder abrirla.
   */
  decisionId?: string;
  body: string;
  attachments: TaskAttachment[];
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  listId: string;
  statusId: string;
  orgId: string;
  seq: number;
  title: string;
  description: string;
  priority: TaskPriority;
  startAt?: string | null;
  dueAt?: string | null;
  completedAt?: string | null;
  createdById: string;
  /** The client channel this item belongs to, if any. */
  projectId?: string;
  /**
   * Whether that client actually sees it. Separate from projectId because a
   * withdrawn item keeps its channel — that is what stops its ticket number
   * being handed out twice.
   */
  visibility?: ItemVisibility;
  parentId?: string | null;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Where this came from, when it arrived through a client's channel.
   *
   * These have always travelled — an item is one row and the task API returns
   * all of it — but nothing on the board read them, so opening a client's
   * ticket from the board showed a card with no reporter and no idea what they
   * were looking at when it broke.
   */
  reporterName?: string;
  reporterEmail?: string;
  reporterId?: string;
  /** The page they were on, and what they were using. */
  url?: string;
  userAgent?: string;
  viewport?: string;
  category?: string;
  area?: string;
  /** "user" for something a person filed, "system" for an automatic report. */
  origin?: string;
}

export interface TaskDetail {
  task: Task;
  listName: string;
  spaceName: string;
  status: TaskStatus;
  tags: TaskTag[];
  assignees: UserSummary[];
  comments: TaskComment[];
  attachments: TaskAttachment[];
  subtasks: TaskCard[];
  parent?: TaskCard | null;
  /** "portento-89" — only for a client's ticket; internal cards number per space. */
  folio?: string;
  projectSlug?: string;
  /** Decrypted breadcrumbs, when the report carried them and they aren't purged. */
  telemetry?: ReportTelemetry;
}

export interface UpdateTaskPayload {
  title?: string;
  description?: string;
  priority?: TaskPriority;
  startAt?: string | null;
  dueAt?: string | null;
  tagIds?: string[];
  assigneeIds?: string[];
  archived?: boolean;
  /**
   * Show the item to the client whose channel this list belongs to, or take it
   * back.
   *
   * Taking it back does not return the folio it was given: they may already have
   * quoted that number, so their numbering keeps a gap.
   */
  visibility?: ItemVisibility;
}

// ─── Docs ─────────────────────────────────────────────────────────────────────

/** The node a document describes: one overview per space, folder or list. */
export type DocOwnerKind = "space" | "folder" | "list";

export interface DocAttachment {
  id: string;
  docId: string;
  url: string;
  fileName: string;
  /**
   * Ausente cuando el servidor no tiene ninguno: el campo es `omitempty`, y el
   * ingest de imágenes de un cliente nunca lo escribe. Decía `string` y era
   * mentira — una llamada a `.startsWith` sobre él tumbó la pantalla de tareas
   * entera en cuanto una tarjeta con captura de cliente entró en pantalla.
   */
  contentType?: string;
  bytes: number;
}

export interface Doc {
  id: string;
  orgId: string;
  ownerKind: DocOwnerKind;
  ownerId: string;
  body: string;
  updatedBy: string;
  updatedByName?: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Quién responde de este documento.
   *
   * `maintainer` y no `owner` porque `ownerKind`/`ownerId` de arriba ya son el
   * **nodo** del que cuelga, no una persona. En pantalla se llama «Owner», que
   * es como lo llama quien lo usa.
   */
  maintainerId?: string;
  maintainerName?: string;
  /** Cuándo alguien confirmó que sigue siendo verdad. Editar no es revisar. */
  reviewedAt?: string;
  reviewedBy?: string;
  reviewedByName?: string;
  /** Una línea sobre el tablero. Corta a la fuerza, o se deja de leer. */
  pinnedLine?: string;
  /** Lo calcula el servidor: la regla de los 90 días vive en un solo sitio. */
  stale: boolean;
}

/**
 * Lo que el navegador sabe de un documento sin cargarlo.
 *
 * Lleva la línea fijada porque el tablero la pinta y el tablero no carga el
 * documento: pedirlo entero para leer una línea sería una petición más por cada
 * lista que se abre.
 */
export interface DocMark {
  written: boolean;
  pinnedLine?: string;
  stale?: boolean;
  /** Para el índice de la organización; el resto lo pone el árbol. */
  maintainerId?: string;
  maintainerName?: string;
  reviewedAt?: string;
}

/**
 * Las cuatro secciones de un documento, fijas y en este orden.
 *
 * Ninguna se oculta cuando está vacía: su ausencia es información. Que un
 * proyecto no tenga runbook es un dato sobre el proyecto.
 */
export const DOC_TABS = ["overview", "runbook", "decisions", "links"] as const;
export type DocTabKey = (typeof DOC_TABS)[number];

export interface DocTab {
  id: string;
  docId: string;
  key: DocTabKey;
  body: string;
  updatedBy: string;
  updatedByName?: string;
  updatedAt: string;
}

/**
 * Una foto de una sección tal como se guardó.
 *
 * `body` es el texto **anterior** al guardado, no el nuevo: a lo que se quiere
 * volver es a lo que había antes de la edición que salió mal.
 */
export interface DocVersion {
  id: string;
  docId: string;
  key: DocTabKey;
  body: string;
  authorId: string;
  authorName?: string;
  createdAt: string;
}

/**
 * De dónde salió una decisión. Obligatorio, y ésa es la regla que le da valor
 * a la pestaña: una decisión sin procedencia es una frase suelta, y lo que se
 * hace con una frase que no se puede comprobar es ignorarla.
 */
export type DecisionOrigin = "task" | "message" | "doc";

/**
 * Una entrada del registro de un documento.
 *
 * **Append-only**: no hay editar ni borrar, y no es una carencia. Un registro
 * que se puede reescribir no es un registro. Se corrige añadiendo, que además
 * deja ver que hubo una corrección.
 */
export interface Decision {
  id: string;
  docId: string;
  title: string;
  body: string;
  tag?: string;
  authorId: string;
  authorName?: string;
  decidedAt: string;
  origin: DecisionOrigin;
  originTaskId?: string;
  originMessageId?: string;
  originChannelId?: string;
  /** El nombre de la tarea o del canal, ya resuelto: nadie reconoce un uuid. */
  originTitle?: string;
}

export interface DocResponse {
  /** null until the node's document is written for the first time. */
  doc: Doc | null;
  /** Siempre las cuatro, también las vacías. Vacío sólo si `doc` es null. */
  tabs: DocTab[];
  /** El registro. Va con el documento: es una de las cuatro pestañas. */
  decisions: Decision[];
  attachments: DocAttachment[];
}

/**
 * Que un `kind` que viene de una URL sea uno de los tres.
 *
 * El enlace de compartir llega escrito en un mensaje, y un mensaje lo escribe
 * cualquiera: sin comprobarlo, un `?doc=usuarios:algo` acabaría llamando a una
 * ruta inventada.
 */
export function isDocOwnerKind(k: string): k is DocOwnerKind {
  return k === "space" || k === "folder" || k === "list";
}

/** Key used by the "which nodes have a document" index. */
export const docKey = (kind: DocOwnerKind, id: string) => `${kind}:${id}`;
