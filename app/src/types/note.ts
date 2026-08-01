/** One row of the navigator — no body, so the tree stays cheap to list. */
export interface NoteTreeItem {
  id: string;
  parentId?: string | null;
  position: number;
  title: string;
  hasBody: boolean;
  /** Pinned to the Favorites section at the top of the navigator. */
  favorite: boolean;
}

export interface NoteAttachment {
  id: string;
  noteId: string;
  url: string;
  fileName: string;
  contentType: string;
  bytes: number;
}

export interface Note {
  id: string;
  ownerId: string;
  orgId?: string | null;
  parentId?: string | null;
  position: number;
  title: string;
  body: string;
  favorite: boolean;
  /** sha256 of body — sent back as the next save's baseHash to detect a race. */
  bodyHash?: string;
  createdAt: string;
  updatedAt: string;
}

export interface NoteConflictInfo {
  id: string;
  title: string;
}

/**
 * What a body save returns. `conflict` is only set when another device saved
 * first: `note` is unchanged and `conflict` points at the new child page that
 * holds the write that wasn't applied.
 */
export interface UpdateNoteResult {
  note: Note;
  conflict?: NoteConflictInfo;
}

export interface NoteDetail {
  note: Note;
  attachments: NoteAttachment[];
  /** Other notes that cite this one — "linked from", derived on every read. */
  backlinks: NoteSearchResult[];
}

export interface NoteSearchResult {
  id: string;
  title: string;
  excerpt: string;
}

/** One page's new placement, sent as a batch — see NoteTreeMove in the backend. */
export interface NoteTreeMove {
  id: string;
  parentId: string | null;
  position: number;
}
