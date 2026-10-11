import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Las preferencias de audio de quien usa la app, entre llamadas y arranques.
 *
 * Hoy sólo una: si se procesa la voz (supresión de ruido y control de
 * ganancia). Encendida por defecto; se apaga para música o un instrumento,
 * que el supresor confunde con ruido. Se manda al motor antes de cada llamada
 * (`voice.store`) y al cambiarla (`DeviceSettings`).
 */
interface AudioPrefs {
  noiseSuppression: boolean;
  setNoiseSuppression: (on: boolean) => void;
}

export const useAudioPrefs = create<AudioPrefs>()(
  persist(
    (set) => ({
      noiseSuppression: true,
      setNoiseSuppression: (on) => set({ noiseSuppression: on }),
    }),
    { name: "cac-audio-prefs" },
  ),
);
