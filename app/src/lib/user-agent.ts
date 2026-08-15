/**
 * A user agent, said in words.
 *
 * The raw string is unreadable — the useful fact in
 * "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15
 * (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1" is *iPhone,
 * Safari*, and that a bug only happens on a phone is often the whole diagnosis.
 *
 * A heuristic, and treated as one: anything unrecognised returns unchanged
 * rather than guessed at, and the caller keeps the original in a tooltip. The
 * order matters — Edge and Chrome both claim "Chrome", Chrome claims "Safari",
 * so the most specific claim is checked first.
 */
export function describeAgent(ua: string): string {
  if (!ua.trim()) return "";

  const platform =
    /iPhone/i.test(ua) ? "iPhone"
    : /iPad/i.test(ua) ? "iPad"
    : /Android/i.test(ua) ? "Android"
    : /Windows/i.test(ua) ? "Windows"
    : /Macintosh|Mac OS X/i.test(ua) ? "Mac"
    : /Linux/i.test(ua) ? "Linux"
    : "";

  const browser =
    /Edg\//i.test(ua) ? "Edge"
    : /OPR\/|Opera/i.test(ua) ? "Opera"
    : /Firefox\//i.test(ua) ? "Firefox"
    : /Chrome\//i.test(ua) ? "Chrome"
    : /Safari\//i.test(ua) ? "Safari"
    : "";

  const said = [platform, browser].filter(Boolean).join(" · ");
  // Recognising nothing is not a reason to show nothing.
  return said || ua;
}
