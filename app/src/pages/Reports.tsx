import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { RefreshCw, ImageIcon, MessageSquare, Bug, Settings2, LayoutGrid, CalendarDays } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useReportsStore } from "@/store/reports.store";
import { useOrgsStore } from "@/store/orgs.store";
import ReportDetailDrawer from "@/components/ReportDetailDrawer";
import KanbanBoard from "@/components/kanban/KanbanBoard";
import ReportProjectsDialog from "@/components/ReportProjectsDialog";
import ReportsCalendar from "@/components/ReportsCalendar";
import {
  CATEGORY_LABELS,
  PRIORITY_LABELS,
  REPORT_STATUSES,
  STATUS_LABELS,
  type ReportListItem,
  type ReportStatus,
} from "@/types/report";

const STATUS_ACCENT: Record<ReportStatus, string> = {
  open: "border-t-warning",
  in_progress: "border-t-info",
  done: "border-t-success",
  closed: "border-t-muted-foreground/40",
};

// Column dot colours, from the theme tokens so both themes stay coherent.
const STATUS_DOT: Record<ReportStatus, string> = {
  open: "var(--warning)",
  in_progress: "var(--info)",
  done: "var(--success)",
  closed: "var(--muted-foreground)",
};

export default function Reports() {
  const currentOrgId = useOrgsStore((s) => s.currentOrgId);
  const projects = useReportsStore((s) => s.projects);
  const reports = useReportsStore((s) => s.reports);
  const loading = useReportsStore((s) => s.loading);
  const error = useReportsStore((s) => s.error);
  const projectFilter = useReportsStore((s) => s.projectFilter);
  const fetchProjects = useReportsStore((s) => s.fetchProjects);
  const fetchReports = useReportsStore((s) => s.fetchReports);
  const setProjectFilter = useReportsStore((s) => s.setProjectFilter);
  const categoryFilter = useReportsStore((s) => s.categoryFilter);
  const priorityFilter = useReportsStore((s) => s.priorityFilter);
  const setCategoryFilter = useReportsStore((s) => s.setCategoryFilter);
  const setPriorityFilter = useReportsStore((s) => s.setPriorityFilter);
  const taxonomy = useReportsStore((s) => s.taxonomy);
  const fetchTaxonomy = useReportsStore((s) => s.fetchTaxonomy);
  const openReport = useReportsStore((s) => s.openReport);
  const transitions = useReportsStore((s) => s.transitions);
  const fetchTransitions = useReportsStore((s) => s.fetchTransitions);
  const updateStatus = useReportsStore((s) => s.updateStatus);

  const [view, setView] = useState<"board" | "calendar">("board");

  useEffect(() => {
    // .catch: an unhandled rejection here used to leave the page silently blank.
    fetchProjects().then(fetchReports).catch(() => {});
    fetchTransitions();
    fetchTaxonomy();
  }, [currentOrgId, fetchProjects, fetchReports, fetchTransitions, fetchTaxonomy]);

  // ?open=<id> — how the dashboard's pending list gets you straight into a
  // report. Consumed once: without clearing it, closing the drawer and coming
  // back to this page would reopen the same report forever.
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    const id = params.get("open");
    if (!id) return;
    setParams({}, { replace: true });
    openReport(id).catch(() => {});
  }, [params, setParams, openReport]);

  // Reports are governed by a server-side state machine, so a drop is a
  // *transition request*: reject the ones the machine disallows instead of
  // letting the board show a move the backend would refuse. Unlike tasks there
  // is no manual ordering here, so neighbour ids are irrelevant.
  const handleMove = async (id: string, to: ReportStatus) => {
    const report = reports.find((r) => r.id === id);
    if (!report || report.status === to) return;

    const allowed = transitions?.[report.status] ?? [];
    if (!allowed.includes(to)) {
      toast.error("Invalid transition", {
        description: `${STATUS_LABELS[report.status]} → ${STATUS_LABELS[to]} is not allowed`,
      });
      return;
    }
    try {
      await updateStatus(id, to);
    } catch (err) {
      toast.error("Transition failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <div className="flex flex-col h-full">
      <header className="border-b px-6 py-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Bug className="h-5 w-5" />
          <span className="font-semibold text-lg">Reports</span>
          <span className="text-muted-foreground text-sm">
            {reports.length} in view
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border border-input overflow-hidden">
            <button
              onClick={() => setView("board")}
              className={`flex items-center gap-1 px-2.5 py-1.5 text-sm ${view === "board" ? "bg-accent" : "hover:bg-accent/50"}`}
            >
              <LayoutGrid className="h-4 w-4" /> Board
            </button>
            <button
              onClick={() => setView("calendar")}
              className={`flex items-center gap-1 px-2.5 py-1.5 text-sm border-l border-input ${view === "calendar" ? "bg-accent" : "hover:bg-accent/50"}`}
            >
              <CalendarDays className="h-4 w-4" /> Calendar
            </button>
          </div>
          <Select
            items={{
              all: "All projects",
              ...Object.fromEntries(projects.map((p) => [p.id, p.name])),
            }}
            value={projectFilter || "all"}
            onValueChange={(v) => v && setProjectFilter(v === "all" ? "" : v)}
          >
            <SelectTrigger size="sm" className="min-w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All projects</SelectItem>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <TaxonomyFilter
            label="All categories"
            value={categoryFilter}
            options={taxonomy?.categories ?? []}
            labels={CATEGORY_LABELS}
            onChange={setCategoryFilter}
          />
          <TaxonomyFilter
            label="All priorities"
            value={priorityFilter}
            options={taxonomy?.priorities ?? []}
            labels={PRIORITY_LABELS}
            onChange={setPriorityFilter}
          />
          <Button
            size="sm"
            variant="outline"
            onClick={fetchReports}
            disabled={loading}
            className="gap-2"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <ReportProjectsDialog
            trigger={
              <Button size="sm" variant="outline" className="gap-2">
                <Settings2 className="h-4 w-4" />
                Projects
              </Button>
            }
          />
        </div>
      </header>

      <main className="flex-1 overflow-x-auto p-4">
        {error && projects.length === 0 ? (
          <div className="py-12 text-center">
            <p className="text-sm text-error">Couldn't load reports: {error}</p>
            <Button
              size="sm"
              variant="outline"
              className="mt-3 gap-2"
              onClick={() => {
                fetchProjects().then(fetchReports).catch(() => {});
              }}
            >
              <RefreshCw className="h-4 w-4" />
              Retry
            </Button>
          </div>
        ) : projects.length === 0 ? (
          <p className="text-sm text-muted-foreground py-12 text-center">
            No report projects in this organization yet.
          </p>
        ) : view === "calendar" ? (
          <ReportsCalendar reports={reports} onOpen={openReport} />
        ) : (
          <KanbanBoard
            className="p-0"
            columns={REPORT_STATUSES.map((status) => ({
              id: status,
              title: STATUS_LABELS[status],
              color: STATUS_DOT[status],
            }))}
            items={reports.map((r) => ({ ...r, columnId: r.status }))}
            emptyColumnHint="—"
            onMove={({ itemId, toColumnId }) => handleMove(itemId, toColumnId as ReportStatus)}
            renderItem={(item) => (
              <ReportCard
                report={item}
                accent={STATUS_ACCENT[item.status]}
                onClick={() => openReport(item.id)}
              />
            )}
          />
        )}
      </main>

      <ReportDetailDrawer />
    </div>
  );
}

// Priority is the one label with an inherent order, so it gets colour; category
// and area are nominal and stay neutral.
const PRIORITY_CHIP: Record<string, string> = {
  low: "bg-muted text-muted-foreground",
  medium: "bg-muted text-muted-foreground",
  high: "bg-warning/15 text-warning border-warning/30",
  urgent: "bg-destructive/15 text-destructive border-destructive/30",
};

/** One "all X" dropdown, driven by whatever set the server published. */
function TaxonomyFilter<T extends string>({
  label,
  value,
  options,
  labels,
  onChange,
}: {
  label: string;
  value: T | "";
  options: T[];
  labels: Record<T, string>;
  onChange: (v: T | "") => void;
}) {
  if (options.length === 0) return null; // taxonomy not loaded yet
  return (
    <Select
      items={{ all: label, ...Object.fromEntries(options.map((o) => [o, labels[o]])) }}
      value={value || "all"}
      onValueChange={(v) => v && onChange(v === "all" ? "" : (v as T))}
    >
      <SelectTrigger size="sm" className="min-w-32">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{label}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o} value={o}>
            {labels[o]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ReportCard({
  report,
  accent,
  onClick,
}: {
  report: ReportListItem;
  accent: string;
  onClick: () => void;
}) {
  return (
    <Card
      onClick={onClick}
      className={`p-3 border-t-2 ${accent} space-y-2 cursor-pointer hover:bg-accent/40 transition-colors active:cursor-grabbing`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-mono text-muted-foreground">{report.folio}</span>
        {report.origin === "system" && (
          <Badge variant="outline" className="text-[10px] py-0">system</Badge>
        )}
      </div>
      <p className="text-sm font-medium leading-snug line-clamp-3">{report.title}</p>
      <div className="flex flex-wrap items-center gap-1">
        <Badge variant="outline" className="text-[10px] py-0">
          {CATEGORY_LABELS[report.category] ?? report.category}
        </Badge>
        {/* Medium is the default every report is born with, so showing it
            everywhere would be noise — only a deliberate priority is worth a chip. */}
        {report.priority && report.priority !== "medium" && (
          <Badge className={`text-[10px] py-0 ${PRIORITY_CHIP[report.priority] ?? ""}`}>
            {PRIORITY_LABELS[report.priority] ?? report.priority}
          </Badge>
        )}
        {report.area && (
          <Badge variant="secondary" className="text-[10px] py-0 max-w-[10rem] truncate">
            {report.area}
          </Badge>
        )}
      </div>
      {(report.reporterName || report.reporterEmail || report.reporterId) && (
        <p className="text-xs text-muted-foreground truncate">
          by {report.reporterName || report.reporterEmail || report.reporterId}
        </p>
      )}
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        {report.imageCount > 0 && (
          <span className="flex items-center gap-1">
            <ImageIcon className="h-3 w-3" />
            {report.imageCount}
          </span>
        )}
        {report.commentCount > 0 && (
          <span className="flex items-center gap-1">
            <MessageSquare className="h-3 w-3" />
            {report.commentCount}
          </span>
        )}
        {report.assigneeName && (
          <span className="ml-auto truncate max-w-[8rem]">{report.assigneeName}</span>
        )}
      </div>
    </Card>
  );
}
