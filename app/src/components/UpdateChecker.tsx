import { useEffect } from "react";
import { AlertCircle, Download, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUpdaterStore } from "@/store/updater.store";

export default function UpdateChecker() {
  const available = useUpdaterStore((s) => s.available);
  const downloading = useUpdaterStore((s) => s.downloading);
  const progress = useUpdaterStore((s) => s.progress);
  const downloaded = useUpdaterStore((s) => s.downloaded);
  const total = useUpdaterStore((s) => s.total);
  const lastError = useUpdaterStore((s) => s.lastError);
  const dismissedVersion = useUpdaterStore((s) => s.dismissedVersion);
  const checkForUpdate = useUpdaterStore((s) => s.checkForUpdate);
  const installUpdate = useUpdaterStore((s) => s.installUpdate);
  const dismiss = useUpdaterStore((s) => s.dismiss);

  useEffect(() => {
    checkForUpdate({ silent: true });
    const interval = setInterval(
      () => checkForUpdate({ silent: true }),
      1000 * 60 * 30,
    );
    return () => clearInterval(interval);
  }, [checkForUpdate]);

  if (!available) return null;
  if (dismissedVersion === available.version && !downloading) return null;

  const pct = total ? Math.min(100, (downloaded / total) * 100) : null;

  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-sm bg-card border rounded-lg shadow-lg p-4 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Download className="h-4 w-4 text-primary shrink-0" />
          <span className="text-sm font-medium">
            v{available.version} available
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 shrink-0"
          onClick={dismiss}
          disabled={downloading}
        >
          <X className="h-3 w-3" />
        </Button>
      </div>

      {available.body && (
        <p className="text-xs text-muted-foreground line-clamp-3">
          {available.body}
        </p>
      )}

      {progress && (
        <p className="text-xs text-muted-foreground font-mono">{progress}</p>
      )}

      {/* A plain div rather than a new dependency: this is a filled rectangle.
          Indeterminate until the server declares a size, because a bar sitting
          at zero would say "nothing is happening" about a download that is. */}
      {downloading && (
        <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={
              pct === null
                ? "h-full w-1/3 animate-pulse bg-primary"
                : "h-full bg-primary transition-all duration-300"
            }
            style={pct === null ? undefined : { width: `${pct}%` }}
          />
        </div>
      )}

      {/* Failures used to be swallowed: the panel simply went back to offering
          the update, saying nothing about why the last try didn't take. On
          Linux this is where "the updater only replaces an AppImage" finally
          gets to say so out loud. */}
      {lastError && !downloading && (
        <p className="flex items-start gap-1.5 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="break-words">{lastError}</span>
        </p>
      )}

      <Button
        size="sm"
        onClick={installUpdate}
        disabled={downloading}
        className="w-full"
      >
        {downloading ? (
          <RefreshCw className="h-3 w-3 mr-1 animate-spin" />
        ) : (
          <Download className="h-3 w-3 mr-1" />
        )}
        {downloading
          ? "Updating..."
          : lastError
            ? "Retry"
            : "Install & Restart"}
      </Button>
    </div>
  );
}
