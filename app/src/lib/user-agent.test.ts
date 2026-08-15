import { describe, expect, it } from "vitest";
import { describeAgent } from "./user-agent";

// The point of this line on screen is one fact: what were they using when it
// broke. "It only happens on a phone" is often the whole diagnosis, and it is
// invisible inside 140 characters of Mozilla/5.0 boilerplate.
describe("describeAgent", () => {
  it("names the phone a real report came from", () => {
    // portento-97, verbatim from production.
    expect(
      describeAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 " +
          "(KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("iPhone · Safari");
  });

  it("does not call Chrome Safari, though Chrome says it is", () => {
    // Every Chrome UA ends in "Safari/537.36". Checking in the wrong order
    // labels the whole desktop web as Safari.
    expect(
      describeAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
      ),
    ).toBe("Mac · Chrome");
  });

  it("does not call Edge Chrome, though Edge says it is", () => {
    expect(
      describeAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
      ),
    ).toBe("Windows · Edge");
  });

  it("returns something it doesn't recognise unchanged, rather than guessing", () => {
    expect(describeAgent("curl/8.4.0")).toBe("curl/8.4.0");
  });

  it("says nothing when there is nothing to say", () => {
    expect(describeAgent("   ")).toBe("");
  });
});
