import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { AlertCircle, ArrowRight, Bug, CheckSquare, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card, CardContent, CardHeader, CardTitle,
} from "@/components/ui/card";
import { useOrgsStore } from "@/store/orgs.store";
import { usePendingStore } from "@/store/pending.store";
import { priorityMeta } from "@/types/task";
import { PRIORITY_LABELS, STATUS_LABELS } from "@/types/report";

/**
 * What's still on the table, on the first screen of the app.
 *
 * Read-only and a shortcut, not a third place to work: every row goes to the
 * page that owns it. Duplicating the board or the report drawer here would
 * mean two implementations of the same editing rules.
 */

export default function PendingSummary() {
  const navigate = useNavigate();
  const orgId = useOrgsStore((s) => s.currentOrgId);
  const tasks = usePendingStore((s) => s.tasks);
  const reports = usePendingStore((s) => s.reports);
  const failed = usePendingStore((s) => s.failed);
  const load = usePendingStore((s) => s.load);

  // Live updates arrive through the event stream, which calls markStale() — see
  // the store. This only covers opening the page and switching org.
  useEffect(() => {
    void load(orgId);
  }, [orgId, load]);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <PendingCard
        title="Open reports"
        icon={Bug}
        count={reports?.length}
        failed={failed}
        onSeeAll={() => navigate("/tasks")}
        empty="Nothing reported and unresolved."
      >
        {reports?.slice(0, 6).map((r) => (
          <Row
            key={r.id}
            onClick={() => navigate(`/tasks?task=${r.id}`)}
            title={r.title}
            meta={`${r.folio} · ${r.projectName}`}
            right={
              <>
                <Badge variant="outline" className="py-0 text-xs">
                  {STATUS_LABELS[r.status]}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {PRIORITY_LABELS[r.priority] ?? r.priority}
                </span>
              </>
            }
          />
        ))}
      </PendingCard>

      <PendingCard
        title="Open tasks"
        icon={CheckSquare}
        count={tasks?.length}
        failed={failed}
        onSeeAll={() => navigate("/tasks")}
        empty="No unfinished tasks."
      >
        {tasks?.slice(0, 6).map((t) => (
          <Row
            key={t.id}
            onClick={() => navigate(`/tasks?task=${t.id}`)}
            title={t.title}
            meta={`${t.spaceName} · ${t.listName}`}
            right={
              <>
                <Badge variant="outline" className="py-0 text-xs">
                  {t.statusName}
                </Badge>
                <span className={`text-xs ${priorityMeta(t.priority).className}`}>
                  {t.dueAt ? formatDue(t.dueAt) : priorityMeta(t.priority).label}
                </span>
              </>
            }
          />
        ))}
      </PendingCard>
    </div>
  );
}

/** A due date is only worth the space when it's close or already missed. */
function formatDue(iso: string): string {
  const days = Math.round((+new Date(iso) - Date.now()) / 86_400_000);
  if (days < 0) return `${-days}d late`;
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function PendingCard({
  title,
  icon: Icon,
  count,
  failed,
  empty,
  onSeeAll,
  children,
}: {
  title: string;
  icon: typeof Bug;
  count?: number;
  failed: boolean;
  empty: string;
  onSeeAll: () => void;
  children: React.ReactNode;
}) {
  const loading = count === undefined && !failed;
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Icon className="size-4 text-muted-foreground" />
          {title}
          {count !== undefined && count > 0 && (
            <span className="text-muted-foreground">({count})</span>
          )}
        </CardTitle>
        <Button variant="ghost" size="sm" onClick={onSeeAll}>
          See all <ArrowRight className="ml-1 size-3" />
        </Button>
      </CardHeader>
      <CardContent className="pt-0">
        {failed ? (
          <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <AlertCircle className="size-4 text-destructive" />
            Couldn't load this. The rest of the page is fine.
          </p>
        ) : loading ? (
          <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </p>
        ) : count === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{empty}</p>
        ) : (
          <ul className="divide-y">{children}</ul>
        )}
      </CardContent>
    </Card>
  );
}

function Row({
  title,
  meta,
  right,
  onClick,
}: {
  title: string;
  meta: string;
  right: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        onClick={onClick}
        className="flex w-full items-center gap-3 py-2 text-left hover:bg-accent/50"
      >
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm">{title}</p>
          <p className="truncate text-xs text-muted-foreground">{meta}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">{right}</div>
      </button>
    </li>
  );
}
