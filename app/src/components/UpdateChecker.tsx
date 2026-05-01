import { useEffect } from "react";
import { Download, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUpdaterStore } from "@/store/updater.store";

export default function UpdateChecker() {
  const available = useUpdaterStore((s) => s.available);
  const downloading = useUpdaterStore((s) => s.downloading);
  const progress = useUpdaterStore((s) => s.progress);
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
        {downloading ? "Updating..." : "Install & Restart"}
      </Button>
    </div>
  );
}
