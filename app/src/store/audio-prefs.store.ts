import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Las preferencias de audio de quien usa la app, entre llamadas y arranques.
 *
 * Si se procesa la voz (supresión de ruido y control de ganancia). Encendida
 * por defecto; se apaga para música o un instrumento, que el supresor
 * confunde con ruido. Se manda al motor antes de cada llamada (`voice.store`)
 * y al cambiarla (`DeviceSettings`).
 *
 * Y si los avisos suenan (`lib/notify-sound.ts`). Es de este equipo y no de la
 * cuenta: el portátil de la oficina puede callarse sin callar el de casa.
 */
interface AudioPrefs {
  noiseSuppression: boolean;
  setNoiseSuppression: (on: boolean) => void;
  notifySound: boolean;
  setNotifySound: (on: boolean) => void;
}

export const useAudioPrefs = create<AudioPrefs>()(
  persist(
    (set) => ({
      noiseSuppression: true,
      setNoiseSuppression: (on) => set({ noiseSuppression: on }),
      notifySound: true,
      setNotifySound: (on) => set({ notifySound: on }),
    }),
    { name: "cac-audio-prefs" },
  ),
);
