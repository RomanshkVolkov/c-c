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
}

export interface FolderTree {
  id: string;
  name: string;
  lists: ListSummary[];
}

export interface SpaceTree {
  id: string;
  orgId: string;
  name: string;
  color: string;
  projectId?: string;
  folders: FolderTree[];
  lists: ListSummary[];
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
  statusName: string;
  statusKind: TaskStatusKind;
  listId: string;
  listName: string;
  spaceId: string;
  spaceName: string;
  updatedAt: string;
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
  contentType: string;
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
  contentType: string;
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
}

export interface DocResponse {
  /** null until the node's overview is written for the first time. */
  doc: Doc | null;
  attachments: DocAttachment[];
}

/** Key used by the "which nodes have a document" index. */
export const docKey = (kind: DocOwnerKind, id: string) => `${kind}:${id}`;
