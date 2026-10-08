import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn(async () => true) }));
vi.mock("sonner", () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(async () => ({ success: true, data: [] })), post: vi.fn(), delete: vi.fn() },
  apiUrl: (p: string) => `https://cac.example${p}`,
  codigoDe: () => "",
}));

import GuestInviteDialog from "@/components/voice/GuestInviteDialog";
import { useCalls } from "@/store/calls.store";
import { useVoice } from "@/store/voice.store";

afterEach(cleanup);

const ring = vi.fn(async () => {});
const entrarEnReunion = vi.fn(async () => {});

beforeEach(() => {
  ring.mockClear();
  entrarEnReunion.mockClear();
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } });
  useCalls.setState({
    bySpace: {},
    load: vi.fn(async () => {}),
    ring,
    create: vi.fn(async () => ({
      id: "inv-9", orgId: "org-1", spaceId: "esp-1", title: "Con el cliente", createdBy: "u-ana",
      expiresAt: "2026-10-09T00:00:00Z", maxGuests: 0, link: "inv-9.firma", occupants: [],
    })),
  });
  useVoice.setState({
    entrarEnReunion,
    yo: "u-ana",
    gente: [
      { identity: "u-ana", name: "Ana" },
      { identity: "u-bea", name: "Bea" },
      { identity: "u-cris", name: "Cris" },
    ],
  });
});

// Desde la llamada del canal, crear el enlace **muda la llamada**: un invitado
// no puede entrar a la sala del canal, así que la conversación se va a la
// reunión y se llama a quienes estaban para que sigan.
describe("invitar por enlace desde la llamada", () => {
  it("te pasa a la reunión y llama a los que estaban contigo", async () => {
    render(
      <MemoryRouter>
        <GuestInviteDialog open onOpenChange={() => {}} orgId="org-1" spaceId="esp-1" fromCall />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText("What it's about"), { target: { value: "Con el cliente" } });
    fireEvent.click(screen.getByRole("button", { name: /Create link and move/ }));
    await vi.waitFor(() => expect(entrarEnReunion).toHaveBeenCalledWith("inv-9"));
    await vi.waitFor(() => expect(ring).toHaveBeenCalledTimes(2));
    // A los demás, no a ti.
    expect(ring.mock.calls.map((c) => (c as unknown as [string, string])[1]).sort()).toEqual(["u-bea", "u-cris"]);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("https://cac.example/app/join#inv-9.firma");
  });

  // Sin venir de una llamada, sólo crea y copia: no saca a nadie de ningún sitio.
  it("desde la cabecera del canal no muda nada", async () => {
    render(
      <MemoryRouter>
        <GuestInviteDialog open onOpenChange={() => {}} orgId="org-1" spaceId="esp-1" />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText("What it's about"), { target: { value: "Con el cliente" } });
    fireEvent.click(screen.getByRole("button", { name: /^Create link$/ }));
    await vi.waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    expect(entrarEnReunion).not.toHaveBeenCalled();
    expect(ring).not.toHaveBeenCalled();
  });
});
