import { invoke } from "@tauri-apps/api/core";
import { sendNotification } from "@tauri-apps/plugin-notification";

import { isTauri } from "@/lib/platform";

/**
 * Un aviso del sistema, firmado por cac y con su logo.
 *
 * En el escritorio va por `desktop_notify` (ver `src-tauri/src/notify.rs`): en
 * Linux el plugin no deja poner ni el nombre ni el icono, y el aviso salía
 * firmado «app» —el nombre del binario dentro de la AppImage— y sin logo. En
 * la web sigue el plugin, que ahí es la API de notificaciones del navegador.
 */
export async function showDesktopNotification(n: { title: string; body: string }): Promise<void> {
  if (isTauri) {
    await invoke("desktop_notify", { title: n.title, body: n.body });
    return;
  }
  await Promise.resolve(sendNotification(n));
}
