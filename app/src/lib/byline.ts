import type { CommentAuthor } from "@/types/report";

/**
 * Who to show as the author of a comment.
 *
 * Shared by both threads, because it is one thread. The board used to have no
 * opinion at all here: it printed the name resolved from the users table, which
 * is empty for anyone without a cac account, so the client's own replies
 * rendered anonymous while the very same comments were correctly attributed on
 * the report side.
 *
 * A tenant's asserted name never appears alone. They tell us who is speaking
 * inside their app and we cannot verify it, so it is always shown next to the
 * project that vouched for it — "Sebastian Ramirez · portento". The reporter is
 * the exception: the report itself records who filed it, so that name is ours
 * to trust as much as anything they sent.
 */
export function commentByline(
  author: CommentAuthor | undefined,
  fallbackName?: string,
): string {
  if (!author) return fallbackName || "unknown";
  switch (author.kind) {
    case "user":
      return author.name || "unknown";
    case "tenant":
      return author.name && author.name !== author.projectName
        ? `${author.name} · ${author.projectName}`
        : author.projectName || "tenant";
    default:
      return author.name || "reporter";
  }
}
