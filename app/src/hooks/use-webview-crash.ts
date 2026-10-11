import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";

import { fileCrash, signature } from "@/lib/file-crash";
import { useT } from "@/lib/i18n";
import { isTauri } from "@/lib/platform";

export interface WebviewCrash {
  reason: string;
  url: string;
  atMs: number;
  count: number;
}

/**
 * La ruta sin ids: la misma caída en otro canal o en otra tarea es el mismo
 * fallo, y tiene que ser la misma tarjeta (ver `signature`).
 */
export function rutaSinIds(url: string): string {
  const ruta = url.includes("#") ? url.slice(url.indexOf("#")) : url.replace(/^[a-z]+:\/\/[^/]+/i, "");
  return ruta
    .replace(/[?].*$/, "")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id")
    .replace(/\/\d+(?=\/|$)/g, "/:n");
}

/**
 * Si la página vuelve de que se muriera su proceso, ficharlo en cac y decirlo.
 *
 * Esto no lo puede cazar el `ErrorBoundary`: cuando el proceso web aborta, la
 * página muere con su JS. Lo apunta Rust, que recarga, y aquí se recoge
 * (`webview_crash.rs`). Rust lo entrega una sola vez, así que otra recarga no
 * lo vuelve a mandar; y la clave es el motivo con la ruta sin ids, así que
 * veinte caídas por lo mismo son una tarjeta.
 */
export function useWebviewCrash(authed: boolean) {
  const { t } = useT();
  useEffect(() => {
    if (!isTauri || !authed) return;
    void invoke<WebviewCrash | null>("take_webview_crash")
      .then((c) => {
        if (!c) return;
        toast.warning(t("common:last.webviewRecovered"));
        const ruta = rutaSinIds(c.url);
        return fileCrash({
          title: `Desktop web process died (${c.reason}) at ${ruta}`,
          description: [
            `WebKitWebProcess terminated: \`${c.reason}\`.`,
            `Route: \`${ruta}\``,
            `At: ${new Date(c.atMs).toISOString()}`,
            `Deaths in the last minute: ${c.count}`,
            "",
            "The trace is in `coredumpctl list` and `journalctl --user` on that machine.",
          ].join("\n"),
          key: signature(`webview:${c.reason}:${ruta}`),
        });
      })
      .catch(() => {});
  }, [authed, t]);
}
