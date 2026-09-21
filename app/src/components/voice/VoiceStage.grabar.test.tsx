import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

interface OpcionesDeConfirmar {
  title: string;
  description?: string;
  confirmText?: string;
  destructive?: boolean;
}

const { confirmar, toastInfo } = vi.hoisted(() => ({
  // Tipado con las opciones: sin ellas, `mock.calls[0][0]` es `never` y la
  // aserción de qué dice el diálogo no compila.
  confirmar: vi.fn(async (_opts: { title: string; description?: string }) => true),
  toastInfo: vi.fn(),
}));
vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => confirmar }));
vi.mock("sonner", () => ({ toast: { info: toastInfo, error: vi.fn(), success: vi.fn() } }));
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
import { useRecordings } from "@/store/recordings.store";
import { useVoice } from "@/store/voice.store";

afterEach(cleanup);

const parar = vi.fn(async () => {});
const empezar = vi.fn(async () => true);

beforeEach(() => {
  confirmar.mockClear().mockResolvedValue(true);
  toastInfo.mockClear();
  parar.mockClear();
  empezar.mockClear().mockResolvedValue(true);
  useRecordings.setState({
    policy: { "esp-1": { enabled: true, active: null } },
    lista: {},
    cargando: {},
    enVuelo: null,
    error: null,
    parar,
    empezar,
    cargarPolitica: vi.fn(async () => {}),
  });
  useVoice.setState({
    spaceId: "esp-1",
    estado: "dentro",
    yo: "u-ana",
    gente: [
      { identity: "u-ana", name: "Ana" },
      { identity: "u-bea", name: "Bea" },
    ],
    grabacion: null,
    escenario: true,
  });
});

function botonDeGrabar() {
  return screen.getByRole("button", { name: /^(Record|Stop recording)$/ });
}

describe("parar la grabación", () => {
  /**
   * **Parar pregunta.**
   *
   * El botón vive entre el de silenciarse y el de compartir pantalla, que se
   * pulsan con prisa. Cortar por error la grabación de una reunión no se
   * deshace: volver a empezar hace **otra**, y lo de en medio no existe.
   */
  it("no para sin preguntar", async () => {
    useVoice.setState({ grabacion: { id: "rec-1", by: "u-ana", since: "" } });
    render(<VoiceStage spaceName="General" />);

    botonDeGrabar().click();

    await waitFor(() => expect(confirmar).toHaveBeenCalled());
    expect(parar).toHaveBeenCalledWith("rec-1");
  });

  it("y si dices que no, no para", async () => {
    confirmar.mockResolvedValue(false);
    useVoice.setState({ grabacion: { id: "rec-1", by: "u-ana", since: "" } });
    render(<VoiceStage spaceName="General" />);

    botonDeGrabar().click();

    await waitFor(() => expect(confirmar).toHaveBeenCalled());
    expect(parar).not.toHaveBeenCalled();
  });

  /**
   * Y dice **de quién** es la que vas a cortar.
   *
   * No es lo mismo parar la tuya que la de otro: en el segundo caso estás
   * decidiendo por alguien que no está pulsando nada.
   */
  it("avisa cuando la grabación es de otra persona, y la nombra", async () => {
    useVoice.setState({ grabacion: { id: "rec-1", by: "u-bea", since: "" } });
    render(<VoiceStage spaceName="General" />);

    botonDeGrabar().click();

    await waitFor(() => expect(confirmar).toHaveBeenCalled());
    const opts = confirmar.mock.calls[0][0] as OpcionesDeConfirmar;
    expect(opts.description).toContain("Bea");
  });

  it("y con la tuya no nombra a nadie", async () => {
    useVoice.setState({ grabacion: { id: "rec-1", by: "u-ana", since: "" } });
    render(<VoiceStage spaceName="General" />);

    botonDeGrabar().click();

    await waitFor(() => expect(confirmar).toHaveBeenCalled());
    const opts = confirmar.mock.calls[0][0] as OpcionesDeConfirmar;
    expect(opts.description).not.toContain("Ana");
    expect(opts.description).toContain("resume");
  });
});

describe("dos personas pulsando grabar", () => {
  /**
   * Gana uno, lo decide la base, y **al otro se le dice**.
   *
   * El índice único parcial impide la segunda grabación; lo que faltaba era
   * que quien pierde la carrera supiera por qué su pulsación no hizo nada —
   * aparecía el chip y se quedaba adivinando.
   */
  it("a quien pierde se le dice quién empezó", async () => {
    empezar.mockImplementation(async () => {
      useRecordings.setState({
        error: "already-recording",
        policy: {
          "esp-1": {
            enabled: true,
            active: {
              id: "rec-1",
              orgId: "o",
              spaceId: "esp-1",
              startedBy: "u-bea",
              status: "recording",
              startedAt: "",
              hasScreen: false,
            },
          },
        },
      });
      return false;
    });
    render(<VoiceStage spaceName="General" />);

    botonDeGrabar().click();
    // El diálogo de consentimiento, y confirmar.
    await waitFor(() => screen.getByText("Start recording"));
    screen.getByText("Start recording").click();

    await waitFor(() => expect(toastInfo).toHaveBeenCalled());
    expect(String(toastInfo.mock.calls[0][0])).toContain("Bea");
  });

  /** Y si sale bien, no se dice nada raro. */
  it("cuando gana, no avisa de nada", async () => {
    render(<VoiceStage spaceName="General" />);
    botonDeGrabar().click();
    await waitFor(() => screen.getByText("Start recording"));
    screen.getByText("Start recording").click();
    await waitFor(() => expect(empezar).toHaveBeenCalled());
    expect(toastInfo).not.toHaveBeenCalled();
  });
});
