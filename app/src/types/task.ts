import type { UserSummary } from "@/types/collections";

export type TaskPriority = "none" | "low" | "normal" | "high" | "urgent";
export type TaskStatusKind = "open" | "active" | "done";

/** Ordered worst→best so pickers and sorts agree. */
export const PRIORITIES: TaskPriority[] = ["urgent", "high", "normal", "low", "none"];

export const PRIORITY_META: Record<TaskPriority, { label: string; className: string }> = {
  urgent: { label: "Urgent", className: "text-error" },
  high: { label: "High", className: "text-warning" },
  normal: { label: "Normal", className: "text-info" },
  low: { label: "Low", className: "text-muted-foreground" },
  none: { label: "None", className: "text-muted-foreground/60" },
};

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

export interface ListSummary {
  id: string;
  name: string;
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
  folders: FolderTree[];
  lists: ListSummary[];
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
  authorUserId: string;
  authorName: string;
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
  parentId?: string | null;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
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
}
