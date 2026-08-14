import { beforeEach, describe, expect, it, vi } from "vitest";

// What the updater says it is doing.
//
// This whole file exists because of one line: the panel reported
// `event.data.chunkLength` — the size of the chunk that just arrived — as if it
// were the running total. Chunks are about 16 KB, so an 86 MB download sat on
// "Downloading... 16 KB" from start to finish, and the only honest reading of
// that screen was "it is stuck". It wasn't; it was moving at 50 KB/s.
//
// The rule these tests hold to: the panel may say "I don't know", but it may
// never say something that isn't so.

type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished"; data?: unknown };

let onProgress: (e: DownloadEvent) => void = () => {};
let downloadBehaviour: () => Promise<void> = async () => {};

const downloadAndInstall = vi.fn(async (cb: (e: DownloadEvent) => void) => {
  onProgress = cb;
  await downloadBehaviour();
});

let updateAvailable = true;
vi.mock("@tauri-apps/plugin-updater", () => ({
  check: vi.fn(async () =>
    updateAvailable
      ? { version: "1.6.24", body: "notas", downloadAndInstall }
      : null,
  ),
}));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn(async () => {}) }));

const { useUpdaterStore, describeProgress } = await import("@/store/updater.store");

const KB = 1024;
const MB = 1024 * 1024;

beforeEach(() => {
  vi.clearAllMocks();
  updateAvailable = true;
  downloadBehaviour = async () => {};
  useUpdaterStore.setState({
    available: { version: "1.6.24", body: "" },
    downloading: false,
    progress: null,
    downloaded: 0,
    total: null,
    lastError: null,
  });
});

describe("counting the download", () => {
  // The regression test. Before the fix this reported 16 KB.
  it("adds every chunk up instead of showing the last one", async () => {
    downloadBehaviour = async () => {
      onProgress({ event: "Started", data: { contentLength: 86 * MB } });
      onProgress({ event: "Progress", data: { chunkLength: 16 * KB } });
      onProgress({ event: "Progress", data: { chunkLength: 16 * KB } });
      onProgress({ event: "Progress", data: { chunkLength: 16 * KB } });
    };
    await useUpdaterStore.getState().installUpdate();

    expect(useUpdaterStore.getState().downloaded).toBe(48 * KB);
  });

  it("keeps the total from Started, which the old code threw away", async () => {
    downloadBehaviour = async () => {
      onProgress({ event: "Started", data: { contentLength: 86 * MB } });
      onProgress({ event: "Progress", data: { chunkLength: 1 * MB } });
    };
    await useUpdaterStore.getState().installUpdate();

    const s = useUpdaterStore.getState();
    expect(s.total).toBe(86 * MB);
    // And the text can therefore say where it is, which is the point.
    expect(s.progress).toBe("1.0 / 86.0 MB (1%)");
  });

  it("invents no percentage when the server declared no size", () => {
    expect(describeProgress(5 * MB, null)).toBe("5.0 MB downloaded");
    expect(describeProgress(5 * MB, 20 * MB)).toBe("5.0 / 20.0 MB (25%)");
  });

  it("never claims more than 100%, whatever the byte counts say", () => {
    expect(describeProgress(21 * MB, 20 * MB)).toContain("(100%)");
  });

  it("says it is installing once the bytes are in", async () => {
    downloadBehaviour = async () => {
      onProgress({ event: "Started", data: { contentLength: 1 * MB } });
      onProgress({ event: "Progress", data: { chunkLength: 1 * MB } });
      onProgress({ event: "Finished" });
    };
    await useUpdaterStore.getState().installUpdate();
    // Not "Restarting": the binary swap happens first and reports nothing.
    expect(useUpdaterStore.getState().progress).toBe("Installing…");
  });
});

describe("when it fails", () => {
  it("keeps the reason instead of silently offering the update again", async () => {
    downloadBehaviour = async () => {
      onProgress({ event: "Started", data: { contentLength: 86 * MB } });
      throw new Error("Updater: AppImage not found");
    };
    await useUpdaterStore.getState().installUpdate();

    const s = useUpdaterStore.getState();
    expect(s.lastError).toContain("AppImage not found");
    expect(s.downloading).toBe(false);
  });

  it("starts the next attempt clean, without last time's error or bytes", async () => {
    downloadBehaviour = async () => {
      throw new Error("network");
    };
    await useUpdaterStore.getState().installUpdate();
    expect(useUpdaterStore.getState().lastError).toBe("network");

    let errorDuringRetry: string | null = "not read yet";
    downloadBehaviour = async () => {
      // Read at the moment the download is actually running: a stale error on
      // screen while it is busy succeeding is its own kind of lie.
      errorDuringRetry = useUpdaterStore.getState().lastError;
      onProgress({ event: "Started", data: { contentLength: 1 * MB } });
      onProgress({ event: "Progress", data: { chunkLength: 1 * MB } });
    };
    await useUpdaterStore.getState().installUpdate();

    expect(errorDuringRetry).toBeNull();
    expect(useUpdaterStore.getState().downloaded).toBe(1 * MB);
  });
});
