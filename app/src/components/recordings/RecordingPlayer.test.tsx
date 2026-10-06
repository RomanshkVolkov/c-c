import { describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";

/**
 * El reproductor de una grabación pide un pase de adjuntos y lo pone en el
 * `src`; el token de acceso ya no vale en una URL. Era el único `src` que se
 * armaba aparte de `mediaSrc`, y con el backend nuevo las grabaciones dejaban
 * de sonar (6-oct-2026). Mutantes: volver al token de acceso; no esperar al
 * pase.
 */
vi.mock("@/lib/url-ticket", () => ({ urlTicket: vi.fn(async () => "pase-media") }));
const { RecordingPlayer } = await import("./RecordingsPanel");
const { useAuthStore } = await import("@/store/auth.store");

describe("el reproductor de una grabación", () => {
  it("pide un pase y lo pone en el src", async () => {
    useAuthStore.setState({ accessToken: "acceso-secreto" } as never);
    const { container } = render(<RecordingPlayer recordingId="rec-1" isAudio={false} />);
    expect(container.querySelector("video")).toBeNull();
    await waitFor(() => expect(container.querySelector("video")).not.toBeNull());
    const src = container.querySelector("video")!.getAttribute("src")!;
    expect(src).toContain("/api/v1/recordings/rec-1/media?token=pase-media");
    expect(src).not.toContain("acceso-secreto");
  });
});
