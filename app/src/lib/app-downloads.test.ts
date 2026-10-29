import { describe, expect, it } from "vitest";

import { detectOS, pickDownloads } from "./app-downloads";

// Los nombres reales de la v1.24.1, como los publica `app-release.yml`.
const RELEASE = {
  tag_name: "v1.24.1",
  assets: [
    "CAC-1.24.1-1.x86_64.rpm",
    "CAC-1.24.1-1.x86_64.rpm.sig",
    "CAC_1.24.1_amd64.AppImage",
    "CAC_1.24.1_amd64.AppImage.sig",
    "CAC_1.24.1_amd64.deb",
    "CAC_1.24.1_amd64.deb.sig",
    "CAC_1.24.1_universal.dmg",
    "CAC_1.24.1_x64-setup.exe",
    "CAC_1.24.1_x64-setup.exe.sig",
    "CAC_universal.app.tar.gz",
    "CAC_universal.app.tar.gz.sig",
    "latest.json",
  ].map((name) => ({ name, browser_download_url: `https://dl/${name}`, size: 1 })),
};

describe("los instaladores de la última versión", () => {
  it("ofrece uno por sistema y formato, y nada de lo que es del actualizador", () => {
    const { version, downloads } = pickDownloads(RELEASE);
    expect(version).toBe("1.24.1");
    expect(downloads.map((d) => [d.kind, d.name])).toEqual([
      ["windows", "CAC_1.24.1_x64-setup.exe"],
      ["mac", "CAC_1.24.1_universal.dmg"],
      ["appimage", "CAC_1.24.1_amd64.AppImage"],
      ["deb", "CAC_1.24.1_amd64.deb"],
      ["rpm", "CAC-1.24.1-1.x86_64.rpm"],
    ]);
  });

  // GitHub los lista por nombre y la firma va detrás, pero eso es suerte del
  // orden: ofrecer `…-setup.exe.sig` sería un enlace que no instala nada.
  it("no confunde un instalador con su firma, vengan en el orden que vengan", () => {
    const alReves = { ...RELEASE, assets: [...RELEASE.assets].reverse() };
    for (const d of pickDownloads(alReves).downloads) expect(d.name).not.toMatch(/\.sig$/);
  });

  it("si a una release le falta un instalador, no se inventa el enlace", () => {
    const sinMac = { ...RELEASE, assets: RELEASE.assets.filter((a) => !a.name.endsWith(".dmg")) };
    expect(pickDownloads(sinMac).downloads.map((d) => d.kind)).not.toContain("mac");
  });
});

describe("el sistema de quien mira", () => {
  it.each([
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130", "windows"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605", "mac"],
    ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130", "linux"],
    // Un móvil dice «Linux» o «Mac OS X», y no instala nada de esto.
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile", null],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15", null],
  ])("%s → %s", (ua, os) => {
    expect(detectOS(ua)).toBe(os);
  });
});
