import { beforeEach, describe, expect, it } from "vitest";

import { MIN_GAP_MS, playNotifySound, resetNotifySound, toneFor } from "@/lib/notify-sound";
import { useAudioPrefs } from "@/store/audio-prefs.store";
import { useVoice } from "@/store/voice.store";

/**
 * Cuándo suena un aviso. Sin `AudioContext` en jsdom no se oye nada; lo que se
 * prueba es la decisión, que es lo que se puede equivocar.
 */
beforeEach(() => {
  resetNotifySound();
  useAudioPrefs.setState({ notifySound: true });
  useVoice.setState({ spaceId: null, meetId: null, sordo: false });
});

describe("el tono de un aviso", () => {
  // Rotura que detecta: que la llamada o la daily suenen dos veces (su timbre
  // y este), o que un mensaje suene como todo lo demás.
  it("cada aviso con su tono, y lo que ya tiene timbre no suena aquí", () => {
    expect(toneFor("chat:message")).toBe("drop");
    expect(toneFor("dm:message")).toBe("drop");
    expect(toneFor("chat:mention")).toBe("twoNotes");
    expect(toneFor("report:new")).toBe("twoNotes");
    expect(toneFor("voice.ring")).toBeNull();
    expect(toneFor("meeting:reminder")).toBeNull();
  });

  // Rotura que detecta: sonar con el interruptor apagado.
  it("apagado en este equipo, no suena", () => {
    useAudioPrefs.setState({ notifySound: false });
    expect(playNotifySound("chat:mention", 10_000)).toBe(false);
  });

  // Roturas que detectan: sonar encima de las voces de una llamada o de una
  // reunión con invitados, o a quien se puso sordo.
  it("en una llamada, en una reunión o sordo, no suena", () => {
    useVoice.setState({ spaceId: "s" });
    expect(playNotifySound("chat:mention", 10_000)).toBe(false);
    useVoice.setState({ spaceId: null, meetId: "meet:1" });
    expect(playNotifySound("chat:mention", 20_000)).toBe(false);
    useVoice.setState({ meetId: null, sordo: true });
    expect(playNotifySound("chat:mention", 30_000)).toBe(false);
    useVoice.setState({ sordo: false });
    expect(playNotifySound("chat:mention", 40_000)).toBe(true);
  });

  // Rotura que detecta: diez avisos seguidos, diez tonos.
  it("una ráfaga suena una vez", () => {
    expect(playNotifySound("chat:message", 10_000)).toBe(true);
    expect(playNotifySound("chat:message", 10_000 + MIN_GAP_MS - 1)).toBe(false);
    expect(playNotifySound("chat:message", 10_000 + MIN_GAP_MS)).toBe(true);
  });
});
