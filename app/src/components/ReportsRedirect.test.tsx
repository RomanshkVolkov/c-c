import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useSearchParams } from "react-router-dom";
import ReportsRedirect from "./ReportsRedirect";

// Retiring a window is easy; retiring it without breaking what already points
// at it is the part worth testing. Every notification cac has recorded stores a
// /reports link, and the inbox renders them as buttons — deleting the route
// would turn all of that history into dead clicks, with no error to notice.

function at(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/reports" element={<ReportsRedirect />} />
        <Route path="/tasks" element={<Landed />} />
      </Routes>
    </MemoryRouter>,
  );
}

function Landed() {
  // Read through the router: MemoryRouter never touches window.location, so
  // asking the browser would report the test runner's own url instead.
  const [params] = useSearchParams();
  return <div data-testid="landed">{params.get("task") ?? "board"}</div>;
}

afterEach(cleanup);

describe("the retired reports route", () => {
  it("opens the very card a stored notification was about", () => {
    at("/reports?open=6d097e12-fc43-461a-8773-c5b176b13716");
    // The exact id, not a search for it: a report's id *is* the item's id,
    // because the two are one row.
    expect(screen.getByTestId("landed").textContent).toBe(
      "6d097e12-fc43-461a-8773-c5b176b13716",
    );
  });

  it("accepts the older ?report= spelling too", () => {
    at("/reports?report=abc-123");
    expect(screen.getByTestId("landed").textContent).toBe("abc-123");
  });

  it("still lands somewhere useful with no id at all", () => {
    at("/reports");
    expect(screen.getByTestId("landed").textContent).toBe("board");
  });
});
