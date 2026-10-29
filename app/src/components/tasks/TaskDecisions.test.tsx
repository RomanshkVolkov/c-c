import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import TaskDecisions from "@/components/tasks/TaskDecisions";
import SectionDecisionsMark from "@/components/docs/SectionDecisionsMark";

/**
 * Las decisiones de una tarea, y la marca de las de una sección
 * (command-and-control-91).
 */

afterEach(cleanup);

function Where() {
  const l = useLocation();
  return <output data-testid="at">{l.pathname + l.search}</output>;
}

describe("las decisiones de una tarea", () => {
  it("una sustituida sigue, tachada, y cada una lleva a su registro", () => {
    render(
      <MemoryRouter>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <TaskDecisions
                  decisions={[
                    { id: "d2", title: "Nueva", decidedAt: "2026-10-29T00:00:00Z", ownerKind: "space", ownerId: "S" },
                    { id: "d1", title: "Vieja", decidedAt: "2026-10-01T00:00:00Z", ownerKind: "space", ownerId: "S", supersededById: "d2" },
                  ]}
                />
                <Where />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText("Vieja").closest("button")?.getAttribute("data-superseded")).toBe("true");
    expect(screen.getByText("Nueva").closest("button")?.getAttribute("data-superseded")).toBeNull();
    fireEvent.click(screen.getByText("Nueva"));
    expect(screen.getByTestId("at").textContent).toBe("/tasks?doc=space:S&tab=decisions");
  });

  it("sin ninguna no pinta nada, ni pide el enrutador", () => {
    const { container } = render(<TaskDecisions decisions={[]} />);
    expect(container.textContent).toBe("");
  });
});

describe("la marca de una sección", () => {
  it("dice cuántas la sostienen", () => {
    render(
      <MemoryRouter>
        <SectionDecisionsMark section={{ id: "s", heading: "x", level: 2, index: 0, decisions: [{ id: "a", title: "A", decidedAt: "" }, { id: "b", title: "B", decidedAt: "" }] }} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("section-decisions").textContent).toBe("2");
  });

  it("sin decisiones no hay marca", () => {
    const { container } = render(<SectionDecisionsMark section={{ id: "s", heading: "x", level: 2, index: 0 }} />);
    expect(container.textContent).toBe("");
  });
});
