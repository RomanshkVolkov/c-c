import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface PromptOptions {
  title: string;
  description?: string;
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmText?: string;
  cancelText?: string;
  /** Allow submitting an empty string (default: no — empty resolves to null). */
  allowEmpty?: boolean;
}

/** Resolves to the trimmed value, or null if cancelled (or left empty). */
type PromptFn = (opts: PromptOptions) => Promise<string | null>;

const PromptContext = createContext<PromptFn | null>(null);

/**
 * Imperative single-field prompt. `const prompt = usePrompt()` then
 * `const name = await prompt({ title: "New space", label: "Name" })`.
 *
 * Replaces `window.prompt`, which the Tauri webview renders as a raw native
 * dialog — unstyled, ignoring the app theme, and titled "JavaScript -
 * tauri://localhost/...". Same contract as {@link useConfirm}.
 */
export function usePrompt(): PromptFn {
  const ctx = useContext(PromptContext);
  if (!ctx) {
    throw new Error("usePrompt must be used within <PromptProvider>");
  }
  return ctx;
}

export function PromptProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState<PromptOptions>({ title: "" });
  const [value, setValue] = useState("");
  const resolver = useRef<((value: string | null) => void) | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // `autoFocus` only fires on mount, and the dialog may stay mounted between
  // prompts — focus (and select, so a default value can be typed over) on open.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 50);
    return () => clearTimeout(t);
  }, [open]);

  const prompt = useCallback<PromptFn>((options) => {
    setOpts(options);
    setValue(options.defaultValue ?? "");
    setOpen(true);
    return new Promise<string | null>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = (result: string | null) => {
    setOpen(false);
    resolver.current?.(result);
    resolver.current = null;
  };

  const trimmed = value.trim();
  const canSubmit = opts.allowEmpty || trimmed.length > 0;
  const submit = () => {
    if (!canSubmit) return;
    settle(opts.allowEmpty ? value : trimmed);
  };

  return (
    <PromptContext.Provider value={prompt}>
      {children}
      <Dialog open={open} onOpenChange={(next) => !next && settle(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{opts.title}</DialogTitle>
            {opts.description && <DialogDescription>{opts.description}</DialogDescription>}
          </DialogHeader>
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            {opts.label && <Label htmlFor="prompt-value">{opts.label}</Label>}
            <Input
              id="prompt-value"
              ref={inputRef}
              autoFocus
              value={value}
              placeholder={opts.placeholder}
              onChange={(e) => setValue(e.target.value)}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            {/* Submit lives inside the form so Enter works. */}
            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" onClick={() => settle(null)}>
                {opts.cancelText ?? "Cancel"}
              </Button>
              <Button type="submit" disabled={!canSubmit}>
                {opts.confirmText ?? "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </PromptContext.Provider>
  );
}
