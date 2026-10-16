import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * El resumen de una llamada en el canal. Mutantes: no esperar a la llamada y
 * no enseñar nada mientras carga; perder el botón de la grabación o ponerlo
 * sin grabación; contar mal la duración.
 */
const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { get }, apiUrl: (p: string) => p }));
vi.mock("@/components/markdown/Markdown", () => ({ default: ({ children }: { children: string }) => <p>{children}</p> }));

const { default: CallSummaryCard, callLength } = await import("./CallSummaryCard");
const { callIdInBody, callIdFromHref } = await import("@/components/markdown/card-menu");

const ID = "0f3c1a2b-4d5e-6f70-8192-a3b4c5d6e7f8";
const BODY = `Call ended · 12 min · 2 people — [details](cac:call/${ID}).`;
const llamada = (extra: Record<string, unknown> = {}) => ({
  data: {
    id: ID, startedAt: "2026-10-15T18:00:00Z", endedAt: "2026-10-15T18:12:00Z", durationMs: 12 * 60_000,
    participants: [
      { identity: "u-ana", name: "Ana", guest: false, firstJoinedAt: "" },
      { identity: "guest:g1", name: "Cliente", guest: true, firstJoinedAt: "" },
    ],
    ...extra,
  },
});

afterEach(cleanup);

describe("el resumen de una llamada", () => {
  it("mientras carga se lee la frase del servidor, y luego la tarjeta", async () => {
    get.mockResolvedValue(llamada());
    render(<CallSummaryCard sessionId={ID} body={BODY} onOpenRecording={() => {}} onInternalLink={() => true} />);
    expect(screen.getByText(BODY)).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Call ended")).toBeTruthy());
    expect(get).toHaveBeenCalledWith(`/api/v1/call-sessions/${ID}`, true);
    expect(screen.getByText(/2 people: Ana, Cliente/)).toBeTruthy();
    expect(screen.getByText(/12 min/)).toBeTruthy();
    expect(screen.queryByText("Watch the recording")).toBeNull();
  });

  it("con grabación, la abre", async () => {
    get.mockResolvedValue(llamada({ recordingId: "11111111-aaaa-4aaa-8aaa-111111111111" }));
    const abrir = vi.fn();
    render(<CallSummaryCard sessionId={ID} body={BODY} onOpenRecording={abrir} onInternalLink={() => true} />);
    fireEvent.click(await screen.findByText("Watch the recording"));
    expect(abrir).toHaveBeenCalled();
  });

  it("si no carga, se queda la frase", async () => {
    get.mockRejectedValue(new Error("x"));
    render(<CallSummaryCard sessionId={ID} body={BODY} onOpenRecording={() => {}} onInternalLink={() => true} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByText(BODY)).toBeTruthy();
  });
});

describe("leer el resumen", () => {
  it("encuentra la llamada en el cuerpo y en el enlace, sólo con un uuid", () => {
    expect(callIdInBody(BODY)).toBe(ID);
    expect(callIdInBody("The recording of this call is ready — [watch it](cac:recording/" + ID + ").")).toBeNull();
    expect(callIdFromHref(`cac:call/${ID}`)).toBe(ID);
    expect(callIdFromHref("cac:call/../x")).toBeNull();
  });

  it("dice la duración como el servidor", () => {
    expect(callLength(45_000)).toBe("45 s");
    expect(callLength(12 * 60_000 + 20_000)).toBe("12 min");
    expect(callLength(12 * 60_000 + 40_000)).toBe("13 min");
    expect(callLength(65 * 60_000)).toBe("1 h 05 min");
    expect(callLength(0)).toBe("");
  });
});

// «Ver chat»: sólo si hubo chat, y de sólo lectura. Mutantes: ofrecerlo sin
// mensajes; no pedir el chat de esa llamada.
describe("ver el chat de una llamada", () => {
  it("con mensajes se ofrece, y abre lo que se dijo", async () => {
    get.mockImplementation(async (url: string) =>
      url.endsWith("/messages")
        ? { data: [{ id: "m1", sessionId: ID, authorName: "Bea", body: "el enlace", createdAt: "2026-10-15T18:05:00Z" }] }
        : llamada({ messages: 1 }),
    );
    render(<CallSummaryCard sessionId={ID} body={BODY} onOpenRecording={() => {}} onInternalLink={() => true} />);
    fireEvent.click(await screen.findByText("View chat (1)"));
    expect(await screen.findByText("el enlace")).toBeTruthy();
    expect(get).toHaveBeenCalledWith(`/api/v1/call-sessions/${ID}/messages`, true);
    expect(screen.queryByPlaceholderText("Message the call")).toBeNull();
  });

  it("sin mensajes no se ofrece, aunque haya grabación", async () => {
    get.mockResolvedValue(llamada({ messages: 0, recordingId: "11111111-aaaa-4aaa-8aaa-111111111111" }));
    render(<CallSummaryCard sessionId={ID} body={BODY} onOpenRecording={() => {}} onInternalLink={() => true} />);
    await screen.findByText("Call ended");
    expect(screen.queryByText(/View chat/)).toBeNull();
  });
});
