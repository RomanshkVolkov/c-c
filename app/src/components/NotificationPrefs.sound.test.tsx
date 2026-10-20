import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * El interruptor del sonido: es de este equipo, no va al servidor, y al
 * encenderlo suena para que se oiga qué se encendió.
 */
const { savePrefs, playTone } = vi.hoisted(() => ({ savePrefs: vi.fn(), playTone: vi.fn() }));

vi.mock("@/store/inbox.store", () => ({
  useInboxStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) =>
      sel({ prefs: null, loadPrefs: vi.fn().mockResolvedValue(undefined), savePrefs }),
    { getState: () => ({ prefs: null, savePrefs }) },
  ),
}));
vi.mock("@/store/notifications.store", () => ({
  useNotificationsStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) => sel({ items: [], clear: vi.fn() }),
    { getState: () => ({ items: [], clear: vi.fn() }) },
  ),
}));
vi.mock("@/lib/notify-sound", () => ({ playTone }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const { default: NotificationPrefsDialog } = await import("@/components/NotificationPrefsDialog");
const { useAudioPrefs } = await import("@/store/audio-prefs.store");

afterEach(cleanup);

describe("el sonido de los avisos", () => {
  // Roturas que detectan: guardarlo en el servidor, no guardarlo, o no
  // sonar al encenderlo (o sonar al apagarlo).
  it("se guarda en este equipo, y al encenderlo suena", () => {
    useAudioPrefs.setState({ notifySound: true });
    render(<NotificationPrefsDialog open onOpenChange={() => {}} />);
    const sw = screen.getByText("Notification sound").closest("button")!;
    expect(sw.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(sw);
    expect(useAudioPrefs.getState().notifySound).toBe(false);
    expect(playTone).not.toHaveBeenCalled();

    fireEvent.click(sw);
    expect(useAudioPrefs.getState().notifySound).toBe(true);
    expect(playTone).toHaveBeenCalledWith("twoNotes");
    expect(savePrefs).not.toHaveBeenCalled();
  });
});
