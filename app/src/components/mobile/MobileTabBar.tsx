import { useEffect, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Inbox, Menu, MessagesSquare } from "lucide-react";

import MoreSheet from "@/components/mobile/MoreSheet";
import VoiceMini from "@/components/voice/VoiceMini";
import { useCommsUnread } from "@/hooks/use-comms-unread";
import { useIsMobile } from "@/hooks/use-mobile";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/store/auth.store";
import { useDMStore } from "@/store/dm.store";
import { useLayoutStore } from "@/store/layout.store";
import { useMyWorkStore } from "@/store/mywork.store";

/**
 * El menú de abajo del teléfono: Mi trabajo, Comunicación y Más.
 *
 * Sustituye a la hamburguesa (11-oct-2026, a petición de jose): un cajón
 * lateral esconde dónde estás y obliga a dos toques para ir a cualquier sitio;
 * tres botones al alcance del pulgar dicen las dos cosas de un vistazo.
 *
 * - **Dentro de la columna, no flotando encima** (lo monta `AppLayout` debajo
 *   del contenido): así el redactor de un chat y el final de una lista suben
 *   solos en vez de quedar tapados.
 * - **Se esconde en una conversación abierta**, como en cualquier mensajería:
 *   la flecha de volver devuelve a la lista con el menú. Y cuando sale el
 *   teclado en cualquier otra pantalla, que si no se come la mitad del sitio.
 * - Respeta la zona segura de abajo del iPhone (`viewport-fit=cover` en
 *   `index.html`).
 */
export default function MobileTabBar() {
  const { t } = useT();
  const movil = useIsMobile();
  const authed = useAuthStore((s) => !!s.accessToken);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const dmAbierto = useDMStore((s) => !!s.conversationId);
  const comms = useLayoutStore((s) => s.comms);
  const setScope = useMyWorkStore((s) => s.setScope);
  const { channels, dms } = useCommsUnread();
  const teclado = useTecladoAbierto();
  const [mas, setMas] = useState(false);

  // Navegar cierra la hoja: lo que se pidió ya está en pantalla.
  useEffect(() => setMas(false), [pathname]);

  if (!movil || !authed) return null;

  const enComms = pathname.startsWith("/chat") || pathname.startsWith("/dm");
  const enConversacion =
    (pathname.startsWith("/chat") && params.has("space")) || (pathname.startsWith("/dm") && dmAbierto);
  if (enConversacion || teclado) return null;

  const activo = pathname.startsWith("/my-work") ? "work" : enComms ? "comms" : "more";
  const sinLeer = channels + dms;

  return (
    <>
      {/* La llamada en curso, encima del menú: en el escritorio vive al pie
          de la barra lateral, que en el teléfono ya no se abre. */}
      <div className="shrink-0 px-2 empty:hidden">
        <VoiceMini />
      </div>
      <nav
        aria-label={t("nav:mobile.label")}
        data-testid="mobile-tab-bar"
        className="flex shrink-0 border-t bg-background pb-[env(safe-area-inset-bottom)]"
      >
        <Tab
          activo={activo === "work"}
          icono={<Inbox className="size-5" />}
          texto={t("nav:mobile.myWork")}
          onClick={() => {
            // Como la fila de la barra lateral: entrar por aquí es «mi
            // trabajo» entero, sin el filtro de la última lista.
            setScope(null);
            navigate("/my-work");
          }}
        />
        <Tab
          activo={activo === "comms"}
          icono={<MessagesSquare className="size-5" />}
          texto={t("nav:mobile.comms")}
          badge={sinLeer}
          onClick={() => navigate(comms)}
        />
        <Tab
          activo={activo === "more" || mas}
          icono={<Menu className="size-5" />}
          texto={t("nav:mobile.more")}
          onClick={() => setMas(true)}
        />
      </nav>
      <MoreSheet open={mas} onOpenChange={setMas} />
    </>
  );
}

function Tab({
  activo,
  icono,
  texto,
  badge = 0,
  onClick,
}: {
  activo: boolean;
  icono: React.ReactNode;
  texto: string;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={activo ? "page" : undefined}
      className={cn(
        "relative flex h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium",
        activo ? "text-primary" : "text-muted-foreground",
      )}
    >
      <span className="relative">
        {icono}
        {badge > 0 && (
          <span
            data-testid="tab-badge"
            className="absolute -right-2.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] text-primary-foreground"
          >
            {badge > 99 ? "99+" : badge}
          </span>
        )}
      </span>
      {texto}
    </button>
  );
}

/**
 * Si el teclado del teléfono está fuera. No hay evento para eso: se deduce de
 * que la parte visible (`visualViewport`) sea bastante más baja que la ventana.
 * 150px es menos que cualquier teclado y más que la barra del navegador
 * apareciendo o desapareciendo al hacer scroll.
 */
function useTecladoAbierto(): boolean {
  const [abierto, setAbierto] = useState(false);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const medir = () => setAbierto(window.innerHeight - vv.height > 150);
    medir();
    vv.addEventListener("resize", medir);
    return () => vv.removeEventListener("resize", medir);
  }, []);
  return abierto;
}
