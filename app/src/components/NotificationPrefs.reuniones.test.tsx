import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * El interruptor de los recordatorios de reuniones.
 *
 * Se guarda **al revés** —`meetingsQuiet`— porque una columna nueva sobre filas
 * que ya existen nace en el cero de su tipo, y al derecho habría llegado
 * apagada justo para quien ya tenía preferencias guardadas. La pantalla le da
 * la vuelta para que el interruptor diga lo que hace.
 *
 * Eso es exactamente lo que se prueba aquí: que verlo encendido signifique
 * «avísame». Una inversión mal puesta es de los fallos que nadie reporta —
 * simplemente dejas de enterarte de las reuniones y crees que la función no
 * funciona.
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

const { default: NotificationPrefsDialog } = await import(
  "@/components/NotificationPrefsDialog"
);

const TODO_ENCENDIDO = {
  mentions: true, dms: true, comments: true, reports: true, messages: true,
  workQuiet: false, meetingsQuiet: false,
};

const abrir = () => render(<NotificationPrefsDialog open onOpenChange={() => {}} />);

/** El interruptor de las reuniones, por su etiqueta. */
const interruptor = () =>
  screen.getByText("Meeting reminders").closest("button")!;

/** Encendido según lo que anuncia, no según sus clases de CSS. */
const encendido = () => interruptor().getAttribute("aria-checked") === "true";

beforeEach(() => {
  savePrefs.mockResolvedValue(undefined);
  prefs.current = { ...TODO_ENCENDIDO };
});
afterEach(cleanup);

describe("el interruptor de las reuniones", () => {
  it("está en la lista, y dice qué hace", () => {
    abrir();
    expect(screen.getByText("Meeting reminders")).toBeTruthy();
    // Que suenan como una llamada no es un detalle: es la diferencia entre esto
    // y cualquier otro aviso de la lista.
    expect(document.body.textContent).toMatch(/ring/i);
  });

  // Lo que la inversión puede romper sin que nadie lo note.
  it("se ve encendido cuando NO están silenciadas", () => {
    prefs.current = { ...TODO_ENCENDIDO, meetingsQuiet: false };
    abrir();
    expect(encendido()).toBe(true);
  });

  it("y apagado cuando sí lo están", () => {
    prefs.current = { ...TODO_ENCENDIDO, meetingsQuiet: true };
    abrir();
    expect(encendido()).toBe(false);
  });

  it("apagarlo guarda que se silencian", async () => {
    prefs.current = { ...TODO_ENCENDIDO, meetingsQuiet: false };
    abrir();
    fireEvent.click(interruptor());
    await vi.waitFor(() => expect(savePrefs).toHaveBeenCalled());
    const guardado = savePrefs.mock.calls[0][0] as Record<string, unknown>;
    expect(guardado.meetingsQuiet).toBe(true);
  });

  // Tocar uno no puede mover otro: comparten el mismo mecanismo invertido.
  it("y no toca el de tu propio trabajo", async () => {
    prefs.current = { ...TODO_ENCENDIDO, workQuiet: true, meetingsQuiet: false };
    abrir();
    fireEvent.click(interruptor());
    await vi.waitFor(() => expect(savePrefs).toHaveBeenCalled());
    const guardado = savePrefs.mock.calls[0][0] as Record<string, unknown>;
    expect(guardado.workQuiet).toBe(true);
  });
});
