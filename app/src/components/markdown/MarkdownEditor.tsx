import { useCallback, useEffect, useRef } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
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
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { usePrompt } from "@/components/PromptDialog";
import { mediaSrc } from "@/lib/media";

/**
 * WYSIWYG editor whose stored value is **markdown**, not HTML or ProseMirror
 * JSON. That keeps descriptions readable by everything else (exports, the MCP
 * server, plain `grep`) instead of only by the editor that wrote them.
 *
 * The extension set is deliberately limited to what markdown can express: any
 * richer node (text colour, custom blocks) would be silently lost on the next
 * round-trip, so it isn't offered in the first place.
 */
/** tiptap-markdown augments `editor.storage` at runtime but ships no types. */
function getMarkdown(editor: Editor): string {
  const storage = editor.storage as unknown as {
    markdown?: { getMarkdown: () => string };
  };
  return storage.markdown?.getMarkdown() ?? "";
}

export interface MarkdownEditorProps {
  value: string;
  onChange: (markdown: string) => void;
  placeholder?: string;
  /** Uploads a pasted/dropped file and returns its public URL. */
  onUpload?: (file: File) => Promise<{ url: string; fileName: string } | null>;
  className?: string;
  minHeight?: string;
  autoFocus?: boolean;
}

export default function MarkdownEditor({
  value,
  onChange,
  placeholder = "Write in markdown…",
  onUpload,
  className,
  minHeight = "8rem",
  autoFocus,
}: MarkdownEditorProps) {
  // The paste/drop handlers live inside the editor's own options, so they can't
  // close over `editor` itself — that would be a circular reference (and an
  // untypeable one). They read it back through this ref instead.
  const editorRef = useRef<Editor | null>(null);
  const uploadRef = useRef<MarkdownEditorProps["onUpload"]>(onUpload);
  uploadRef.current = onUpload;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        // Markdown has no notion of these, so leave them out entirely.
        horizontalRule: {},
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
      handlePaste: (_view, event) => takeFiles(event.clipboardData?.files),
      handleDrop: (_view, event) => takeFiles((event as DragEvent).dataTransfer?.files),
    },
    onUpdate: ({ editor }) => {
      onChange(getMarkdown(editor));
    },
  });

  editorRef.current = editor ?? null;

  // Insert an uploaded file at the cursor: images as markdown images, anything
  // else as a link — markdown can't embed a PDF.
  const insertUpload = useCallback(async (file: File) => {
    const upload = uploadRef.current;
    const ed = editorRef.current;
    if (!upload || !ed) return;
    const res = await upload(file);
    if (!res) return;
    if (file.type.startsWith("image/")) {
      ed.chain().focus().setImage({ src: res.url, alt: res.fileName }).run();
    } else {
      ed.chain().focus().insertContent(`[${res.fileName}](${res.url})`).run();
    }
  }, []);

  // Returning true tells ProseMirror we handled the event, so it won't also
  // paste the file name as plain text.
  const takeFiles = (files?: FileList | null): boolean => {
    if (!files?.length || !uploadRef.current) return false;
    const list = Array.from(files);
    void (async () => {
      for (const f of list) await insertUpload(f);
    })();
    return true;
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
      <Toolbar editor={editor} onPickFile={onUpload ? insertUpload : undefined} />
      <div className="px-3 py-2">
        <EditorContent editor={editor} />
        {editor.isEmpty && (
          <p className="pointer-events-none -mt-[1.6rem] text-sm text-muted-foreground/60">
            {placeholder}
          </p>
        )}
      </div>
    </div>
  );
}

function Toolbar({
  editor,
  onPickFile,
}: {
  editor: Editor;
  onPickFile?: (file: File) => void;
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
      <span className="ml-auto text-[10px] text-muted-foreground">
        markdown · paste or drop files
      </span>
    </div>
  );
}
