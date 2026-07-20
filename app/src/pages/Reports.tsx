import { useEffect } from "react";
import { RefreshCw, ImageIcon, MessageSquare, Bug, Settings2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useReportsStore } from "@/store/reports.store";
import { useOrgsStore } from "@/store/orgs.store";
import ReportDetailDrawer from "@/components/ReportDetailDrawer";
import ReportProjectsDialog from "@/components/ReportProjectsDialog";
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

  useEffect(() => {
    fetchProjects().then(fetchReports);
  }, [currentOrgId, fetchProjects, fetchReports]);

  const byStatus = (status: ReportStatus) =>
    reports.filter((r) => r.status === status);

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
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 min-h-full">
            {REPORT_STATUSES.map((status) => {
              const items = byStatus(status);
              return (
                <div key={status} className="flex flex-col gap-3">
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
      onClick={onClick}
      className={`p-3 border-t-2 ${accent} space-y-2 cursor-pointer hover:bg-accent/40 transition-colors`}
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
