import { invoke } from "@tauri-apps/api/core";
import { relaunch as tauriRelaunch } from "@tauri-apps/plugin-process";

/**
 * Relanza la app. Pasa por el comando propio (`src-tauri/src/relaunch.rs`), que
 * lanza la AppImage nueva sin las variables que apuntan al montaje de la vieja:
 * con ellas el `AppRun` moría al arrancar y tras actualizar no volvía nadie. Si
 * el comando no está (un binario viejo que aún no lo trae), el de Tauri.
 */
export async function relaunchApp(): Promise<void> {
  try {
    await invoke("relaunch_app");
  } catch {
    await tauriRelaunch();
  }
}
