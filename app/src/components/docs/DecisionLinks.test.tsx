import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import type { Decision } from "@/types/task";

/**
 * A qué se aplica una decisión, en su entrada del registro
 * (command-and-control-91).
 */

const store = {
  openTask: vi.fn(async () => {}),
  linkDecision: vi.fn(async () => {}),
  unlinkDecision: vi.fn(async () => {}),
  searchDocSections: vi.fn(async () => [
    { id: "s9", heading: "Volver atrás", level: 2, tab: "runbook", ownerKind: "list", ownerId: "L1", ownerName: "Backend" },
  ]),
};
vi.mock("@/store/tasks.store", () => ({
  useTasksStore: (sel: (s: typeof store) => unknown) => sel(store),
}));
let answer = true;
vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => async () => answer }));
vi.mock("@/lib/api", () => ({ api: { get: vi.fn(async () => ({ data: { tasks: [] } })) } }));

const { default: DecisionLinks } = await import("@/components/docs/DecisionLinks");

const decision = (links: Decision["links"]): Decision => ({
  id: "d1", docId: "doc", title: "x", body: "", authorId: "u", decidedAt: "", origin: "doc", links,
});

function Where() {
  const l = useLocation();
  return <output data-testid="at">{l.pathname + l.search}</output>;
}

const show = (d: Decision) =>
  render(
    <MemoryRouter>
      <Routes>
        <Route path="*" element={<><DecisionLinks decision={d} orgId="org-1" /><Where /></>} />
      </Routes>
    </MemoryRouter>,
  );

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  answer = true;
});

describe("los enlaces de una decisión", () => {
  const links: Decision["links"] = [
    { id: "l1", kind: "task", taskId: "t1", taskRef: "cc-12", taskTitle: "Login", addedAt: "" },
    { id: "l2", kind: "section", sectionId: "s1", heading: "Desplegar", tab: "runbook", ownerKind: "list", ownerId: "L1", addedAt: "" },
    { id: "l3", kind: "section", sectionId: "s2", heading: "Volver atrás", sectionRemoved: true, tab: "runbook", ownerKind: "list", ownerId: "L1", addedAt: "" },
  ];

  it("una tarea abre su cajón y una sección lleva a ella", () => {
    show(decision(links));
    fireEvent.click(screen.getByText("cc-12 Login"));
    expect(store.openTask).toHaveBeenCalledWith("t1");
    fireEvent.click(screen.getByText("Desplegar"));
    expect(screen.getByTestId("at").textContent).toBe("/tasks?doc=list:L1&tab=runbook&section=s1");
  });

  it("una sección que ya no está sale tachada con el título que tenía", () => {
    show(decision(links));
    const gone = screen.getByText(/Volver atrás/).closest("[data-removed]");
    expect(gone?.getAttribute("data-removed")).toBe("true");
    expect(gone?.textContent).toMatch(/ya no está|no longer/);
  });

  it("quitar un enlace pregunta antes, y si se dice que no, no se quita", async () => {
    show(decision(links));
    answer = false;
    fireEvent.click(screen.getAllByLabelText(/Quitar el enlace|Remove the link/)[0]);
    await new Promise((r) => setTimeout(r, 0));
    expect(store.unlinkDecision).not.toHaveBeenCalled();
    answer = true;
    fireEvent.click(screen.getAllByLabelText(/Quitar el enlace|Remove the link/)[0]);
    await waitFor(() => expect(store.unlinkDecision).toHaveBeenCalledWith("d1", "l1"));
  });

  it("enlazar manda lo elegido, separado en tareas y secciones", async () => {
    show(decision([]));
    fireEvent.click(screen.getByText(/^(Enlazar|Link)$/));
    fireEvent.click(await screen.findByLabelText(/Backend › Runbook › Volver atrás/));
    fireEvent.click(screen.getAllByText(/^(Enlazar|Link)$/).slice(-1)[0]);
    await waitFor(() => expect(store.linkDecision).toHaveBeenCalledWith("d1", { taskIds: [], sectionIds: ["s9"] }));
  });

  it("con un backend que no manda enlaces no se ofrece nada", () => {
    const { container } = render(<DecisionLinks decision={decision(undefined)} orgId="org-1" />);
    expect(container.textContent).toBe("");
  });
});
