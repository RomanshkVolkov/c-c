import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import DisclosureChevron from "@/components/ui/disclosure-chevron";

afterEach(cleanup);

describe("la flecha de algo que se despliega", () => {
  it("es la misma flecha, girada al abrirse y con muelle", () => {
    const { container, rerender } = render(<DisclosureChevron open={false} />);
    const svg = () => container.querySelector("svg")!;
    expect(svg().getAttribute("class")).not.toContain("rotate-90");
    expect(svg().getAttribute("class")).toContain("ease-(--ease-spring)");
    rerender(<DisclosureChevron open />);
    expect(svg().getAttribute("class")).toContain("rotate-90");
  });
});
