import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * El panel de chat de la llamada: «Llamada» y «Canal», cada una donde le
 * toca. Mutantes: empezar en «Canal»; enseñar «Llamada» sin llamada guardada;
 * mandar lo escrito en «Llamada» al canal; ofrecer retirar lo de otro.
 */
const { get, post, del } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), del: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { get, post, patch: vi.fn(), delete: del }, apiUrl: (p: string) => p }));
vi.mock("@/components/voice/VoiceChat", () => ({
  default: () => <p>hilo del canal</p>,
  LinkifiedText: ({ text }: { text: string }) => <>{text}</>,
}));

const { default: CallChatPanel } = await import("./CallChatPanel");
const { useAuthStore } = await import("@/store/auth.store");
const { useCallChat } = await import("@/store/call-chat.store");

const msgs = [
  { id: "m1", sessionId: "cs-1", authorUserId: "u-bea", authorName: "Bea", body: "hola", createdAt: "2026-10-16T10:00:00Z" },
  { id: "m2", sessionId: "cs-1", authorUserId: "u-yo", authorName: "Yo", body: "lo mío", createdAt: "2026-10-16T10:01:00Z" },
];

beforeEach(() => {
  get.mockReset().mockResolvedValue({ data: msgs });
  post.mockReset().mockResolvedValue({ data: {} });
  del.mockReset().mockResolvedValue({});
  useCallChat.getState().reset();
  useAuthStore.setState({ session: { id: "u-yo", username: "yo" }, accessToken: "t" } as never);
});
afterEach(cleanup);

const mount = (sessionId: string | null, spaceId: string | null) =>
  render(<CallChatPanel sessionId={sessionId} spaceId={spaceId} spaceName="pixel" onClose={() => {}} />);

describe("el panel de chat de la llamada", () => {
  it("empieza en la llamada, y el canal está a una pestaña", async () => {
    mount("cs-1", "esp-1");
    expect(screen.getByRole("tab", { name: "Call" }).getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByText("hola")).toBeTruthy();
    expect(get).toHaveBeenCalledWith("/api/v1/call-sessions/cs-1/messages", true);
    fireEvent.click(screen.getByRole("tab", { name: "Channel chat" }));
    expect(screen.getByText("hilo del canal")).toBeTruthy();
  });

  it("sin llamada guardada, sólo el canal; sin canal, sólo la llamada", () => {
    mount(null, "esp-1");
    expect(screen.queryByRole("tab", { name: "Call" })).toBeNull();
    expect(screen.getByText("hilo del canal")).toBeTruthy();
    cleanup();
    mount("cs-1", null);
    expect(screen.queryByRole("tab", { name: "Channel chat" })).toBeNull();
  });

  it("lo escrito va a la llamada, no al canal", async () => {
    mount("cs-1", "esp-1");
    await screen.findByText("hola");
    const box = screen.getByPlaceholderText("Message the call");
    fireEvent.change(box, { target: { value: "  apunto esto  " } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/call-sessions/cs-1/messages", { body: "apunto esto" }, true));
  });

  it("sólo lo tuyo se retira", async () => {
    mount("cs-1", "esp-1");
    await screen.findByText("hola");
    const buttons = screen.getAllByRole("button", { name: "Withdraw" });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(del).toHaveBeenCalledWith("/api/v1/call-sessions/cs-1/messages/m2"));
  });
});

describe("el chat de otra llamada", () => {
  it("un aviso de otra llamada no se pide", async () => {
    await useCallChat.getState().load("cs-1");
    get.mockClear();
    await useCallChat.getState().onIncoming("cs-2");
    expect(get).not.toHaveBeenCalled();
    await useCallChat.getState().onIncoming("cs-1");
    expect(get).toHaveBeenCalledTimes(1);
  });
});

// El invitado (tanda 4): sólo «Llamada», por la puerta pública con su enlace y
// su pase, preguntando cada 3 s mientras está dentro y no después. Ve las
// reacciones, pero no las pone ni retira nada. Mutantes: preguntar con la
// sesión de miembro; no dejar de preguntar al salir; ofrecerle reaccionar.
describe("el chat del invitado", () => {
  const guest = { token: "inv.firma", pass: "pase-1" };
  const withReaction = [{ ...msgs[0], reactions: [{ emoji: "👍", count: 1, mine: false, names: ["Ana"] }] }];

  it("sólo la llamada, por la puerta pública, y escribe por ella", async () => {
    post.mockImplementation(async (url: string) => (url === "/api/v1/public/calls/chat" ? { data: withReaction } : { data: {} }));
    render(<CallChatPanel sessionId={null} guest={guest} spaceId={null} spaceName="" onClose={() => {}} />);
    expect(screen.queryByRole("tab", { name: "Channel chat" })).toBeNull();
    expect(await screen.findByText("hola")).toBeTruthy();
    expect(post).toHaveBeenCalledWith("/api/v1/public/calls/chat", guest);
    expect(get).not.toHaveBeenCalled();
    // Ve la reacción, pero no la puede tocar ni poner otra; ni retirar nada.
    expect((screen.getByRole("button", { name: /👍/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Withdraw" })).toBeNull();
    const box = screen.getByPlaceholderText("Message the call");
    fireEvent.change(box, { target: { value: "soy el cliente" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/public/calls/chat/send", { ...guest, body: "soy el cliente" }),
    );
  });

  it("pregunta cada 3 s mientras está dentro, y al salir deja de preguntar", async () => {
    vi.useFakeTimers();
    try {
      post.mockResolvedValue({ data: [] });
      const r = render(<CallChatPanel sessionId={null} guest={guest} spaceId={null} spaceName="" onClose={() => {}} />);
      await vi.advanceTimersByTimeAsync(0);
      const asked = () => post.mock.calls.filter((c) => c[0] === "/api/v1/public/calls/chat").length;
      expect(asked()).toBe(1);
      await vi.advanceTimersByTimeAsync(3000);
      expect(asked()).toBe(2);
      r.unmount();
      await vi.advanceTimersByTimeAsync(9000);
      expect(asked()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Reaccionar como miembro: al momento, y vuelta atrás si el servidor dice que
// no. Mutantes: no pintarla hasta que conteste; no deshacerla al fallar.
describe("reaccionar en el chat de la llamada", () => {
  it("se pinta al momento y vuelve atrás si falla", async () => {
    await useCallChat.getState().load("cs-1");
    let fail: (e: Error) => void = () => {};
    post.mockReturnValueOnce(new Promise((_, rej) => (fail = rej)));
    const doing = useCallChat.getState().react("m1", "🎉", true);
    expect(useCallChat.getState().messages[0].reactions?.some((r) => r.emoji === "🎉" && r.mine)).toBe(true);
    fail(new Error("no"));
    await expect(doing).rejects.toThrow();
    expect(useCallChat.getState().messages[0].reactions ?? []).toEqual([]);
    expect(post).toHaveBeenCalledWith("/api/v1/call-sessions/cs-1/messages/m1/reactions", { emoji: "🎉", on: true }, true);
  });
});
