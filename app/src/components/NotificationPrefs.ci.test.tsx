import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * El interruptor de la actividad de CI (R9).
 *
 * Como `workQuiet` y `meetingsQuiet`, se guarda **al revés** (`ciQuiet`), y
 * la pantalla le da la vuelta. Lo que se fija: que verlo encendido signifique
 * «avísame», que con `ciQuiet` ausente —preferencias guardadas por una app
 * anterior— salga encendido, y que apagarlo mande `ciQuiet: true`.
 */

const { savePrefs, prefs } = vi.hoisted(() => ({
  savePrefs: vi.fn(),
  prefs: { current: {} as Record<string, unknown> },
}));

vi.mock("@/store/inbox.store", () => ({
  useInboxStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) =>
      sel({ prefs: prefs.current, loadPrefs: vi.fn().mockResolvedValue(undefined), savePrefs }),
    { getState: () => ({ prefs: prefs.current, savePrefs }) },
  ),
}));
vi.mock("@/store/notifications.store", () => ({
  useNotificationsStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) => sel({ items: [], clear: vi.fn() }),
    { getState: () => ({ items: [], clear: vi.fn() }) },
  ),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const { default: NotificationPrefsDialog } = await import("@/components/NotificationPrefsDialog");

const SAVED_BY_AN_OLD_APP = {
  mentions: true, dms: true, comments: true, reports: true, messages: true,
  workQuiet: false, meetingsQuiet: false,
};

const open = () => render(<NotificationPrefsDialog open onOpenChange={() => {}} />);
const toggle = () => screen.getByText("CI & deploys").closest("button")!;
const isOn = () => toggle().getAttribute("aria-checked") === "true";

beforeEach(() => {
  savePrefs.mockResolvedValue(undefined);
  prefs.current = { ...SAVED_BY_AN_OLD_APP };
});
afterEach(cleanup);

describe("el interruptor de CI y deploys", () => {
  it("sin ciQuiet guardado (una app anterior) sale encendido", () => {
    open();
    expect(isOn()).toBe(true);
  });

  it("apagarlo guarda ciQuiet: true, y con ciQuiet: true se ve apagado", () => {
    open();
    fireEvent.click(toggle());
    expect(savePrefs).toHaveBeenCalledWith(expect.objectContaining({ ciQuiet: true }));
    cleanup();
    prefs.current = { ...SAVED_BY_AN_OLD_APP, ciQuiet: true };
    open();
    expect(isOn()).toBe(false);
  });
});
