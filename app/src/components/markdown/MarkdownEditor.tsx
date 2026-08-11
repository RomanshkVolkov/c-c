import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import DragHandle from "@tiptap/extension-drag-handle-react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Markdown } from "tiptap-markdown";
import {
  Bold,
  Italic,
  Code,
  List,
  ListOrdered,
  ListChecks,
  Quote,
  Link2,
  Paperclip,
  Heading2,
  ChevronRight,
  GripVertical,
  Table as TableIcon,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { usePrompt } from "@/components/PromptDialog";
import { attachmentPath, mediaSrc, openAttachment } from "@/lib/media";
import { looksLikeStrippedImage, readClipboardImage } from "@/lib/clipboard";
import { collapsibleExtensions } from "./details";
import { tableExtensions } from "./table";
import { SlashMenu } from "./slash-menu";

/**
 * WYSIWYG editor whose stored value is **markdown**, not HTML or ProseMirror
 * JSON. That keeps descriptions readable by everything else (exports, the MCP
 * server, plain `grep`) instead of only by the editor that wrote them.
 *
 * The extension set is deliberately limited to what markdown can express: any
 * richer node (text colour, custom blocks) would be silently lost on the next
 * round-trip, so it isn't offered in the first place.
 */
/**
 * A `blob:`/`data:` image only exists inside the page that created it. Persisting
 * one stores a reference that renders in the current editor session and nowhere
 * ever again — which is exactly how a pasted image silently vanished. Anything
 * local is dropped here, at the single point where markdown leaves the editor.
 */
const LOCAL_IMAGE = /!\[[^\]]*\]\((?:blob|data):[^)]*\)/g;

/** tiptap-markdown augments `editor.storage` at runtime but ships no types. */
function getMarkdown(editor: Editor): string {
  const storage = editor.storage as unknown as {
    markdown?: { getMarkdown: () => string };
  };
  const md = (storage.markdown?.getMarkdown() ?? "").replace(LOCAL_IMAGE, "");
  // Belt and braces: whatever route an absolute/tokenized attachment URL took to
  // get here, it leaves as the canonical path.
  return md.replace(/(!?\[[^\]]*\]\()([^)\s]+)/g, (whole, head: string, url: string) => {
    const path = attachmentPath(url);
    return path ? head + path : whole;
  });
}

/**
 * A source that only resolves inside this page/session. Anything matching this
 * has to be uploaded before it can be stored, or it renders exactly once and
 * never again.
 */
const LOCAL_SRC = /^(blob:|data:|file:|webkit-fake-url:)/;
const isLocalSrc = (src: unknown): src is string =>
  typeof src === "string" && LOCAL_SRC.test(src);

/** Local image sources inside a pasted HTML fragment (either quote style). */
function localImageURLs(html: string): string[] {
  if (!html) return [];
  const out: string[] = [];
  for (const m of html.matchAll(/<img[^>]*\ssrc=["']([^"']+)["']/g)) {
    if (isLocalSrc(m[1])) out.push(m[1]);
  }
  return out;
}

export interface MarkdownEditorProps {
  value: string;
  onChange: (markdown: string) => void;
  placeholder?: string;
  /** Uploads a pasted/dropped file and returns its public URL. */
  onUpload?: (file: File) => Promise<{ url: string; fileName: string } | null>;
  /**
   * Hands pasted or dropped files to the caller instead of uploading them and
   * embedding a URL. Takes precedence over onUpload.
   *
   * Reports need this: their images are served through short-lived signed URLs
   * — the person who filed the report has no account, so a signature stands in
   * for auth — and a signed URL baked into a stored markdown body would expire.
   * They keep the files as rows attached to the comment, so the composer wants
   * the File, not a link.
   */
  onFiles?: (files: File[]) => void;
  /**
   * Offers collapsible sections, stored as `<details>`/`<summary>` — see
   * ./details.ts.
   *
   * Off by default, and that default is the security boundary: reports are
   * written by whoever hits the widget, and their markdown is rendered inside
   * this app's webview next to Tauri's IPC. Only content written by the team
   * (notes, the docs on spaces and lists) turns this on.
   *
   * Read once, when the editor is built — like every other option here, it
   * can't be flipped on a mounted editor.
   */
  collapsible?: boolean;
  /**
   * Block-level editing affordances: the `/` command menu and a handle to drag
   * blocks around.
   *
   * Kept apart from `collapsible` because they answer different questions.
   * `collapsible` changes what can end up in the stored markdown; this one is
   * only about how it's typed, so it can be turned on anywhere without
   * widening what the document may contain.
   */
  blockTools?: boolean;
  className?: string;
  minHeight?: string;
  autoFocus?: boolean;
  /**
   * Ctrl/Cmd+click on a link inside the editor calls this instead of the
   * default (do nothing while editing). Notes uses it to navigate to another
   * page without leaving edit mode; other callers can ignore it. Plain clicks
   * still place the cursor, same as always — a modifier key is what makes this
   * "open" rather than "edit near".
   */
  onLinkClick?: (href: string) => void;
}

export interface MarkdownEditorHandle {
  /** Inserts `[title](href)` as a real link node at the cursor, then a space. */
  insertLink: (title: string, href: string) => void;
}

/**
 * Point every image with `src` at `to`, or delete them when `to` is null.
 * Positions are collected first: mutating while descending would invalidate them.
 */
function retargetImage(editor: Editor, src: string, to: string | null, alt: string | null) {
  const hits: { pos: number; size: number; attrs: Record<string, unknown> }[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "image" && node.attrs.src === src) {
      hits.push({ pos, size: node.nodeSize, attrs: node.attrs });
    }
  });
  if (hits.length === 0) return;

  const tr = editor.state.tr;
  // Back to front so earlier edits don't shift later positions.
  for (const h of hits.reverse()) {
    if (to === null) tr.delete(h.pos, h.pos + h.size);
    else tr.setNodeMarkup(h.pos, undefined, { ...h.attrs, src: to, alt: alt ?? h.attrs.alt });
  }
  editor.view.dispatch(tr);
}

const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(function MarkdownEditor(
  {
    value,
    onChange,
    placeholder = "Write in markdown…",
    onUpload,
    onFiles,
    collapsible = false,
    blockTools = false,
    className,
    minHeight = "8rem",
    autoFocus,
    onLinkClick,
  },
  ref,
) {
  // The paste/drop handlers live inside the editor's own options, so they can't
  // close over `editor` itself — that would be a circular reference (and an
  // untypeable one). They read it back through this ref instead.
  const editorRef = useRef<Editor | null>(null);
  const uploadRef = useRef<MarkdownEditorProps["onUpload"]>(onUpload);
  uploadRef.current = onUpload;
  const filesRef = useRef<MarkdownEditorProps["onFiles"]>(onFiles);
  filesRef.current = onFiles;
  // onUpdate is wired before the sweep is defined, so it calls through a ref.
  const sweepLocalImagesRef = useRef<(() => void) | null>(null);
  const onLinkClickRef = useRef(onLinkClick);
  onLinkClickRef.current = onLinkClick;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        // Markdown has no notion of these, so leave them out entirely.
        horizontalRule: {},
        // StarterKit ships Link; configuring ours below without disabling it
        // registered the extension twice ("Duplicate extension names found").
        link: false,
      }),
      Link.configure({ openOnClick: false, autolink: true }),
      // renderHTML only touches the DOM: `node.attrs.src` keeps the canonical
      // relative path, so serializing back to markdown never leaks a token.
      Image.extend({
        renderHTML({ HTMLAttributes }) {
          return ["img", { ...HTMLAttributes, src: mediaSrc(HTMLAttributes.src as string) }];
        },
      }).configure({ inline: false }),
      TaskList,
      TaskItem.configure({ nested: true }),
      // Not behind a prop, unlike the collapsibles: a table is plain GFM
      // markdown, so it widens nothing. And it isn't optional — without these
      // nodes the schema has nowhere to put a table it was handed, so opening
      // a description that already had one and saving flattened it to
      // "ColumnaOtraunodostrescuatro". Every editor needs them for that reason
      // alone, whether or not anyone types a table into it. See ./table.ts.
      ...tableExtensions,
      ...(collapsible ? collapsibleExtensions : []),
      ...(blockTools ? [SlashMenu] : []),
      Markdown.configure({
        html: false, // never smuggle raw HTML into the stored markdown
        transformPastedText: true,
        linkify: true,
        breaks: true,
      }),
    ],
    content: value,
    autofocus: autoFocus,
    editorProps: {
      attributes: {
        class: cn(
          "prose-editor focus:outline-none",
          "text-sm leading-relaxed",
        ),
        style: `min-height:${minHeight}`,
      },
      handlePaste: (_view, event) => takePasted(event.clipboardData, true),
      handleDrop: (_view, event) => takePasted((event as DragEvent).dataTransfer, false),
      // Plain click still just places the cursor — needed constantly while
      // editing a link's text. Only a held modifier "opens" it, mirroring how
      // Notion and Obsidian both do this in an editable page.
      handleClick: (_view, _pos, event) => {
        if (!event.metaKey && !event.ctrlKey) return false;
        const anchor = (event.target as HTMLElement)?.closest("a");
        const href = anchor?.getAttribute("href");
        if (!href) return false;
        event.preventDefault();
        if (onLinkClickRef.current) {
          onLinkClickRef.current(href);
          return true;
        }
        // No handler: open it anyway. Attaching a PDF puts a link in the body,
        // and only Notes ever wired one — so in a task description that link
        // did nothing on any click, which made the file decoration.
        void openAttachment(href, anchor?.textContent?.trim() || "file").catch(() => {});
        return true;
      },
    },
    onUpdate: ({ editor }) => {
      onChange(getMarkdown(editor));
      sweepLocalImagesRef.current?.();
    },
  });

  editorRef.current = editor ?? null;

  useImperativeHandle(
    ref,
    () => ({
      insertLink: (title, href) => {
        const ed = editorRef.current;
        if (!ed) return;
        ed.chain()
          .focus()
          .insertContent([
            { type: "text", text: title, marks: [{ type: "link", attrs: { href } }] },
            { type: "text", text: " " },
          ])
          .run();
      },
    }),
    [],
  );

  // Every local src we've already taken charge of, so the sweep below doesn't
  // fire twice for the same image (it runs on every update).
  const claimed = useRef(new Set<string>());

  /**
   * Uploads in flight, by name.
   *
   * A count was the first attempt and it wasn't enough: attaching a big PDF sat
   * there with nothing on screen, so the button read as broken and got pressed
   * again — five copies of the same file. Naming each one makes a second press
   * a decision instead of a guess, which is why the button stays enabled.
   */
  const [uploads, setUploads] = useState<{ id: number; name: string }[]>([]);
  const nextUploadId = useRef(0);
  const startUpload = useCallback((name: string) => {
    const id = nextUploadId.current++;
    setUploads((u) => [...u, { id, name }]);
    return () => setUploads((u) => u.filter((x) => x.id !== id));
  }, []);

  /**
   * Upload any local image sitting in the document and repoint it at the stored
   * copy.
   *
   * This exists because the clipboard route can't be trusted: WebKitGTK (the
   * Tauri webview on Linux) may hand a pasted screenshot over with no usable
   * `files`/`items` and no readable HTML flavour, so `handlePaste` sees nothing
   * and ProseMirror inserts an <img src="blob:…"> on its own. Whatever path the
   * image took in, by the time it is a node in the document we can see it — and
   * the blob is still alive, so it can be fetched and uploaded.
   */
  const sweepLocalImages = useCallback(() => {
    const ed = editorRef.current;
    const up = uploadRef.current;
    if (!ed || !up) return;

    const found: string[] = [];
    const stray: [string, string][] = [];
    ed.state.doc.descendants((node) => {
      if (node.type.name !== "image") return;
      const src = node.attrs.src;
      if (isLocalSrc(src)) {
        if (!claimed.current.has(src)) found.push(src);
        return;
      }
      // renderHTML() hands the DOM an absolute, tokenized URL; a DOM round-trip
      // can write that back into the node. Left alone it would be serialized —
      // storing the backend host and, worse, an access token. Canonicalize.
      if (typeof src === "string") {
        const path = attachmentPath(src);
        if (path && path !== src) stray.push([src, path]);
      }
    });

    for (const [src, path] of stray) retargetImage(ed, src, path, null);

    for (const src of found) {
      claimed.current.add(src);
      const done = startUpload("pasted image");
      void (async () => {
        try {
          const blob = await (await fetch(src)).blob();
          const type = blob.type || "image/png";
          const ext = (type.split("/")[1] ?? "png").replace("jpeg", "jpg");
          const res = await up(new File([blob], `pasted.${ext}`, { type }));
          if (!res) throw new Error("upload rejected");
          retargetImage(ed, src, res.url, res.fileName);
        } catch {
          // A dead reference is worse than no image: drop it and say so, instead
          // of leaving something that looks fine until the next reload.
          retargetImage(ed, src, null, null);
          toast.error("Couldn't attach the pasted image", {
            description: "Try the attach button, or paste it again.",
          });
        } finally {
          done();
        }
      })();
    }
  }, [startUpload]);

  sweepLocalImagesRef.current = sweepLocalImages;

  // Insert an uploaded file at the cursor: images as markdown images, anything
  // else as a link — markdown can't embed a PDF.
  //
  // The counter is the whole point of this being here and not inline: a big
  // file took seconds with nothing on screen, so it read as "the button does
  // nothing" and got clicked again. Five copies of the same PDF is what that
  // looks like from the other side.
  const insertUpload = useCallback(async (file: File) => {
    const upload = uploadRef.current;
    const ed = editorRef.current;
    if (!upload || !ed) return;
    const done = startUpload(file.name);
    try {
      const res = await upload(file);
      if (!res) throw new Error("upload rejected");
      if (file.type.startsWith("image/")) {
        ed.chain().focus().setImage({ src: res.url, alt: res.fileName }).run();
      } else {
        ed.chain().focus().insertContent(`[${res.fileName}](${res.url})`).run();
      }
    } catch {
      toast.error(`Couldn't attach ${file.name}`, {
        description: "Nothing was added. Try again.",
      });
    } finally {
      done();
    }
  }, [startUpload]);

  /** Sends one recovered image down whichever route the caller asked for. */
  const acceptFile = useCallback(async (file: File) => {
    if (filesRef.current) filesRef.current([file]);
    else await insertUpload(file);
  }, [insertUpload]);

  // Returning true tells ProseMirror we handled the event, so it won't also
  // paste the file name as plain text (or, worse, an <img src="blob:…">).
  //
  // `fromClipboard` separates a paste from a drop: only a paste may fall
  // through to reading the OS clipboard, since on a drop that would attach
  // whatever the user happened to copy earlier.
  const takePasted = (dt?: DataTransfer | null, fromClipboard = false): boolean => {
    if (!dt || (!uploadRef.current && !filesRef.current)) return false;

    // `files` is the happy path, but pasting a screenshot in a WebKit webview
    // often exposes the bitmap only through `items` — and then the HTML flavour
    // carries an <img src="blob:…">, which is what ProseMirror would have
    // inserted: a reference that dies with the page.
    const files = [
      ...Array.from(dt.files ?? []),
      ...Array.from(dt.items ?? [])
        .filter((i) => i.kind === "file")
        .map((i) => i.getAsFile())
        .filter((f): f is File => !!f),
    ];
    // De-dupe: an item and a file entry can describe the same bitmap.
    const seen = new Set<string>();
    const unique = files.filter((f) => {
      const key = `${f.name}:${f.size}:${f.type}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (unique.length > 0) {
      if (filesRef.current) {
        filesRef.current(unique);
      } else {
        void (async () => {
          for (const f of unique) await insertUpload(f);
        })();
      }
      return true;
    }

    // Next: pull the bitmaps out of the pasted HTML. The blob URLs are still
    // alive at this instant, so they can be fetched and uploaded — after the
    // paste settles they'd be unreachable.
    const local = localImageURLs(dt.getData("text/html"));
    if (local.length > 0) {
      void (async () => {
        for (const url of local) {
          try {
            const blob = await (await fetch(url)).blob();
            const ext = blob.type.split("/")[1] ?? "png";
            await insertUpload(new File([blob], `pasted.${ext}`, { type: blob.type }));
          } catch {
            // Unreachable blob: better to drop it than to store a dead link.
          }
        }
      })();
      return true;
    }

    // Last resort: the event carries an image the webview refused to hand
    // over — an <img> with its src stripped, or nothing at all. Ask the OS.
    // Swallowing the paste costs nothing here: neither shape would have
    // produced anything, since Tiptap only parses `img[src]`.
    if (fromClipboard && looksLikeStrippedImage(dt)) {
      void (async () => {
        const file = await readClipboardImage();
        if (!file) {
          toast.error("Couldn't read the image from the clipboard", {
            description: "Try the attach button, or save it to a file and drop it in.",
          });
          return;
        }
        await acceptFile(file);
      })();
      return true;
    }

    return false;
  };

  // Adopt external changes (e.g. the drawer switched to another task) without
  // clobbering what the user is typing.
  useEffect(() => {
    if (!editor) return;
    const current = getMarkdown(editor);
    if (value !== current) {
      editor.commands.setContent(value, { emitUpdate: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, editor]);

  if (!editor) {
    return (
      <div className="flex items-center justify-center rounded-md border p-4 text-xs text-muted-foreground" style={{ minHeight }}>
        <Loader2 className="mr-2 size-3 animate-spin" /> Loading editor…
      </div>
    );
  }

  return (
    <div className={cn("rounded-md border bg-background", className)}>
      <Toolbar
        editor={editor}
        onPickFile={onUpload ? insertUpload : undefined}
        collapsible={collapsible}
      />
      {uploads.length > 0 && (
        <ul className="border-b bg-muted/40 px-3 py-1">
          {uploads.map((u) => (
            <li key={u.id} className="flex items-center gap-1.5 py-0.5 text-xs text-muted-foreground">
              <Loader2 className="size-3 shrink-0 animate-spin" />
              <span className="truncate">{u.name}</span>
              <span className="ml-auto shrink-0">uploading… don't save yet</span>
            </li>
          ))}
        </ul>
      )}
      <div className="px-3 py-2">
        {blockTools && (
          <DragHandle editor={editor}>
            <div
              className="flex size-5 cursor-grab items-center justify-center rounded
                         text-muted-foreground/60 hover:bg-accent hover:text-foreground
                         active:cursor-grabbing"
              title="Drag to move this block"
            >
              <GripVertical className="size-3.5" />
            </div>
          </DragHandle>
        )}
        <EditorContent editor={editor} />
        {editor.isEmpty && (
          <p className="pointer-events-none -mt-[1.6rem] text-sm text-muted-foreground/60">
            {placeholder}
          </p>
        )}
      </div>
    </div>
  );
});

export default MarkdownEditor;

function Toolbar({
  editor,
  onPickFile,
  collapsible,
}: {
  editor: Editor;
  onPickFile?: (file: File) => void;
  collapsible?: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const prompt = usePrompt();

  const Btn = ({
    icon: Icon,
    label,
    active,
    onClick,
  }: {
    icon: typeof Bold;
    label: string;
    active?: boolean;
    onClick: () => void;
  }) => (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground",
        active && "bg-accent text-foreground",
      )}
    >
      <Icon className="size-3.5" />
    </button>
  );

  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b px-2 py-1">
      <Btn icon={Bold} label="Bold" active={editor.isActive("bold")}
        onClick={() => editor.chain().focus().toggleBold().run()} />
      <Btn icon={Italic} label="Italic" active={editor.isActive("italic")}
        onClick={() => editor.chain().focus().toggleItalic().run()} />
      <Btn icon={Code} label="Code" active={editor.isActive("code")}
        onClick={() => editor.chain().focus().toggleCode().run()} />
      <span className="mx-1 h-4 w-px bg-border" />
      <Btn icon={Heading2} label="Heading" active={editor.isActive("heading", { level: 2 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} />
      <Btn icon={List} label="Bullet list" active={editor.isActive("bulletList")}
        onClick={() => editor.chain().focus().toggleBulletList().run()} />
      <Btn icon={ListOrdered} label="Numbered list" active={editor.isActive("orderedList")}
        onClick={() => editor.chain().focus().toggleOrderedList().run()} />
      <Btn icon={ListChecks} label="Checklist" active={editor.isActive("taskList")}
        onClick={() => editor.chain().focus().toggleTaskList().run()} />
      <Btn icon={Quote} label="Quote" active={editor.isActive("blockquote")}
        onClick={() => editor.chain().focus().toggleBlockquote().run()} />
      <Btn
        icon={TableIcon}
        label="Table"
        active={editor.isActive("table")}
        onClick={() =>
          editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
        }
      />
      {collapsible && (
        <Btn
          icon={ChevronRight}
          label="Collapsible section"
          active={editor.isActive("details")}
          onClick={() => {
            if (editor.isActive("details")) editor.chain().focus().unsetDetails().run();
            else editor.chain().focus().setDetails().run();
          }}
        />
      )}
      <Btn icon={Link2} label="Link" active={editor.isActive("link")}
        onClick={async () => {
          const prev = editor.getAttributes("link").href as string | undefined;
          // allowEmpty: clearing the field is how you remove an existing link,
          // which has to stay distinguishable from cancelling (null).
          const url = await prompt({
            title: prev ? "Edit link" : "Add link",
            label: "URL",
            defaultValue: prev ?? "https://",
            allowEmpty: true,
            confirmText: "Apply",
          });
          if (url === null) return;
          if (url.trim() === "") {
            editor.chain().focus().unsetLink().run();
            return;
          }
          editor.chain().focus().setLink({ href: url }).run();
        }} />
      {onPickFile && (
        <>
          <span className="mx-1 h-4 w-px bg-border" />
          <Btn icon={Paperclip} label="Attach file" onClick={() => fileRef.current?.click()} />
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onPickFile(f);
              e.target.value = "";
            }}
          />
        </>
      )}
      <span className="ml-auto text-xs text-muted-foreground">
        markdown · paste or drop files
      </span>
    </div>
  );
}
