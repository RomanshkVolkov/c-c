import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * Naming things in the tree instead of in a dialog.
 *
 * The behaviour worth pinning down is that **creating leaves the row open**:
 * people make lists in runs, and reopening a modal between each one was most of
 * what made the old flow tiring. Renaming closes, because there is no next one.
 *
 * Driven with `fireEvent` rather than `user-event`, which isn't a dependency of
 * this project — a test is not a reason to add one.
 */

const { default: InlineName } = await import("@/components/tree/InlineName");

afterEach(cleanup);

const caja = () => screen.getByRole("textbox") as HTMLInputElement;
const escribir = (texto: string) => fireEvent.change(caja(), { target: { value: texto } });
const enter = () => fireEvent.keyDown(caja(), { key: "Enter" });

describe("nombrar en línea", () => {
  it("al crear, Enter guarda y deja la fila lista para la siguiente", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<InlineName mode="create" placeholder="New list" onSubmit={onSubmit} onClose={onClose} />);

    escribir("Pendientes");
    enter();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("Pendientes"));
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(caja().value).toBe(""));

    escribir("En curso");
    enter();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(onSubmit).toHaveBeenLastCalledWith("En curso");
  });

  it("al renombrar, Enter guarda y cierra", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<InlineName mode="rename" defaultValue="Viejo" onSubmit={onSubmit} onClose={onClose} />);
    escribir("Nuevo");
    enter();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("Nuevo"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("renombrar sin cambiar nada no molesta al servidor", async () => {
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    render(<InlineName mode="rename" defaultValue="Igual" onSubmit={onSubmit} onClose={onClose} />);
    enter();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("Escape cierra sin guardar", () => {
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    render(<InlineName mode="create" onSubmit={onSubmit} onClose={onClose} />);
    escribir("algo");
    fireEvent.keyDown(caja(), { key: "Escape" });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("si el servidor rechaza, no se borra lo escrito", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("nombre repetido"));
    render(<InlineName mode="create" onSubmit={onSubmit} onClose={() => {}} />);
    escribir("Repetido");
    enter();
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    // Lo contrario obligaría a reescribir un nombre que el servidor nunca aceptó.
    expect(caja().value).toBe("Repetido");
  });

  it("un nombre vacío no llega al servidor", () => {
    const onSubmit = vi.fn();
    render(<InlineName mode="create" onSubmit={onSubmit} onClose={() => {}} />);
    escribir("   ");
    enter();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
