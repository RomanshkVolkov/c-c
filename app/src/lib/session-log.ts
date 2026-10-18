import { isTauri } from "@/lib/platform";

/**
 * Diario temporal de la sesión (#175): tras actualizar, algo presentaba un
 * token de refresco ya rotado hace 46 minutos y el backend cerraba la sesión
 * por robo. Para saber qué, cada refresco apunta su ventana, el id del token
 * que tiene en memoria y el del que hay guardado en disco. Sólo los 8 primeros
 * caracteres del id (`token_id`, el mismo que guarda la base): solos no sirven
 * de credencial. Se quita al cerrar #175.
 */

/** Los 8 primeros caracteres del `token_id` de un JWT, o "-". */
export function tokenId8(jwt: string | null | undefined): string {
  if (!jwt) return "-";
  try {
    const part = jwt.split(".")[1] ?? "";
    const json = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))) as { token_id?: string };
    return (json.token_id ?? "").slice(0, 8) || "?";
  } catch {
    return "?";
  }
}

/** El refresco que está guardado en disco ahora mismo (lo que leería otra ventana). */
export function storedRefresh(): string | null {
  try {
    const raw = localStorage.getItem("cac-auth");
    return raw ? ((JSON.parse(raw) as { state?: { refreshToken?: string } }).state?.refreshToken ?? null) : null;
  } catch {
    return null;
  }
}

export function sessionLog(line: string): void {
  if (!isTauri) return;
  void (async () => {
    try {
      const [{ invoke }, { getCurrentWindow }] = await Promise.all([
        import("@tauri-apps/api/core"),
        import("@tauri-apps/api/window"),
      ]);
      await invoke("session_log", { line: `win=${getCurrentWindow().label} ${line}` });
    } catch {
      // Un diario que no se escribe no puede romper un refresco.
    }
  })();
}
