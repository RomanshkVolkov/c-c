import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(async () => ({ success: true, data: [] })), post: vi.fn(), delete: vi.fn() },
  apiUrl: (p: string) => `https://cac.example${p}`,
  codigoDe: () => "",
}));
vi.mock("@/store/auth.store", () => ({
  useAuthStore: { getState: () => ({ accessToken: "el-token" }) },
}));

import RecordingsPanel from "@/components/recordings/RecordingsPanel";
import { useRecordings, type Recording } from "@/store/recordings.store";

afterEach(cleanup);

function rec(over: Partial<Recording> = {}): Recording {
  return {
    id: "rec-1",
    orgId: "org-1",
    spaceId: "esp-1",
    startedBy: "u-ana",
    startedByName: "Ana",
    status: "ready",
    startedAt: "2026-09-18T00:00:00Z",
    finalContentType: "video/mp4",
    durationMs: 185_000,
    hasScreen: true,
    ...over,
  };
}

function pintar(lista: Recording[]) {
  useRecordings.setState({ lista: { "esp-1": lista }, cargando: {} });
  return render(<RecordingsPanel spaceId="esp-1" />);
}

beforeEach(() => {
  useRecordings.setState({ lista: {}, cargando: {} });
});

describe("el panel de grabaciones", () => {
  /**
   * Una llamada sin pantalla es **audio**, no un vídeo negro.
   *
   * Un `<video>` con una pista de sólo sonido pinta un rectángulo negro con
   * controles, que se lee como un vídeo roto. El mutante que mata: pintar
   * siempre `<video>`.
   */
  it("sólo voz se pinta como audio", () => {
    const { container } = pintar([rec({ finalContentType: "audio/mp4", hasScreen: false })]);
    expect(container.querySelector("audio")).toBeTruthy();
    expect(container.querySelector("video")).toBeNull();
  });

  it("y con pantalla, como vídeo", () => {
    const { container } = pintar([rec()]);
    expect(container.querySelector("video")).toBeTruthy();
    expect(container.querySelector("audio")).toBeNull();
  });

  /**
   * **Nunca una URL del bucket.**
   *
   * Es la misma regla que en la tienda, comprobada donde de verdad acaba: en el
   * atributo que el navegador va a pedir.
   */
  it("el src va al proxy de cac, con token y sin amazonaws", () => {
    const { container } = pintar([rec()]);
    const src = container.querySelector("video")?.getAttribute("src") ?? "";
    expect(src).toContain("/api/v1/recordings/rec-1/media");
    expect(src).toContain("token=");
    expect(src).not.toContain("amazonaws");
  });

  /** Lo que todavía se monta no se puede reproducir: no hay fichero. */
  it("una que se está montando no trae reproductor", () => {
    const { container } = pintar([rec({ status: "finalizing", finalContentType: undefined })]);
    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector("audio")).toBeNull();
    expect(document.body.textContent).toContain("Processing");
  });

  /**
   * Una `partial` **sí se ve**, y dice por qué lo está.
   *
   * Hay vídeo: esconderlo por haber perdido una pista sería tirar lo que sí se
   * salvó. Y una etiqueta que diga «parcial» sin explicar qué falta deja a
   * quien la lee sin saber si puede fiarse de lo que oye.
   */
  it("una parcial se ve y se explica", () => {
    const { container } = pintar([rec({ status: "partial" })]);
    expect(container.querySelector("video")).toBeTruthy();
    expect(document.body.textContent).toContain("missing track");
    expect(document.body.textContent?.toLowerCase()).toContain("lost");
  });

  /** Una que falló no ofrece un reproductor que no va a poder abrir nada. */
  it("una fallida no trae reproductor", () => {
    const { container } = pintar([rec({ status: "failed", finalContentType: undefined })]);
    expect(container.querySelector("video")).toBeNull();
    expect(document.body.textContent).toContain("Failed");
  });

  it("sin nada grabado, lo dice", () => {
    pintar([]);
    expect(screen.getByText(/Nothing recorded/i)).toBeTruthy();
  });

  it("la duración se lee en minutos y segundos", () => {
    pintar([rec({ durationMs: 185_000 })]);
    expect(document.body.textContent).toContain("3:05");
  });
});
