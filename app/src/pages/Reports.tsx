import { useEffect, useState } from "react";
import { RefreshCw, ImageIcon, MessageSquare, Bug, Settings2, LayoutGrid, CalendarDays } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useReportsStore } from "@/store/reports.store";
import { useOrgsStore } from "@/store/orgs.store";
import ReportDetailDrawer from "@/components/ReportDetailDrawer";
import ReportProjectsDialog from "@/components/ReportProjectsDialog";
import ReportsCalendar from "@/components/ReportsCalendar";
import {
  REPORT_STATUSES,
  STATUS_LABELS,
  type ReportListItem,
  type ReportStatus,
} from "@/types/report";

const STATUS_ACCENT: Record<ReportStatus, string> = {
  pending: "border-t-amber-500",
  in_progress: "border-t-blue-500",
  resolved: "border-t-emerald-500",
  closed: "border-t-muted-foreground/40",
};

export default function Reports() {
  const currentOrgId = useOrgsStore((s) => s.currentOrgId);
  const projects = useReportsStore((s) => s.projects);
  const reports = useReportsStore((s) => s.reports);
  const loading = useReportsStore((s) => s.loading);
  const projectFilter = useReportsStore((s) => s.projectFilter);
  const fetchProjects = useReportsStore((s) => s.fetchProjects);
  const fetchReports = useReportsStore((s) => s.fetchReports);
  const setProjectFilter = useReportsStore((s) => s.setProjectFilter);
  const openReport = useReportsStore((s) => s.openReport);
  const transitions = useReportsStore((s) => s.transitions);
  const fetchTransitions = useReportsStore((s) => s.fetchTransitions);
  const updateStatus = useReportsStore((s) => s.updateStatus);

  const [dragOver, setDragOver] = useState<ReportStatus | null>(null);
  const [view, setView] = useState<"board" | "calendar">("board");

  useEffect(() => {
    fetchProjects().then(fetchReports);
    fetchTransitions();
  }, [currentOrgId, fetchProjects, fetchReports, fetchTransitions]);

  const byStatus = (status: ReportStatus) =>
    reports.filter((r) => r.status === status);

  // Drop a card onto a column → transition, if the state machine allows it.
  const handleDrop = async (e: React.DragEvent, to: ReportStatus) => {
    e.preventDefault();
    setDragOver(null);
    let dragged: { id: string; status: ReportStatus };
    try {
      dragged = JSON.parse(e.dataTransfer.getData("application/json"));
    } catch {
      return;
    }
    if (dragged.status === to) return;
    const allowed = transitions?.[dragged.status] ?? [];
    if (!allowed.includes(to)) {
      toast.error("Invalid transition", {
        description: `${dragged.status} → ${to} is not allowed`,
      });
      return;
    }
    try {
      await updateStatus(dragged.id, to);
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
          <select
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            className="rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          >
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
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
        {projects.length === 0 ? (
          <p className="text-sm text-muted-foreground py-12 text-center">
            No report projects in this organization yet.
          </p>
        ) : view === "calendar" ? (
          <ReportsCalendar reports={reports} onOpen={openReport} />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 min-h-full">
            {REPORT_STATUSES.map((status) => {
              const items = byStatus(status);
              return (
                <div
                  key={status}
                  className={`flex flex-col gap-3 rounded-lg p-1 transition-colors ${
                    dragOver === status ? "bg-accent/60 ring-2 ring-primary/40" : ""
                  }`}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(status);
                  }}
                  onDragLeave={() => setDragOver((s) => (s === status ? null : s))}
                  onDrop={(e) => handleDrop(e, status)}
                >
                  <div className="flex items-center justify-between px-1">
                    <span className="text-sm font-medium">
                      {STATUS_LABELS[status]}
                    </span>
                    <Badge variant="secondary">{items.length}</Badge>
                  </div>
                  <div className="flex flex-col gap-2">
                    {items.map((r) => (
                      <ReportCard key={r.id} report={r} accent={STATUS_ACCENT[status]} onClick={() => openReport(r.id)} />
                    ))}
                    {items.length === 0 && (
                      <p className="text-xs text-muted-foreground px-1 py-6 text-center">
                        —
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>

      <ReportDetailDrawer />
    </div>
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
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData(
          "application/json",
          JSON.stringify({ id: report.id, status: report.status })
        );
      }}
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
