import { Channel, invoke } from "@tauri-apps/api/core";

import type { DeviceList, MicReading, Reattach, VoiceEngine, VoiceEvent } from "./types";

/**
 * El motor de escritorio: LiveKit en Rust, dentro del proceso de Tauri.
 *
 * Aquí no hay lógica, y es a propósito: son las mismas órdenes que el store
 * mandaba antes directamente, movidas tal cual. Lo que se decide —qué es
 * optimista, qué se reintenta, qué se enseña— sigue en el store, que es lo que
 * se prueba sin un navegador de verdad.
 */
export const tauriEngine: VoiceEngine = {
  async join({ url, token, meta, onEvent }) {
    const canal = new Channel<VoiceEvent>();
    canal.onmessage = onEvent;
    return invoke<string>("voice_join", { url, token, onEvent: canal, meta });
  },
  async attach(onEvent) {
    const canal = new Channel<VoiceEvent>();
    canal.onmessage = onEvent;
    return invoke<Reattach | null>("voice_attach", { onEvent: canal });
  },
  leave: () => invoke("voice_leave"),
  setMic: (enabled) => invoke("voice_set_mic", { enabled }),
  setDeaf: (enabled) => invoke("voice_set_deaf", { enabled }),
  setCamera: (enabled) => invoke("voice_set_camera", { enabled }),
  screenSources: () => invoke<{ id: string; title: string }[]>("voice_screen_sources"),
  shareScreen: (sourceId) => invoke("voice_share_screen", { sourceId }),
  stopShare: () => invoke("voice_stop_share"),
  canShareScreen: () => true,
  listDevices: () => invoke<DeviceList>("voice_list_devices"),
  setDevice: (kind, deviceId) => invoke("voice_set_device", { kind, deviceId }),
  micLevel: () => invoke<MicReading>("voice_mic_level"),
};
