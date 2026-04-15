import { useState, useEffect, useCallback } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { Download, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function UpdateChecker() {
  const [updateAvailable, setUpdateAvailable] = useState<{
    version: string;
    body: string;
  } | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const checkForUpdate = useCallback(async () => {
    try {
      const update = await check();
      if (update) {
        setUpdateAvailable({
          version: update.version,
          body: update.body ?? "",
        });
      }
    } catch {
      // silent fail on check
    }
  }, []);

  useEffect(() => {
    checkForUpdate();
    const interval = setInterval(checkForUpdate, 1000 * 60 * 30);
    return () => clearInterval(interval);
  }, [checkForUpdate]);

  const installUpdate = async () => {
    setDownloading(true);
    setProgress("Downloading...");
    try {
      const update = await check();
      if (!update) return;

      await update.downloadAndInstall((event) => {
        if (event.event === "Started" && event.data.contentLength) {
          setProgress(`0 / ${(event.data.contentLength / 1024 / 1024).toFixed(1)} MB`);
        } else if (event.event === "Progress") {
          setProgress(`Downloading... ${(event.data.chunkLength / 1024).toFixed(0)} KB`);
        } else if (event.event === "Finished") {
          setProgress("Restarting...");
        }
      });

      await relaunch();
    } catch (e) {
      setProgress(`Error: ${e}`);
      setDownloading(false);
    }
  };

  if (!updateAvailable || dismissed) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-sm bg-card border rounded-lg shadow-lg p-4 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Download className="h-4 w-4 text-primary shrink-0" />
          <span className="text-sm font-medium">
            v{updateAvailable.version} available
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 shrink-0"
          onClick={() => setDismissed(true)}
          disabled={downloading}
        >
          <X className="h-3 w-3" />
        </Button>
      </div>

      {updateAvailable.body && (
        <p className="text-xs text-muted-foreground line-clamp-3">
          {updateAvailable.body}
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
