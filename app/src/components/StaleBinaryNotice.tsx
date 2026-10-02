import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { RotateCw } from "lucide-react";
import { useT } from "@/lib/i18n";
import { Button } from "@/components/ui/button";

/**
 * Un aviso fijo cuando esta ventana es de una copia de cac que ya no existe.
 *
 * Pasa cuando se actualiza con otra instancia abierta: la nueva arranca bien,
 * pero la vieja sigue corriendo desde un ejecutable que el actualizador ya
 * borró. Funciona para casi todo, y 1Password le corta al instante
 * (`InvalidClientInfo`): cargar un `op://` falla con un error que no dice por
 * qué, y ni `op signin` lo arregla. Reabrir la app, sí.
 *
 * Se comprueba al montar y cada vez que la ventana vuelve a tener el foco, que
 * es cuando alguien viene a usarla.
 */
export default function StaleBinaryNotice() {
  const { t } = useT();
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const check = () =>
      void invoke<boolean>("binary_replaced")
        .then((v) => setStale(v === true))
        .catch(() => {});
    check();
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, []);

  if (!stale) return null;

  return (
    <div
      role="alert"
      className="fixed bottom-4 left-1/2 z-50 flex max-w-lg -translate-x-1/2 items-center gap-3 rounded-lg border border-warning/50 bg-card p-3 text-sm shadow-lg"
    >
      <p className="min-w-0 flex-1">{t("common:stale.body")}</p>
      <Button size="sm" onClick={() => void relaunch()}>
        <RotateCw className="mr-1 size-3.5" />
        {t("common:stale.restart")}
      </Button>
    </div>
  );
}
