import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const { confirm, kick } = vi.hoisted(() => ({
  confirm: vi.fn(async (_o: { title: string }) => true),
  kick: vi.fn(async () => {}),
}));
vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => confirm }));
vi.mock("sonner", () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: ((ev: unknown) => void) | null = null;
  },
}));
vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(async () => ({ success: true, data: [] })), post: vi.fn(), delete: vi.fn() },
  apiUrl: (p: string) => `https://cac.example${p}`,
  codigoDe: () => "",
}));

import VoiceStage from "@/components/voice/VoiceStage";
import { useCalls } from "@/store/calls.store";
import { useRecordings } from "@/store/recordings.store";
import { useVoice } from "@/store/voice.store";

afterEach(cleanup);

const gente = [
  { identity: "u-ana", name: "Ana" },
  // Un miembro que se llama como un invitado: la insignia no puede salir del
  // nombre.
  { identity: "u-bea", name: "Guest Bea" },
  { identity: "guest:g1", name: "Carla" },
];

beforeEach(() => {
  confirm.mockClear().mockResolvedValue(true);
  kick.mockClear();
  useCalls.setState({ kick });
  useRecordings.setState({
    policy: {
      "meet:inv-1": { enabled: true, active: null },
      "esp-1": { enabled: true, active: null },
    },
    loadPolicy: vi.fn(async () => {}),
  });
});

function comoMiembroEnReunion() {
  useVoice.setState({
    spaceId: null, meetId: "inv-1", meetSpaceId: "esp-1", title: "Con el cliente", visitor: false,
    estado: "dentro", yo: "u-ana", gente, recording: null, escenario: true,
  });
}

function comoInvitado() {
  useVoice.setState({
    spaceId: null, meetId: null, meetSpaceId: null, title: "Con el cliente", visitor: true,
    estado: "dentro", yo: "guest:g9", gente, recording: null, escenario: true,
  });
}

describe("la pantalla de una reunión, vista por un invitado", () => {
  // Cada una de estas es un botón que necesita sesión y fallaría al pulsarlo.
  // El mutante que mata: quitar cualquiera de las puertas de `visitor`.
  it("no ofrece nada que necesite sesión", () => {
    comoInvitado();
    render(<VoiceStage />);
    expect(screen.queryByRole("button", { name: /^Chat$/ })).toBeNull();
    expect(screen.queryByTitle("Call someone into this room")).toBeNull();
    expect(screen.queryByRole("button", { name: /^(Record|Stop recording)$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove .* from the call/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Copy guest link/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Minimize/ })).toBeNull();
  });

  it("dice qué reunión es, no un canal", () => {
    comoInvitado();
    render(<VoiceStage />);
    expect(screen.getAllByText("Con el cliente").length).toBeGreaterThan(0);
    expect(screen.queryByText(/^#/)).toBeNull();
  });
});

describe("la pantalla de una reunión, vista por un miembro", () => {
  it("ofrece copiar el enlace, grabar y el chat del canal", () => {
    comoMiembroEnReunion();
    render(<VoiceStage />);
    expect(screen.getByRole("button", { name: /Copy guest link/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^(Record|Stop recording)$/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Chat$/ })).toBeTruthy();
    // El timbre es de un canal: en una reunión no hay a qué sala llamar.
    expect(screen.queryByTitle("Call someone into this room")).toBeNull();
  });

  // La insignia sale de la identidad (`guest:`), nunca del nombre: el nombre
  // lo escribe el invitado.
  it("marca de invitado a quien lo es, no a quien se llama así", () => {
    comoMiembroEnReunion();
    render(<VoiceStage />);
    const insignias = screen.getAllByText("Guest");
    expect(insignias).toHaveLength(1);
    expect(insignias[0].closest("div")?.textContent).toContain("Carla");
  });

  // Sacar es sólo para invitados: un miembro no tiene botón, y el de Carla
  // pregunta antes y llama con su identidad.
  it("sólo se puede sacar a un invitado, y pregunta antes", async () => {
    comoMiembroEnReunion();
    render(<VoiceStage />);
    const botones = screen.getAllByRole("button", { name: /Remove .* from the call/ });
    expect(botones).toHaveLength(1);
    fireEvent.click(botones[0]);
    await vi.waitFor(() => expect(kick).toHaveBeenCalledWith("inv-1", "guest:g1"));
    expect(confirm).toHaveBeenCalled();
  });

  // Decir que no es no: el mutante que mata es preguntar y sacar igual.
  it("si se dice que no, no se saca a nadie", async () => {
    comoMiembroEnReunion();
    confirm.mockResolvedValue(false);
    render(<VoiceStage />);
    fireEvent.click(screen.getByRole("button", { name: /Remove .* from the call/ }));
    await vi.waitFor(() => expect(confirm).toHaveBeenCalled());
    await Promise.resolve();
    expect(kick).not.toHaveBeenCalled();
  });

  // La grabación de la reunión va por la sala de la reunión, no la del canal.
  it("graba la sala de la reunión", () => {
    comoMiembroEnReunion();
    useRecordings.setState({ policy: { "esp-1": { enabled: true, active: null } } });
    render(<VoiceStage />);
    // Con política sólo para el canal, la reunión no tiene botón.
    expect(screen.queryByRole("button", { name: /^(Record|Stop recording)$/ })).toBeNull();
  });
});
