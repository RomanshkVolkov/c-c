import { useEffect, useRef, useState } from "react";

/**
 * The row you type a name into, in the tree, where the thing will be.
 *
 * Replaces a modal. Naming a list is three words of typing, and a dialog for it
 * costs a context switch each way: the tree greys out, you lose sight of where
 * the new list is going, and you get it back only after confirming. Creating
 * five lists in a row meant five of those.
 *
 * Creating keeps the row open after each `Enter` — the common case is more than
 * one — while renaming closes, because there is no "next" rename.
 */
export default function InlineName({
  mode,
  defaultValue = "",
  placeholder,
  indent = 0,
  onSubmit,
  onClose,
}: {
  mode: "create" | "rename";
  defaultValue?: string;
  placeholder?: string;
  /** Left padding in px, so the row lines up with the level it belongs to. */
  indent?: number;
  onSubmit: (name: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(defaultValue);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  // Renaming starts with the text selected: the usual intent is to replace it,
  // and the usual alternative is one keystroke away.
  useEffect(() => {
    ref.current?.focus();
    if (mode === "rename") ref.current?.select();
  }, [mode]);

  const commit = async () => {
    const name = value.trim();
    if (!name || busy) return;
    if (mode === "rename" && name === defaultValue) return onClose();
    setBusy(true);
    try {
      await onSubmit(name);
      if (mode === "create") {
        setValue("");
        ref.current?.focus();
      } else {
        onClose();
      }
    } catch {
      // The caller reports it. What matters here is that a failure leaves what
      // was typed on screen: clearing the field would make the person retype a
      // name the server never accepted.
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center px-2 py-1" style={{ paddingLeft: 8 + indent }}>
      <input
        ref={ref}
        value={value}
        disabled={busy}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-6 w-full rounded border bg-background px-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
        // Clicking away commits what's typed rather than throwing it out:
        // losing a name you already wrote is the worse of the two surprises.
        onBlur={() => {
          if (busy) return;
          if (value.trim()) void commit().then(onClose);
          else onClose();
        }}
      />
    </div>
  );
}
