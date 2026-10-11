import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";

/**
 * «Canales | Directos» en el teléfono. Mutantes: no apuntar la sección (el
 * botón del menú volvería siempre al mismo sitio); cruzar las cuentas; marcar
 * la que no es; no cambiar al pulsar.
 */
vi.mock("@/hooks/use-comms-unread", () => ({ useCommsUnread: () => ({ channels: 4, dms: 1 }) }));

const { default: CommsSwitch } = await import("./CommsSwitch");
const { useLayoutStore } = await import("@/store/layout.store");

function Donde() {
  return <output data-testid="ruta">{useLocation().pathname}</output>;
}
afterEach(cleanup);

describe("el selector de Comunicación", () => {
  it("cada mitad con lo suyo sin leer, y apunta dónde estás", () => {
    useLayoutStore.setState({ comms: "/chat" });
    render(
      <MemoryRouter initialEntries={["/dm"]}>
        <CommsSwitch current="/dm" />
        <Donde />
      </MemoryRouter>,
    );
    const [canales, directos] = screen.getAllByRole("tab");
    expect(canales.textContent).toBe("Channels4");
    expect(directos.textContent).toBe("Direct1");
    expect(directos.getAttribute("aria-selected")).toBe("true");
    expect(canales.getAttribute("aria-selected")).toBe("false");
    expect(useLayoutStore.getState().comms).toBe("/dm");

    fireEvent.click(canales);
    expect(screen.getByTestId("ruta").textContent).toBe("/chat");
  });
});
