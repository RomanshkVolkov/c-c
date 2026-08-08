/**
 * The permissions a token can carry, in one place.
 *
 * A table rather than seven hand-written checkboxes, because the same list is
 * now needed twice: once when minting a token and once when re-permissioning
 * one. Two copies would drift, and the copy that drifts is the one describing
 * what a credential may do.
 *
 * `id` has to match the backend's scope constants exactly (`domain.ValidScope`
 * drops anything it doesn't recognize, silently — a typo here would mint a
 * token whose permission does nothing).
 */
export interface ScopeOption {
  id: string;
  label: string;
  detail: React.ReactNode;
}

export const SCOPES: ScopeOption[] = [
  {
    id: "tasks:write",
    label: "Create tasks and comments",
    detail: "Append-only: it can add, never replace what someone wrote. Also builds the tree — spaces, folders and lists — so a new project can be set up in one go.",
  },
  {
    id: "tasks:manage",
    label: "Change existing tasks",
    detail: "Move them between columns, and overwrite title, description or priority. Also corrects or withdraws comments you wrote — never anyone else's. Needed to mark work as done.",
  },
  {
    id: "notes:write",
    label: "Create pages in Notes",
    detail: "Append-only: adds a new page, never touches one that already exists. What a migration from another notes app needs.",
  },
  {
    id: "notes:manage",
    label: "Change existing pages",
    detail: "Overwrites a page's title or body outright — the note's own conflict/history safeguards still apply, but the content changes.",
  },
  {
    id: "reports:write",
    label: "Reply to reports",
    detail: "Append-only: add a comment or attach an image to a report.",
  },
  {
    id: "reports:manage",
    label: "Triage reports",
    detail: (
      <>
        Change status, assignee, priority, category or area, remove a report's
        screenshots, and correct or withdraw comments{" "}
        <span className="text-foreground">you</span> wrote — never anyone else's,
        which cac refuses outright.
      </>
    ),
  },
  {
    id: "collections:write",
    label: "Create request collections",
    detail: "Leaves a described API ready to run. Creating only — editing, deleting and sharing one stay out of reach, sharing because it reaches other people.",
  },
];

export function ScopeChecklist({
  selected,
  onToggle,
  compact,
}: {
  selected: string[];
  onToggle: (id: string, on: boolean) => void;
  /** Drops the explanations — for the edit row, where they've been read once. */
  compact?: boolean;
}) {
  return (
    <div className={compact ? "grid grid-cols-2 gap-1" : "grid grid-cols-2 gap-2"}>
      {SCOPES.map((s) => (
        <label key={s.id} className="flex items-start gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={selected.includes(s.id)}
            onChange={(e) => onToggle(s.id, e.target.checked)}
          />
          <span>
            <span className="text-foreground">{s.label}</span>
            {!compact && <span className="block">{s.detail}</span>}
          </span>
        </label>
      ))}
    </div>
  );
}

/** A short, readable summary of what a token may do, for the list. */
export function describeScopes(scopes: string[] | undefined): string {
  if (!scopes || scopes.length === 0) return "read-only";
  return scopes
    .map((id) => SCOPES.find((s) => s.id === id)?.label ?? id)
    .join(" · ");
}
