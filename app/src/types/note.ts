/** One row of the navigator — no body, so the tree stays cheap to list. */
export interface NoteTreeItem {
  id: string;
  parentId?: string | null;
  position: number;
  title: string;
  hasBody: boolean;
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
  createdAt: string;
  updatedAt: string;
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
