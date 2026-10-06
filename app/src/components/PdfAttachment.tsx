import { useState } from "react";
import PdfCard from "@/components/PdfCard";
import PdfPreview from "@/components/PdfPreview";

/** Si un adjunto es un PDF, por su nombre. */
export const isPdfFile = (fileName: string) => /\.pdf$/i.test(fileName.trim());

/**
 * Un PDF de una lista de adjuntos (los de una tarea, los de un doc): la
 * tarjeta con su primera página, y su visor. Antes salía como un enlace con el
 * nombre, y en los docs ni abría el visor: iba al programa del sistema.
 */
export default function PdfAttachment({
  url,
  fileName,
  onRemove,
}: {
  url: string;
  fileName: string;
  onRemove?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <PdfCard url={url} fileName={fileName} onOpen={() => setOpen(true)} onRemove={onRemove} />
      {open && <PdfPreview url={url} fileName={fileName} onClose={() => setOpen(false)} />}
    </>
  );
}
