import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * Ending an organization is typed out in full.
 *
 * A yes/no dialog gets answered by reflex — people confirm the thing they meant
 * and the thing they did not with the same click, and this one takes the
 * spaces, the tasks and the channels with it. Typing the name is the step that
 * cannot be completed while thinking about something else.
 */

const { default: DeleteOrgDialog } = await import("@/components/org/DeleteOrgDialog");

afterEach(cleanup);

const montar = (onConfirm = vi.fn().mockResolvedValue(undefined)) => {
  render(
    <DeleteOrgDialog open onOpenChange={() => {}} orgName="Nuke AI" onConfirm={onConfirm} />,
  );
  return onConfirm;
};

const escribir = (t: string) =>
  fireEvent.change(screen.getByLabelText("Confirmation"), { target: { value: t } });
// `toBeDisabled` es de jest-dom, que no es dependencia de este proyecto.
const boton = () => screen.getByRole("button", { name: "Delete it" }) as HTMLButtonElement;

describe("borrar una organización", () => {
  it("empieza bloqueado", () => {
    montar();
    expect(boton().disabled).toBe(true);
  });

  it("no se conforma con el nombre a secas", () => {
    montar();
    escribir("Nuke AI");
    expect(boton().disabled).toBe(true);
  });

  it("ni con una aproximación", () => {
    montar();
    // Una confirmación que se pasa por aproximación dejó de confirmar.
    escribir("delete/nuke ai");
    expect(boton().disabled).toBe(true);
  });

  it("y se desbloquea con la frase exacta", async () => {
    const onConfirm = montar();
    escribir("delete/Nuke AI");
    expect(boton().disabled).toBe(false);
    fireEvent.click(boton());
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
  });
});
