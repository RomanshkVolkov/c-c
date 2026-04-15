import { useState } from "react";
import { Send, Plus, Trash2, Loader2, Copy, Check } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

const METHOD_COLORS: Record<string, string> = {
  GET: "text-green-500",
  POST: "text-yellow-500",
  PUT: "text-blue-500",
  PATCH: "text-purple-500",
  DELETE: "text-red-500",
  HEAD: "text-muted-foreground",
  OPTIONS: "text-muted-foreground",
};

interface KeyValue {
  key: string;
  value: string;
  enabled: boolean;
}

interface HttpResponse {
  status: number;
  status_text: string;
  headers: KeyValue[];
  body: string;
  size_bytes: number;
  elapsed_ms: number;
}

function statusVariant(status: number): "default" | "secondary" | "destructive" {
  if (status < 300) return "default";
  if (status < 400) return "secondary";
  return "destructive";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function tryFormatJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export default function RequestClient() {
  const [method, setMethod] = useState<string>("GET");
  const [url, setUrl] = useState("");
  const [activeTab, setActiveTab] = useState<"headers" | "body">("headers");
  const [responseTab, setResponseTab] = useState<"body" | "headers">("body");

  const [headers, setHeaders] = useState<KeyValue[]>([
    { key: "Content-Type", value: "application/json", enabled: true },
  ]);
  const [body, setBody] = useState("");

  const [response, setResponse] = useState<HttpResponse | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const updateHeader = (idx: number, field: keyof KeyValue, val: string | boolean) => {
    setHeaders((prev) =>
      prev.map((h, i) => (i === idx ? { ...h, [field]: val } : h)),
    );
  };

  const addHeader = () => {
    setHeaders((prev) => [...prev, { key: "", value: "", enabled: true }]);
  };

  const removeHeader = (idx: number) => {
    setHeaders((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleSend = async () => {
    if (!url.trim()) return;
    setSending(true);
    setError(null);
    setResponse(null);

    try {
      const res = await invoke<HttpResponse>("send_http_request", {
        method,
        url: url.trim(),
        headers,
        body: body.trim() || null,
      });
      setResponse(res);
      setResponseTab("body");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const copyBody = () => {
    if (!response) return;
    navigator.clipboard.writeText(response.body);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const tabClass = (active: boolean) =>
    `px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
      active
        ? "border-b-2 border-primary text-foreground"
        : "text-muted-foreground hover:text-foreground"
    }`;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex-1 overflow-auto p-6 space-y-4 max-w-5xl mx-auto w-full">
        <div className="flex items-center gap-3">
          <Send className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-xl font-semibold">Request Client</h1>
        </div>

        {/* URL bar */}
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex gap-2">
              <Select value={method} onValueChange={(v) => v && setMethod(v)}>
                <SelectTrigger className="w-32">
                  <SelectValue>
                    <span className={METHOD_COLORS[method]}>{method}</span>
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {METHODS.map((m) => (
                    <SelectItem key={m} value={m}>
                      <span className={METHOD_COLORS[m]}>{m}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                placeholder="https://api.example.com/endpoint"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className="flex-1 font-mono text-sm"
                onKeyDown={(e) => e.key === "Enter" && handleSend()}
              />
              <Button onClick={handleSend} disabled={sending || !url.trim()}>
                {sending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                <span className="ml-1.5">Send</span>
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Request config */}
        <Card>
          <div className="flex border-b px-4">
            <button
              className={tabClass(activeTab === "headers")}
              onClick={() => setActiveTab("headers")}
            >
              Headers ({headers.filter((h) => h.enabled && h.key).length})
            </button>
            <button
              className={tabClass(activeTab === "body")}
              onClick={() => setActiveTab("body")}
            >
              Body
            </button>
          </div>

          <CardContent className="pt-4">
            {activeTab === "headers" && (
              <div className="space-y-2">
                {headers.map((h, idx) => (
                  <div key={idx} className="flex gap-2 items-center">
                    <input
                      type="checkbox"
                      checked={h.enabled}
                      onChange={(e) => updateHeader(idx, "enabled", e.target.checked)}
                      className="shrink-0"
                    />
                    <Input
                      placeholder="Key"
                      value={h.key}
                      onChange={(e) => updateHeader(idx, "key", e.target.value)}
                      className="flex-1 font-mono text-xs h-8"
                    />
                    <Input
                      placeholder="Value"
                      value={h.value}
                      onChange={(e) => updateHeader(idx, "value", e.target.value)}
                      className="flex-1 font-mono text-xs h-8"
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => removeHeader(idx)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
                <Button variant="outline" size="sm" onClick={addHeader}>
                  <Plus className="h-3 w-3 mr-1" />
                  Add Header
                </Button>
              </div>
            )}

            {activeTab === "body" && (
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">
                  Raw body (JSON, XML, text, etc.)
                </Label>
                <Textarea
                  placeholder='{"key": "value"}'
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  className="font-mono text-xs min-h-[160px] resize-y"
                />
              </div>
            )}
          </CardContent>
        </Card>

        {/* Error */}
        {error && (
          <Card>
            <CardContent className="pt-4 pb-4">
              <p className="text-sm text-destructive font-mono">{error}</p>
            </CardContent>
          </Card>
        )}

        {/* Response */}
        {response && (
          <Card>
            <div className="flex items-center justify-between border-b px-4 py-2">
              <div className="flex items-center gap-3">
                <Badge variant={statusVariant(response.status)} className="font-mono">
                  {response.status} {response.status_text}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {response.elapsed_ms}ms
                </span>
                <span className="text-xs text-muted-foreground">
                  {formatSize(response.size_bytes)}
                </span>
              </div>
              <div className="flex gap-1">
                <button
                  className={tabClass(responseTab === "body")}
                  onClick={() => setResponseTab("body")}
                >
                  Body
                </button>
                <button
                  className={tabClass(responseTab === "headers")}
                  onClick={() => setResponseTab("headers")}
                >
                  Headers ({response.headers.length})
                </button>
              </div>
            </div>

            <CardContent className="pt-4">
              {responseTab === "body" && (
                <div className="relative">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="absolute top-0 right-0 z-10"
                    onClick={copyBody}
                  >
                    {copied ? (
                      <Check className="h-3 w-3 text-green-500" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                  </Button>
                  <pre className="font-mono text-xs bg-muted/50 rounded-md p-4 overflow-auto max-h-[500px] whitespace-pre-wrap break-all">
                    {tryFormatJson(response.body) || "(empty)"}
                  </pre>
                </div>
              )}

              {responseTab === "headers" && (
                <div className="space-y-1">
                  {response.headers.map((h, idx) => (
                    <div key={idx} className="flex gap-2 font-mono text-xs">
                      <span className="text-muted-foreground min-w-[180px] shrink-0">
                        {h.key}:
                      </span>
                      <span className="break-all">{h.value}</span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
