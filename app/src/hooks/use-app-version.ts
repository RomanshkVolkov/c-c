import { useEffect, useState } from "react";

/**
 * Which build am I actually running?
 *
 * An app that updates itself makes this a real question, and the only other
 * answer was the release notes on GitHub. Read once and shared, because two
 * places show it now — the update button and the account row.
 *
 * Empty in a plain browser, where there is no Tauri to ask.
 */
export function useAppVersion(): string {
  const [version, setVersion] = useState("");
  useEffect(() => {
    void import("@tauri-apps/api/app")
      .then(({ getVersion }) => getVersion())
      .then(setVersion)
      .catch(() => {});
  }, []);
  return version;
}
