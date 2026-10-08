import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { Activity, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import DeviceList from "@/components/diagnostics/DeviceList";
import DeviceSheet from "@/components/diagnostics/DeviceSheet";
import Timeline from "@/components/diagnostics/Timeline";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useTelemetryStore } from "@/store/telemetry.store";

/**
 * Diagnóstico: la telemetría pasiva de las apps de los clientes.
 *
 * A la izquierda los dispositivos; a la derecha la ficha del elegido (lo que va
 * mal, sus latidos, su estado) y su timeline. Un aviso del vigilante enlaza
 * aquí con `?project=&device=`, y se abre ese dispositivo.
 */
export default function Diagnostics() {
  const { t } = useT();
  const [params] = useSearchParams();
  const loading = useTelemetryStore((s) => s.loadingDevices);
  const selected = useTelemetryStore((s) => s.selected);
  const detail = useTelemetryStore((s) => s.detail);
  const detailError = useTelemetryStore((s) => s.detailError);
  const fetchDevices = useTelemetryStore((s) => s.fetchDevices);
  const select = useTelemetryStore((s) => s.select);

  useEffect(() => {
    void fetchDevices();
  }, [fetchDevices]);

  const projectId = params.get("project");
  const deviceId = params.get("device");
  useEffect(() => {
    if (!projectId || !deviceId) return;
    const cur = useTelemetryStore.getState().selected;
    if (cur?.projectId === projectId && cur?.deviceId === deviceId) return;
    void select({ projectId, deviceId });
  }, [projectId, deviceId, select]);

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-80 shrink-0 flex-col border-r bg-muted/10">
        <header className="flex h-12 shrink-0 items-center justify-between border-b px-3">
          <span className="flex items-center gap-2 text-sm font-medium">
            <Activity className="size-4" /> {t("diagnostics:title")}
          </span>
          <Button
            size="icon-xs"
            variant="ghost"
            title={t("common:last.refresh")}
            disabled={loading}
            onClick={() => void fetchDevices()}
          >
            <RefreshCw className={cn("size-3", loading && "animate-spin")} />
          </Button>
        </header>
        <DeviceList />
      </aside>

      <div className="min-h-0 flex-1 overflow-auto">
        {!selected ? (
          <div className="flex h-full items-center justify-center p-4">
            <p className="text-sm text-muted-foreground">{t("diagnostics:pick")}</p>
          </div>
        ) : (
          <div className="mx-auto w-full max-w-4xl space-y-6 p-4">
            <DeviceSheet detail={detail} error={detailError} />
            <Timeline />
          </div>
        )}
      </div>
    </div>
  );
}
