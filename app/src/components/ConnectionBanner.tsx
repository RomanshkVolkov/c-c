import { useEffect, useState } from "react";
import { WifiOff, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConnectionStore, selectDegraded } from "@/store/connection.store";

/** How long the live stream may stay down before we surface it. */
const STREAM_GRACE_MS = 45_000;

function ago(ts: number | null): string {
  if (!ts) return "never";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

/**
 * Shown when the backend link is degraded. Before this, a failed call left an
 * empty screen with no explanation — which looks exactly like a frozen app, so
 * the only apparent fix was restarting it. Now the failure is visible and the
 * user can retry (reloading the webview re-runs every initial fetch and
 * reopens the SSE stream on a fresh socket) without killing the process.
 */
export default function ConnectionBanner() {
  // Primitive selectors only: markOk() runs on every successful request, so
  // subscribing to the whole store would re-render the shell constantly.
  const failing = useConnectionStore(selectDegraded);
  const stream = useConnectionStore((s) => s.stream);
  const [streamStale, setStreamStale] = useState(false);
  const [, tick] = useState(0);

  // A stream that stays down while requests still succeed is the quiet failure
  // mode: no error anywhere, but nothing updates by itself again. Reconnects are
  // normal and fast, so only a *sustained* outage is worth reporting.
  useEffect(() => {
    if (stream === "open" || stream === "idle") {
      setStreamStale(false);
      return;
    }
    const t = setTimeout(() => setStreamStale(true), STREAM_GRACE_MS);
    return () => clearTimeout(t);
  }, [stream]);

  const degraded = failing || streamStale;

  // Re-render while degraded so the "last response" age keeps counting up.
  useEffect(() => {
    if (!degraded) return;
    const t = setInterval(() => tick((n) => n + 1), 5_000);
    return () => clearInterval(t);
  }, [degraded]);

  if (!degraded) return null;
  const { failures, lastError, lastOkAt } = useConnectionStore.getState();

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-error/30 bg-error/10 px-4 py-2 text-sm">
      <WifiOff className="h-4 w-4 shrink-0 text-error" />
      <span className="font-medium text-error">
        {failing ? "Connection problems" : "Live updates stopped"}
      </span>
      <span className="text-muted-foreground">
        {failing
          ? `${lastError ?? "Requests are failing"} · ${failures} failed · last response ${ago(lastOkAt)}`
          : `The event stream is ${stream}; the board won't refresh on its own`}
      </span>
      <Button
        size="sm"
        variant="outline"
        className="ml-auto h-7"
        onClick={() => window.location.reload()}
      >
        <RefreshCw className="mr-1 h-3.5 w-3.5" />
        Reconnect
      </Button>
    </div>
  );
}
