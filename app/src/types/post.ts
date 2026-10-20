import type { Reaction } from "@/lib/reactions";

/** El muro (backend: `domain/post.go`). */
export type PostKind = "announcement" | "feedback";
/** `platform`: su org y el equipo de cac. `everyone`: todas las orgs. */
export type PostAudience = "platform" | "everyone";

export interface Post {
  id: string;
  kind: PostKind;
  audience: PostAudience;
  orgId?: string;
  orgName?: string;
  authorId: string;
  authorName: string;
  title: string;
  body: string;
  createdAt: string;
  comments: number;
  reactions: Reaction[];
  /** Publicado después de la última vez que abriste el muro. */
  unseen: boolean;
  canDelete: boolean;
  /** Sólo su autor la edita. */
  canEdit: boolean;
  /** Sólo un superadmin fija. */
  canPin: boolean;
  pinned: boolean;
  editedAt?: string;
  /** `mcp`: la publicó un agente con el token de su autor. */
  via?: string;
  /** Redactado y sin publicar: sólo lo ve su autor. */
  draft: boolean;
  /** Es un borrador tuyo y lo puedes publicar. */
  canPublish: boolean;
}

export interface PostComment {
  id: string;
  postId: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
  canDelete: boolean;
  reactions: Reaction[];
  via?: string;
}

export interface PostDetail extends Post {
  commentList: PostComment[];
}

export interface PostPage {
  posts: Post[];
  nextCursor?: string;
}

export interface UpdatePostPayload {
  title?: string;
  body?: string;
  audience?: PostAudience;
}

export interface CreatePostPayload {
  kind: PostKind;
  orgId?: string;
  audience?: PostAudience;
  title?: string;
  body: string;
}
