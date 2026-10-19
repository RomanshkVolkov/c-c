import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import VoiceControls from "@/components/voice/VoiceControls";

/**
 * Los mandos de una llamada en una ventana estrecha (un teléfono, o media
 * pantalla de un monitor vertical): ocho botones redondos no cabían, se
 * cortaban por los dos lados y colgar se salía (18-oct-2026). Quedan los de
 * siempre y lo demás en «⋯».
 */

const wide = window.innerWidth;
beforeEach(() => Object.defineProperty(window, "innerWidth", { configurable: true, value: 480 }));
afterEach(() => {
  cleanup();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: wide });
});

const props = {
  mic: true,
  deafened: false,
  cam: false,
  sharing: false,
  onMic: () => {},
  onDeafen: () => {},
  onCam: () => {},
  onShare: vi.fn(),
  onSettings: () => {},
  onLeave: vi.fn(),
};

describe("los mandos en una ventana estrecha", () => {
  it("micrófono, cámara, audio, «⋯» y colgar; nada más a la vista", () => {
    render(<VoiceControls {...props} />);
    expect(screen.getAllByRole("button")).toHaveLength(5);
    expect(screen.getByRole("button", { name: "More options" })).toBeTruthy();
    // Lo que va en «⋯» no está a la vista.
    expect(screen.queryByRole("button", { name: /Share/ })).toBeNull();
  });

  it("lo demás, en «⋯»", async () => {
    render(<VoiceControls {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Share/ }));
    expect(props.onShare).toHaveBeenCalled();
  });

  it("colgar es redondo y sin texto, para que quepa", () => {
    render(<VoiceControls {...props} />);
    const leave = screen.getByRole("button", { name: "Leave the call" });
    expect(leave.textContent).toBe("");
    fireEvent.click(leave);
    expect(props.onLeave).toHaveBeenCalled();
  });
});

/**
 * El botón de ajustes es el que abre su panel: va marcado para que pulsarlo no
 * cuente como «fuera» (`useDismiss`) y el panel no se cierre y reabra a la vez.
 */
describe("el botón de ajustes", () => {
  it("es el que abre el panel, no algo de fuera", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
    render(<VoiceControls {...props} />);
    expect(screen.getByRole("button", { name: "Audio and video settings" }).getAttribute("data-toggles")).toBe(
      "device-settings",
    );
  });
});
