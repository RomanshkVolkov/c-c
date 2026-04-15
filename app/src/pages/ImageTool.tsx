import { useState, useCallback, useRef } from "react";
import {
  ImageDown,
  Upload,
  Download,
  Trash2,
  FileImage,
  ArrowRight,
  Loader2,
  Check,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const OUTPUT_FORMATS = [
  { value: "webp", label: "WebP" },
  { value: "jpeg", label: "JPEG" },
  { value: "png", label: "PNG" },
  { value: "avif", label: "AVIF" },
  { value: "gif", label: "GIF" },
  { value: "bmp", label: "BMP" },
];

const INPUT_ACCEPT =
  "image/png,image/jpeg,image/webp,image/gif,image/bmp,image/tiff,image/avif,image/svg+xml,image/x-icon";

interface CompressedFile {
  id: string;
  name: string;
  originalBytes: number;
  compressedBytes: number;
  format: string;
  mime: string;
  width: number;
  height: number;
  data: Uint8Array;
  previewUrl: string;
}

type DownloadStatus = "idle" | "saving" | "done" | "error";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function reductionPercent(original: number, compressed: number): string {
  if (original === 0) return "0%";
  const pct = ((1 - compressed / original) * 100).toFixed(1);
  return `${pct}%`;
}

export default function ImageTool() {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [format, setFormat] = useState("webp");
  const [quality, setQuality] = useState(85);
  const [maxWidth, setMaxWidth] = useState<string>("");
  const [results, setResults] = useState<CompressedFile[]>([]);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [downloadStatus, setDownloadStatus] = useState<Record<string, DownloadStatus>>({});
  const [downloadAllStatus, setDownloadAllStatus] = useState<DownloadStatus>("idle");

  const setItemStatus = (id: string, status: DownloadStatus) => {
    setDownloadStatus((prev) => ({ ...prev, [id]: status }));
    if (status === "done") {
      setTimeout(() => {
        setDownloadStatus((prev) => ({ ...prev, [id]: "idle" }));
      }, 2000);
    }
  };

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      setProcessing(true);
      setError(null);

      const newResults: CompressedFile[] = [];

      for (const file of Array.from(files)) {
        try {
          const arrayBuffer = await file.arrayBuffer();
          const data = Array.from(new Uint8Array(arrayBuffer));

          const result = await invoke<{
            data: number[];
            format: string;
            mime: string;
            width: number;
            height: number;
            original_bytes: number;
            compressed_bytes: number;
          }>("compress_image", {
            data,
            quality,
            maxWidth: maxWidth ? parseInt(maxWidth, 10) : null,
            format,
          });

          const outData = new Uint8Array(result.data);
          const blob = new Blob([outData], { type: result.mime });
          const previewUrl = URL.createObjectURL(blob);

          const baseName = file.name.replace(/\.[^.]+$/, "");

          newResults.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: `${baseName}.${result.format}`,
            originalBytes: result.original_bytes,
            compressedBytes: result.compressed_bytes,
            format: result.format,
            mime: result.mime,
            width: result.width,
            height: result.height,
            data: outData,
            previewUrl,
          });
        } catch (e) {
          setError(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      setResults((prev) => [...newResults, ...prev]);
      setProcessing(false);

      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [format, quality, maxWidth],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      handleFiles(e.dataTransfer.files);
    },
    [handleFiles],
  );

  const downloadFile = async (item: CompressedFile) => {
    setItemStatus(item.id, "saving");
    try {
      const saved = await invoke<boolean>("save_file", {
        data: Array.from(item.data),
        fileName: item.name,
        filterName: item.format.toUpperCase(),
        filterExt: item.format,
      });
      setItemStatus(item.id, saved ? "done" : "idle");
    } catch {
      setItemStatus(item.id, "error");
      setTimeout(() => setItemStatus(item.id, "idle"), 2000);
    }
  };

  const downloadAll = async () => {
    setDownloadAllStatus("saving");
    let saved = 0;
    for (const item of results) {
      setItemStatus(item.id, "saving");
      try {
        const ok = await invoke<boolean>("save_file", {
          data: Array.from(item.data),
          fileName: item.name,
          filterName: item.format.toUpperCase(),
          filterExt: item.format,
        });
        if (ok) {
          setItemStatus(item.id, "done");
          saved++;
        } else {
          setItemStatus(item.id, "idle");
        }
      } catch {
        setItemStatus(item.id, "error");
        setTimeout(() => setItemStatus(item.id, "idle"), 2000);
      }
    }
    setDownloadAllStatus(saved > 0 ? "done" : "idle");
    if (saved > 0) {
      setTimeout(() => setDownloadAllStatus("idle"), 2000);
    }
  };

  const removeItem = (id: string) => {
    setResults((prev) => {
      const item = prev.find((r) => r.id === id);
      if (item) URL.revokeObjectURL(item.previewUrl);
      return prev.filter((r) => r.id !== id);
    });
    setDownloadStatus((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const clearAll = () => {
    results.forEach((r) => URL.revokeObjectURL(r.previewUrl));
    setResults([]);
    setDownloadStatus({});
  };

  const totalOriginal = results.reduce((sum, r) => sum + r.originalBytes, 0);
  const totalCompressed = results.reduce((sum, r) => sum + r.compressedBytes, 0);

  const DownloadIcon = ({ status }: { status: DownloadStatus }) => {
    if (status === "saving") return <Loader2 className="h-3 w-3 animate-spin" />;
    if (status === "done") return <Check className="h-3 w-3 text-green-500" />;
    return <Download className="h-3 w-3" />;
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex-1 overflow-auto p-6 space-y-4 max-w-5xl mx-auto w-full">
        <div className="flex items-center gap-3">
          <ImageDown className="h-6 w-6 text-muted-foreground" />
          <h1 className="text-xl font-semibold">Image Tool</h1>
        </div>

        {/* Options */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Compression Settings</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs">Output Format</Label>
                <Select value={format} onValueChange={(v) => v && setFormat(v)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {OUTPUT_FORMATS.map((f) => (
                      <SelectItem key={f.value} value={f.value}>
                        {f.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">
                  Quality ({quality})
                </Label>
                <Input
                  type="range"
                  min={1}
                  max={100}
                  value={quality}
                  onChange={(e) => setQuality(parseInt(e.target.value, 10))}
                  className="h-9"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Max Width (px)</Label>
                <Input
                  type="number"
                  placeholder="Original"
                  value={maxWidth}
                  onChange={(e) => setMaxWidth(e.target.value)}
                  min={1}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Drop Zone */}
        <Card>
          <CardContent className="pt-6">
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className="border-2 border-dashed rounded-lg p-10 text-center cursor-pointer transition-colors hover:border-primary hover:bg-accent/30"
            >
              <Upload className="h-8 w-8 mx-auto mb-3 text-muted-foreground" />
              <p className="text-sm font-medium">
                {processing ? "Processing..." : "Drop images here or click to browse"}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                PNG, JPEG, WebP, GIF, BMP, TIFF, AVIF, SVG, ICO
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept={INPUT_ACCEPT}
                multiple
                className="hidden"
                onChange={(e) => handleFiles(e.target.files)}
              />
            </div>
            {error && <p className="text-sm text-destructive mt-3">{error}</p>}
          </CardContent>
        </Card>

        {/* Results */}
        {results.length > 0 && (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <FileImage className="h-4 w-4" />
                  Results ({results.length})
                  {totalOriginal > 0 && (
                    <Badge variant="secondary" className="ml-2 font-mono text-xs">
                      {formatBytes(totalOriginal)}
                      <ArrowRight className="h-3 w-3 mx-1 inline" />
                      {formatBytes(totalCompressed)}
                      <span className="ml-1 text-green-500">
                        (-{reductionPercent(totalOriginal, totalCompressed)})
                      </span>
                    </Badge>
                  )}
                </CardTitle>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={downloadAll}
                    disabled={downloadAllStatus === "saving"}
                  >
                    <DownloadIcon status={downloadAllStatus} />
                    <span className="ml-1">
                      {downloadAllStatus === "saving"
                        ? "Saving..."
                        : downloadAllStatus === "done"
                          ? "Saved!"
                          : "Download All"}
                    </span>
                  </Button>
                  <Button size="sm" variant="ghost" onClick={clearAll}>
                    <Trash2 className="h-3 w-3 mr-1" />
                    Clear
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12">Preview</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Dimensions</TableHead>
                    <TableHead>Original</TableHead>
                    <TableHead>Compressed</TableHead>
                    <TableHead>Saved</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {results.map((item) => {
                    const status = downloadStatus[item.id] ?? "idle";
                    return (
                      <TableRow key={item.id}>
                        <TableCell>
                          <img
                            src={item.previewUrl}
                            alt={item.name}
                            className="h-8 w-8 rounded object-cover"
                          />
                        </TableCell>
                        <TableCell className="font-mono text-xs">{item.name}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {item.width} x {item.height}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatBytes(item.originalBytes)}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatBytes(item.compressedBytes)}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              item.compressedBytes < item.originalBytes
                                ? "default"
                                : "destructive"
                            }
                            className="text-xs"
                          >
                            {item.compressedBytes < item.originalBytes ? "-" : "+"}
                            {reductionPercent(item.originalBytes, item.compressedBytes)}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right space-x-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => downloadFile(item)}
                            disabled={status === "saving"}
                          >
                            <DownloadIcon status={status} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            onClick={() => removeItem(item.id)}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
