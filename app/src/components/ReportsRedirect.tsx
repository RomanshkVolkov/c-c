import { Navigate, useSearchParams } from "react-router-dom";

/**
 * `/reports` is gone; this keeps every link to it working.
 *
 * The window was retired once the board could show everything a report carries.
 * Deleting the route with it would have broken links that are already out
 * there: every notification cac has ever recorded stores one
 * (`/reports?open=<id>`), and the inbox renders them as buttons that would then
 * do nothing.
 *
 * The translation is exact rather than approximate — a report's id *is* the
 * item's id, since the two were merged into one row — so the card that opens is
 * the same thing the notification was about, not a search for it.
 */
export default function ReportsRedirect() {
  const [params] = useSearchParams();
  // Both spellings: `open` is what the notification panel wrote, `report` is
  // what older deep links used.
  const id = params.get("open") || params.get("report");
  return <Navigate to={id ? `/tasks?task=${id}` : "/tasks"} replace />;
}
