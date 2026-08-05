import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertCircle, ArrowRight, Bug, CheckSquare, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card, CardContent, CardHeader, CardTitle,
} from "@/components/ui/card";
import { api } from "@/lib/api";
import type { APIResponse } from "@/types/auth";
import { useOrgsStore } from "@/store/orgs.store";
import { PRIORITY_META, type OpenTask } from "@/types/task";
import {
  PRIORITY_LABELS,
  STATUS_LABELS,
  normalizeStatus,
  type ReportListItem,
} from "@/types/report";

/**
 * What's still on the table, on the first screen of the app.
 *
 * Read-only and a shortcut, not a third place to work: every row goes to the
 * page that owns it. Duplicating the board or the report drawer here would
 * mean two implementations of the same editing rules.
 */

/** Worst first, so the top of the list is the part that matters. */
const REPORT_PRIORITY_RANK: Record<string, number> = {
  urgent: 0, high: 1, medium: 2, low: 3,
};

export default function PendingSummary() {
  const navigate = useNavigate();
  const orgId = useOrgsStore((s) => s.currentOrgId);
  const [tasks, setTasks] = useState<OpenTask[] | null>(null);
  const [reports, setReports] = useState<ReportListItem[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setTasks(null);
    setReports(null);
    setFailed(false);

    // Reports come back for the whole org and get narrowed here; tasks are
    // narrowed by the server, which is why only one of the two takes ?orgId.
    const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}&limit=8` : "?limit=8";
    void Promise.all([
      api.get<APIResponse<OpenTask[]>>(`/api/v1/tasks/${qs}`, true),
      api.get<APIResponse<{ items: ReportListItem[] }>>("/api/v1/reports/?limit=100", true),
    ])
      .then(([t, r]) => {
        if (cancelled) return;
        setTasks(t.success && t.data ? t.data : []);
        const open = (r.success && r.data ? r.data.items : [])
          .map((x) => ({ ...x, status: normalizeStatus(x.status) }))
          .filter((x) => x.status === "open" || x.status === "in_progress")
          .sort(
            (a, b) =>
              (REPORT_PRIORITY_RANK[a.priority] ?? 9) - (REPORT_PRIORITY_RANK[b.priority] ?? 9) ||
              +new Date(b.createdAt) - +new Date(a.createdAt),
          );
        setReports(open);
      })
      .catch(() => {
        if (cancelled) return;
        // Saying so beats an empty card that reads as "nothing pending" —
        // which is the one wrong answer this card can give.
        setFailed(true);
      });

    return () => { cancelled = true; };
  }, [orgId]);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <PendingCard
        title="Open reports"
        icon={Bug}
        count={reports?.length}
        failed={failed}
        onSeeAll={() => navigate("/reports")}
        empty="Nothing reported and unresolved."
      >
        {reports?.slice(0, 6).map((r) => (
          <Row
            key={r.id}
            onClick={() => navigate(`/reports?open=${r.id}`)}
            title={r.title}
            meta={`${r.folio} · ${r.projectName}`}
            right={
              <>
                <Badge variant="outline" className="py-0 text-[10px]">
                  {STATUS_LABELS[r.status]}
                </Badge>
                <span className="text-[10px] text-muted-foreground">
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
                <Badge variant="outline" className="py-0 text-[10px]">
                  {t.statusName}
                </Badge>
                <span className={`text-[10px] ${PRIORITY_META[t.priority]?.className ?? ""}`}>
                  {t.dueAt ? formatDue(t.dueAt) : PRIORITY_META[t.priority]?.label}
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
