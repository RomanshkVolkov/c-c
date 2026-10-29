import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * Al escribir una decisión se puede decir ya a qué se aplica
 * (command-and-control-91). Sin enlaces, el borrador no los menciona: así un
 * backend de antes recibe lo de siempre.
 */

const store = {
  searchDocSections: vi.fn(async () => [
    { id: "s9", heading: "Volver atrás", level: 2, tab: "runbook", ownerKind: "list", ownerId: "L1", ownerName: "Backend" },
  ]),
};
vi.mock("@/store/tasks.store", () => ({
  useTasksStore: (sel: (s: typeof store) => unknown) => sel(store),
}));
vi.mock("@/lib/api", () => ({ api: { get: vi.fn(async () => ({ data: { tasks: [] } })) } }));

const { default: DecisionForm } = await import("@/components/docs/DecisionForm");

afterEach(cleanup);

const write = (title: string) =>
  fireEvent.change(screen.getByLabelText(/Qué se decidió|What was decided/), { target: { value: title } });
const save = () => fireEvent.click(screen.getByText(/^(Registrarla|Record it)$/));

describe("los enlaces al escribir una decisión", () => {
  it("lo elegido va con la decisión", async () => {
    const onSubmit = vi.fn(async () => {});
    render(<DecisionForm open onOpenChange={() => {}} onSubmit={onSubmit} orgId="org-1" />);
    write("Se vuelve atrás con rollout undo");
    fireEvent.click(screen.getByText(/^(Enlazar|Link)$/));
    fireEvent.click(await screen.findByLabelText(/Backend › Runbook › Volver atrás/));
    fireEvent.click(screen.getAllByText(/^(Enlazar|Link)$/).slice(-1)[0]);
    await waitFor(() => expect(screen.getByTestId("draft-links").textContent).toContain("Volver atrás"));
    save();
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        title: "Se vuelve atrás con rollout undo", body: "", tag: "", taskIds: [], sectionIds: ["s9"],
      }),
    );
  });

  it("sin enlaces, el borrador es el de siempre", async () => {
    const onSubmit = vi.fn(async () => {});
    render(<DecisionForm open onOpenChange={() => {}} onSubmit={onSubmit} orgId="org-1" />);
    write("x");
    save();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ title: "x", body: "", tag: "" }));
  });

  it("sin organización no se ofrece enlazar", () => {
    render(<DecisionForm open onOpenChange={() => {}} onSubmit={async () => {}} />);
    expect(screen.queryByTestId("draft-links")).toBeNull();
  });
});
