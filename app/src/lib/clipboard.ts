/**
 * Reads an image from the system clipboard, going around the webview.
 *
 * WebKitGTK will hold a copied bitmap and refuse to hand it to the page: the
 * paste event arrives with no `files`, no `image/*` item, and a `text/html`
 * flavour whose `<img>` has been stripped of its `src`. Tiptap only parses
 * `img[src]`, so the tag is dropped and the paste looks like it did nothing.
 * There is nothing left in the event to recover — but the OS clipboard still
 * has the bitmap, and Rust can read it.
 *
 * Returns null whenever there's no image to be had: a text-only clipboard, a
 * plain browser with no Tauri behind it, or a platform where the plugin
 * can't reach the clipboard (Wayland sessions are the ones to watch).
 */
export async function readClipboardImage(): Promise<File | null> {
  let image: { rgba(): Promise<Uint8Array>; size(): Promise<{ width: number; height: number }>; close(): Promise<void> } | null =
    null;
  try {
    const { readImage } = await import("@tauri-apps/plugin-clipboard-manager");
    image = await readImage();
    const [rgba, { width, height }] = await Promise.all([image.rgba(), image.size()]);
    if (!width || !height || rgba.length < width * height * 4) return null;

    // The plugin hands over raw RGBA; everything downstream — the upload, the
    // stored attachment — wants a real image file, so encode it here.
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) return null;
    return new File([blob], "pasted.png", { type: "image/png" });
  } catch {
    return null;
  } finally {
    // The Rust side keeps the image alive until the resource is dropped.
    await image?.close().catch(() => {});
  }
}

/**
 * Does this paste look like an image the webview wouldn't give us?
 *
 * Deliberately narrow, because the caller answers yes by swallowing the paste
 * and asking the OS instead. Two shapes qualify, and in both the event carries
 * nothing that could have been pasted anyway:
 *
 * - an `<img>` with no usable source, which is what WebKit produces for a
 *   copied bitmap, and
 * - a completely empty event — no types at all — which is what it produces for
 *   a screenshot.
 *
 * Any real text rules it out, so pasting prose is never intercepted.
 */
export function looksLikeStrippedImage(dt: DataTransfer): boolean {
  if (dt.getData("text/plain").trim()) return false;

  const html = dt.getData("text/html");
  if (!html) return (dt.types?.length ?? 0) === 0;

  const tags = html.match(/<img\b[^>]*>/gi);
  if (!tags) return false;
  // Every image has to be unusable. One with a real source — a remote URL, or
  // a blob the caller already handled — means the paste can stand on its own,
  // and intercepting it would replace it with whatever was copied last.
  return tags.every((tag) => !/\ssrc\s*=\s*["']?[^"'\s>]+/i.test(tag));
}
