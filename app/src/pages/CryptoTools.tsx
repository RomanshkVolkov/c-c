import { useState } from "react";
import {
  KeyRound,
  Copy,
  Check,
  RefreshCw,
  ShieldCheck,
  ShieldX,
  Loader2,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
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

type Section = "jwt" | "ids" | "hash" | "password" | "encode";

const SECTIONS: { key: Section; label: string }[] = [
  { key: "jwt", label: "JWT" },
  { key: "ids", label: "ID Generator" },
  { key: "hash", label: "Hash / HMAC" },
  { key: "password", label: "Password Hash" },
  { key: "encode", label: "Encode / Decode" },
];

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 1500);
  };
  return { copied, copy };
}

function CopyBtn({ text, id, copied, copy }: {
  text: string;
  id: string;
  copied: string | null;
  copy: (text: string, id: string) => void;
}) {
  return (
    <Button variant="ghost" size="sm" onClick={() => copy(text, id)} className="shrink-0">
      {copied === id ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
    </Button>
  );
}

function OutputBox({ value, id, copied, copy }: {
  value: string;
  id: string;
  copied: string | null;
  copy: (text: string, id: string) => void;
}) {
  if (!value) return null;
  return (
    <div className="relative">
      <div className="absolute top-1 right-1">
        <CopyBtn text={value} id={id} copied={copied} copy={copy} />
      </div>
      <pre className="font-mono text-xs bg-muted/50 rounded-md p-3 pr-10 overflow-auto max-h-[300px] whitespace-pre-wrap break-all">
        {value}
      </pre>
    </div>
  );
}

// ─── JWT Section ─────────────────────────────────────────────────────────────

function JwtSection() {
  const { copied, copy } = useCopy();
  const [token, setToken] = useState("");
  const [secret, setSecret] = useState("");
  const [algorithm, setAlgorithm] = useState("HS256");
  const [result, setResult] = useState<{
    header: string;
    payload: string;
    signature_valid: boolean | null;
    error: string | null;
  } | null>(null);

  const decode = async () => {
    if (!token.trim()) return;
    const res = await invoke<typeof result>("jwt_decode", {
      token: token.trim(),
      secret: secret.trim() || null,
      algorithm: secret.trim() ? algorithm : null,
    });
    setResult(res);
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label className="text-xs">JWT Token</Label>
        <Textarea
          placeholder="eyJhbGciOiJIUzI1NiIs..."
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="font-mono text-xs min-h-[80px]"
        />
      </div>
      <div className="flex gap-2 items-end">
        <div className="flex-1 space-y-2">
          <Label className="text-xs">Secret (optional, for signature verification)</Label>
          <Input
            type="password"
            placeholder="your-secret-key"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            className="font-mono text-xs"
          />
        </div>
        <div className="w-28 space-y-2">
          <Label className="text-xs">Algorithm</Label>
          <Select value={algorithm} onValueChange={(v) => v && setAlgorithm(v)}>
            <SelectTrigger className="text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["HS256", "HS384", "HS512"].map((a) => (
                <SelectItem key={a} value={a}>{a}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={decode} disabled={!token.trim()}>Decode</Button>
      </div>
      {result?.error && <p className="text-sm text-destructive">{result.error}</p>}
      {result && !result.error && (
        <div className="space-y-3">
          {result.signature_valid !== null && (
            <div className="flex items-center gap-2">
              {result.signature_valid ? (
                <Badge variant="default" className="gap-1">
                  <ShieldCheck className="h-3 w-3" /> Signature Valid
                </Badge>
              ) : (
                <Badge variant="destructive" className="gap-1">
                  <ShieldX className="h-3 w-3" /> Signature Invalid
                </Badge>
              )}
            </div>
          )}
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Header</Label>
            <OutputBox value={result.header} id="jwt-header" copied={copied} copy={copy} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Payload</Label>
            <OutputBox value={result.payload} id="jwt-payload" copied={copied} copy={copy} />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── ID Generator ────────────────────────────────────────────────────────────

function IdSection() {
  const { copied, copy } = useCopy();
  const [kind, setKind] = useState("uuid-v4");
  const [count, setCount] = useState(1);
  const [ids, setIds] = useState<string[]>([]);

  const generate = async () => {
    const results: string[] = [];
    for (let i = 0; i < count; i++) {
      const id = await invoke<string>("generate_id", { kind });
      results.push(id);
    }
    setIds(results);
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-2 items-end">
        <div className="w-40 space-y-2">
          <Label className="text-xs">Type</Label>
          <Select value={kind} onValueChange={(v) => v && setKind(v)}>
            <SelectTrigger className="text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="uuid-v4">UUID v4</SelectItem>
              <SelectItem value="uuid-v7">UUID v7</SelectItem>
              <SelectItem value="cuid2">CUID2</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="w-24 space-y-2">
          <Label className="text-xs">Count</Label>
          <Input
            type="number"
            min={1}
            max={100}
            value={count}
            onChange={(e) => setCount(Math.min(100, Math.max(1, parseInt(e.target.value) || 1)))}
            className="text-xs"
          />
        </div>
        <Button onClick={generate}>
          <RefreshCw className="h-4 w-4 mr-1" /> Generate
        </Button>
      </div>
      {ids.length > 0 && (
        <div className="space-y-1">
          {ids.map((id, i) => (
            <div key={i} className="flex items-center gap-2 font-mono text-xs bg-muted/50 rounded px-3 py-1.5">
              <span className="flex-1 break-all">{id}</span>
              <CopyBtn text={id} id={`id-${i}`} copied={copied} copy={copy} />
            </div>
          ))}
          {ids.length > 1 && (
            <Button variant="outline" size="sm" onClick={() => copy(ids.join("\n"), "id-all")}>
              {copied === "id-all" ? <Check className="h-3 w-3 mr-1" /> : <Copy className="h-3 w-3 mr-1" />}
              Copy All
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Hash / HMAC ─────────────────────────────────────────────────────────────

function HashSection() {
  const { copied, copy } = useCopy();
  const [input, setInput] = useState("");
  const [algorithm, setAlgorithm] = useState("sha256");
  const [hmacKey, setHmacKey] = useState("");
  const [output, setOutput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const isHmac = algorithm.startsWith("hmac-");

  const compute = async () => {
    if (!input.trim()) return;
    setError(null);
    try {
      if (isHmac) {
        const res = await invoke<{ hash: string }>("hmac_sign", {
          input: input, key: hmacKey, algorithm,
        });
        setOutput(res.hash);
      } else {
        const res = await invoke<{ hash: string }>("hash_text", {
          input: input, algorithm,
        });
        setOutput(res.hash);
      }
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label className="text-xs">Input</Label>
        <Textarea
          placeholder="Text to hash..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          className="font-mono text-xs min-h-[80px]"
        />
      </div>
      <div className="flex gap-2 items-end">
        <div className="w-44 space-y-2">
          <Label className="text-xs">Algorithm</Label>
          <Select value={algorithm} onValueChange={(v) => v && setAlgorithm(v)}>
            <SelectTrigger className="text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="md5">MD5</SelectItem>
              <SelectItem value="sha256">SHA-256</SelectItem>
              <SelectItem value="sha384">SHA-384</SelectItem>
              <SelectItem value="sha512">SHA-512</SelectItem>
              <SelectItem value="hmac-sha256">HMAC-SHA256</SelectItem>
              <SelectItem value="hmac-sha512">HMAC-SHA512</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {isHmac && (
          <div className="flex-1 space-y-2">
            <Label className="text-xs">Secret Key</Label>
            <Input
              type="password"
              placeholder="HMAC key"
              value={hmacKey}
              onChange={(e) => setHmacKey(e.target.value)}
              className="font-mono text-xs"
            />
          </div>
        )}
        <Button onClick={compute} disabled={!input.trim()}>Hash</Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <OutputBox value={output} id="hash-out" copied={copied} copy={copy} />
    </div>
  );
}

// ─── Password Hash ───────────────────────────────────────────────────────────

function PasswordSection() {
  const { copied, copy } = useCopy();
  const [input, setInput] = useState("");
  const [algorithm, setAlgorithm] = useState("bcrypt");
  const [cost, setCost] = useState(12);
  const [output, setOutput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [verifyHash, setVerifyHash] = useState("");
  const [verifyResult, setVerifyResult] = useState<boolean | null>(null);
  const [verifying, setVerifying] = useState(false);

  const generate = async () => {
    if (!input.trim()) return;
    setLoading(true);
    setError(null);
    try {
      if (algorithm === "bcrypt") {
        const res = await invoke<string>("bcrypt_hash", { input, cost });
        setOutput(res);
      } else {
        const res = await invoke<string>("argon2_hash", { input });
        setOutput(res);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const verify = async () => {
    if (!input.trim() || !verifyHash.trim()) return;
    setVerifying(true);
    setVerifyResult(null);
    try {
      const cmd = algorithm === "bcrypt" ? "bcrypt_verify" : "argon2_verify";
      const res = await invoke<boolean>(cmd, { input, hash: verifyHash.trim() });
      setVerifyResult(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-2 items-end">
        <div className="flex-1 space-y-2">
          <Label className="text-xs">Password</Label>
          <Input
            placeholder="password to hash"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="font-mono text-xs"
          />
        </div>
        <div className="w-32 space-y-2">
          <Label className="text-xs">Algorithm</Label>
          <Select value={algorithm} onValueChange={(v) => v && setAlgorithm(v)}>
            <SelectTrigger className="text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="bcrypt">Bcrypt</SelectItem>
              <SelectItem value="argon2">Argon2</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {algorithm === "bcrypt" && (
          <div className="w-20 space-y-2">
            <Label className="text-xs">Cost</Label>
            <Input
              type="number"
              min={4}
              max={31}
              value={cost}
              onChange={(e) => setCost(parseInt(e.target.value) || 12)}
              className="text-xs"
            />
          </div>
        )}
        <Button onClick={generate} disabled={!input.trim() || loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Hash"}
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <OutputBox value={output} id="pw-out" copied={copied} copy={copy} />

      <div className="border-t pt-4 space-y-3">
        <Label className="text-xs font-medium">Verify</Label>
        <div className="flex gap-2 items-end">
          <div className="flex-1 space-y-2">
            <Label className="text-xs text-muted-foreground">Hash to verify against</Label>
            <Input
              placeholder="$2b$12$... or $argon2id$..."
              value={verifyHash}
              onChange={(e) => { setVerifyHash(e.target.value); setVerifyResult(null); }}
              className="font-mono text-xs"
            />
          </div>
          <Button
            variant="outline"
            onClick={verify}
            disabled={!input.trim() || !verifyHash.trim() || verifying}
          >
            {verifying ? <Loader2 className="h-4 w-4 animate-spin" /> : "Verify"}
          </Button>
        </div>
        {verifyResult !== null && (
          <Badge variant={verifyResult ? "default" : "destructive"} className="gap-1">
            {verifyResult ? (
              <><ShieldCheck className="h-3 w-3" /> Match</>
            ) : (
              <><ShieldX className="h-3 w-3" /> No Match</>
            )}
          </Badge>
        )}
      </div>
    </div>
  );
}

// ─── Encode / Decode ─────────────────────────────────────────────────────────

function EncodeSection() {
  const { copied, copy } = useCopy();
  const [input, setInput] = useState("");
  const [codec, setCodec] = useState("base64");
  const [output, setOutput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const run = async (direction: "encode" | "decode") => {
    if (!input.trim()) return;
    setError(null);
    try {
      const res = await invoke<string>("encode_decode", {
        input, codec, direction,
      });
      setOutput(res);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label className="text-xs">Input</Label>
        <Textarea
          placeholder="Text to encode or decode..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          className="font-mono text-xs min-h-[80px]"
        />
      </div>
      <div className="flex gap-2 items-end">
        <div className="w-32 space-y-2">
          <Label className="text-xs">Codec</Label>
          <Select value={codec} onValueChange={(v) => v && setCodec(v)}>
            <SelectTrigger className="text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="base64">Base64</SelectItem>
              <SelectItem value="url">URL</SelectItem>
              <SelectItem value="hex">Hex</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button onClick={() => run("encode")} disabled={!input.trim()}>Encode</Button>
        <Button variant="outline" onClick={() => run("decode")} disabled={!input.trim()}>
          Decode
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <OutputBox value={output} id="enc-out" copied={copied} copy={copy} />
    </div>
  );
}

// ─── Main ────────────────────────────────────────────────────────────────────

export default function CryptoTools() {
  const [section, setSection] = useState<Section>("jwt");

  const tabClass = (s: Section) =>
    `px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
      section === s
        ? "border-b-2 border-primary text-foreground"
        : "text-muted-foreground hover:text-foreground"
    }`;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex-1 overflow-auto p-6 space-y-4 max-w-4xl mx-auto w-full">
        <div className="flex items-center gap-3">
          <KeyRound className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-xl font-semibold">Crypto Tools</h1>
        </div>

        <Card>
          <CardHeader className="pb-0">
            <div className="flex border-b -mx-6 px-6">
              {SECTIONS.map((s) => (
                <button
                  key={s.key}
                  className={tabClass(s.key)}
                  onClick={() => setSection(s.key)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </CardHeader>
          <CardContent className="pt-4">
            {section === "jwt" && <JwtSection />}
            {section === "ids" && <IdSection />}
            {section === "hash" && <HashSection />}
            {section === "password" && <PasswordSection />}
            {section === "encode" && <EncodeSection />}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
