import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * Elegir micrófono y cámara.
 *
 * Existe porque el sistema se equivoca a menudo y no había forma de corregirlo
 * desde dentro de la llamada. Lo que se comprueba es que la lista diga **cuál
 * está puesto** —sin eso no es un selector, es una lista— y que elegir mande la
 * orden con el identificador correcto.
 */

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { default: Ajustes } = await import("./DeviceSettings");

const lista = {
  mics: [
    { id: "alsa:0", name: "Micrófono del portátil", current: true },
    { id: "alsa:1", name: "Auriculares USB", current: false },
  ],
  cams: [{ id: "Integrated Webcam", name: "Integrated Webcam", current: true }],
};

beforeEach(() => {
  invoke.mockImplementation((cmd: string) =>
    cmd === "voice_list_devices" ? Promise.resolve(lista) : Promise.resolve(),
  );
});
afterEach(cleanup);

describe("los ajustes de dispositivos", () => {
  it("dice cuál está puesto, no sólo cuáles hay", async () => {
    render(<Ajustes />);
    const puesto = await screen.findByText("Micrófono del portátil");
    // `aria-current` y no sólo un color: el que está puesto es la única
    // información que convierte una lista en un selector.
    expect(puesto.closest("button")!.getAttribute("aria-current")).toBe("true");
    expect(screen.getByText("Auriculares USB").closest("button")!.getAttribute("aria-current"))
      .toBe("false");
  });

  it("elegir manda el identificador, no el nombre visible", async () => {
    render(<Ajustes />);
    fireEvent.click(await screen.findByText("Auriculares USB"));
    // El nombre cambia de idioma y de formato; el id de cpal es estable entre
    // reinicios y es lo que se guarda.
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("voice_set_device", { kind: "mic", deviceId: "alsa:1" }),
    );
  });

  it("no deja volver a elegir el que ya está puesto", async () => {
    render(<Ajustes />);
    const puesto = await screen.findByText("Integrated Webcam");
    expect((puesto.closest("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("si no hay cámara lo dice con palabras", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === "voice_list_devices" ? Promise.resolve({ ...lista, cams: [] }) : Promise.resolve(),
    );
    render(<Ajustes />);
    // Una sección vacía sin más se lee como que la app no terminó de cargar.
    expect(await screen.findByText("No camera found")).toBeTruthy();
  });

  it("si el motor no contesta, se dice en vez de quedarse cargando", async () => {
    invoke.mockRejectedValue(new Error("no estás en ninguna sala"));
    render(<Ajustes />);
    expect(await screen.findByText(/no estás en ninguna sala/)).toBeTruthy();
  });
});
