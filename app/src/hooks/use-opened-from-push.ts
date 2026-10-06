import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useInboxStore } from "@/store/inbox.store";

/**
 * Se entró pulsando un aviso del teléfono (W2): marcar leída esa fila.
 *
 * El service worker abre la app con `?notif=<id>` porque él no tiene la sesión
 * para marcarla. Aquí se marca, y el parámetro se quita de la dirección para
 * que recargar o compartir el enlace no vuelva a hacerlo — y para que la
 * pantalla de destino vea su enlace limpio, como si viniera de la campana.
 */
export function useOpenedFromPush(): void {
  const { pathname, search, hash } = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const params = new URLSearchParams(search);
    const id = params.get("notif");
    if (!id) return;
    void useInboxStore.getState().markRead([id]).catch(() => {});
    params.delete("notif");
    const rest = params.toString();
    navigate(`${pathname}${rest ? `?${rest}` : ""}${hash}`, { replace: true });
  }, [pathname, search, hash, navigate]);
}
