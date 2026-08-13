import { describe, expect, it } from "vitest";

// Being told about your own actions.
//
// Every console in the organization hears the same event stream. The events say
// which *side* caused them — "team", "reporter", "project:slug" — which is
// enough for a tenant deciding whether it caused its own webhook, and not enough
// for us: "team" is equally true for the person who just typed the comment and
// for everyone else in the room.
//
// So an event names the person, and a console ignores its own. The screen still
// refreshes; what stops is the announcement.

type Payload = { actorId?: string; from?: string };

/** The rule, as the hook applies it. */
const mine = (p: Payload, sessionId?: string) =>
  Boolean(p.actorId) && p.actorId === sessionId;

/** How a reply is described, from the side that sent it. */
const describeReply = (from?: string) =>
  from === "reporter"
    ? "The reporter replied"
    : from?.startsWith("project:")
      ? "The client's app replied"
      : "Someone on the team replied";

describe("not announcing your own actions", () => {
  it("ignores an event this console caused", () => {
    expect(mine({ actorId: "u-me" }, "u-me")).toBe(true);
  });

  it("still announces a colleague's, though both are 'team'", () => {
    expect(mine({ actorId: "u-someone-else" }, "u-me")).toBe(false);
  });

  it("announces anything with no actor — a reporter, a tenant's app", () => {
    expect(mine({ from: "reporter" }, "u-me")).toBe(false);
    expect(mine({ from: "project:portento" }, "u-me")).toBe(false);
  });

  it("announces when there is no session rather than swallowing it", () => {
    // Silence would be the wrong failure: a notification you didn't need is a
    // nuisance, one you never got is a reply nobody answered.
    expect(mine({ actorId: "u-me" }, undefined)).toBe(false);
  });
});

describe("saying who actually replied", () => {
  // The message used to be "A reporter replied" for every one of these, which
  // made two of the three wrong.
  it("names the reporter", () => {
    expect(describeReply("reporter")).toBe("The reporter replied");
  });
  it("names the client's app", () => {
    expect(describeReply("project:portento")).toBe("The client's app replied");
  });
  it("names the team", () => {
    expect(describeReply("team")).toBe("Someone on the team replied");
  });
});
