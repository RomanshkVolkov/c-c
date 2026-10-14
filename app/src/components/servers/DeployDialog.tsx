import { useT } from "@/lib/i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import DeployPanel from "./DeployPanel";
import type { Server } from "@/types/server";
import type { SwarmService } from "@/types/swarm";

/**
 * Desplegar un servicio, rápido: registrarlo, desplegar un commit, el
 * historial y su log. La configuración (de dónde sale, rama y build, secrets,
 * migraciones) vive en la página «Despliegue» del servidor; aquí hay un enlace
 * a ella. Ver DeployPanel.
 */
export default function DeployDialog({
  server,
  service,
  open,
  onOpenChange,
  onOpenActivity,
  onConfigure,
  full = false,
}: {
  server: Server;
  service: SwarmService;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /**
   * Ir a la actividad de CI de este servicio (R9). Lo navega quien monta el
   * diálogo: el diálogo no sabe de rutas, y así se prueba sin un router.
   */
  onOpenActivity?: (deployableId: string, orgId: string) => void;
  /** Ir a la página «Despliegue» del servicio. */
  onConfigure?: () => void;
  /** Con toda la configuración, como la página (lo usan las pruebas). */
  full?: boolean;
}) {
  const { t } = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("common:deploy.title", { name: service.name })}</DialogTitle>
        </DialogHeader>
        <DeployPanel
          server={server}
          service={service}
          active={open}
          full={full}
          onOpenActivity={
            onOpenActivity &&
            ((id, org) => {
              onOpenChange(false);
              onOpenActivity(id, org);
            })
          }
          onConfigure={
            onConfigure &&
            (() => {
              onOpenChange(false);
              onConfigure();
            })
          }
        />
      </DialogContent>
    </Dialog>
  );
}
