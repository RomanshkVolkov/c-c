import { useState, useEffect, useCallback } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  ArrowLeft,
  KeyRound,
  Plus,
  RefreshCw,
  Shield,
  Variable,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { invoke } from "@tauri-apps/api/core";
import type { Server } from "@/types/server";
import type { SwarmService } from "@/types/swarm";

interface GitHubSecret {
  name: string;
  created_at: string;
  updated_at: string;
}

interface GitHubVariable {
  name: string;
  value: string;
  created_at: string;
  updated_at: string;
}

interface LocationState {
  server: Server;
  service: SwarmService;
  services: SwarmService[];
}

function inferOwnerRepo(image: string): { owner: string; repo: string } | null {
  // ghcr.io/owner/repo:tag
  const ghcr = image.match(/^ghcr\.io\/([^/]+)\/([^/:]+)/);
  if (ghcr) return { owner: ghcr[1], repo: ghcr[2] };

  // registry.example.com/owner/repo:tag  (3+ path segments, skip registry)
  const parts = image.split("/");
  if (parts.length >= 3 && parts[0].includes(".")) {
    return { owner: parts[1], repo: parts[2].split(":")[0] };
  }

  // owner/repo:tag
  if (parts.length === 2) {
    return { owner: parts[0], repo: parts[1].split(":")[0] };
  }

  return null;
}

export default function StackSecrets() {
  const navigate = useNavigate();
  const { state } = useLocation();
  const locationState = state as LocationState | null;
  const PERSONAL_ACCESS_TOKEN_KEY = "PATK_global_usage"; // state.serverId;

  const server = locationState?.server ?? null;
  const service = locationState?.service ?? null;

  // Infer owner/repo from the clicked service image, fallback to first inferrable image in stack
  const inferredRepo = (() => {
    if (service) {
      const inferred = inferOwnerRepo(service.image);
      if (inferred) return inferred;
    }
    if (locationState?.services) {
      for (const svc of locationState.services) {
        if (svc.stack === service?.stack) {
          const inferred = inferOwnerRepo(svc.image);
          if (inferred) return inferred;
        }
      }
    }
    return null;
  })();

  const [tab, setTab] = useState<"secrets" | "variables">("secrets");

  // Token state
  const [tokenConfigured, setTokenConfigured] = useState<boolean | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [tokenLoading, setTokenLoading] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);

  // Repo fields
  const [owner, setOwner] = useState(inferredRepo?.owner ?? "");
  const [repo, setRepo] = useState(inferredRepo?.repo ?? "");

  // Secrets state
  const [secrets, setSecrets] = useState<GitHubSecret[]>([]);
  const [secretsLoading, setSecretsLoading] = useState(false);
  const [secretsError, setSecretsError] = useState<string | null>(null);

  // Variables state
  const [variables, setVariables] = useState<GitHubVariable[]>([]);
  const [variablesLoading, setVariablesLoading] = useState(false);
  const [variablesError, setVariablesError] = useState<string | null>(null);

  // Secret dialog
  const [secretDialog, setSecretDialog] = useState<{
    open: boolean;
    isNew: boolean;
    name: string;
    value: string;
    saving: boolean;
    error: string | null;
  }>({
    open: false,
    isNew: true,
    name: "",
    value: "",
    saving: false,
    error: null,
  });

  // Variable dialog
  const [varDialog, setVarDialog] = useState<{
    open: boolean;
    name: string;
    value: string;
    exists: boolean;
    saving: boolean;
    error: string | null;
  }>({
    open: false,
    name: "",
    value: "",
    exists: false,
    saving: false,
    error: null,
  });

  // Delete confirmation dialog
  const [deleteConfirm, setDeleteConfirm] = useState<{
    open: boolean;
    type: "secret" | "variable";
    name: string;
    input: string;
    deleting: boolean;
    error: string | null;
  }>({
    open: false,
    type: "secret",
    name: "",
    input: "",
    deleting: false,
    error: null,
  });

  useEffect(() => {
    if (!server) navigate("/dashboard", { replace: true });
  }, [server, navigate]);

  const fetchTokenStatus = useCallback(async () => {
    if (!server) return;
    try {
      const configured = await invoke<boolean>("github_token_configured", {
        serverId: PERSONAL_ACCESS_TOKEN_KEY,
      });
      setTokenConfigured(configured);
    } catch {
      setTokenConfigured(false);
    }
  }, [server]);

  useEffect(() => {
    fetchTokenStatus();
  }, [fetchTokenStatus]);

  const fetchSecrets = useCallback(async () => {
    if (!server || !owner || !repo) return;
    setSecretsLoading(true);
    setSecretsError(null);
    try {
      const data = await invoke<GitHubSecret[]>("list_github_secrets", {
        serverId: PERSONAL_ACCESS_TOKEN_KEY,
        owner,
        repo,
      });
      setSecrets(data);
    } catch (e) {
      setSecretsError(e instanceof Error ? e.message : String(e));
    } finally {
      setSecretsLoading(false);
    }
  }, [server, owner, repo]);

  const fetchVariables = useCallback(async () => {
    if (!server || !owner || !repo) return;
    setVariablesLoading(true);
    setVariablesError(null);
    try {
      const data = await invoke<GitHubVariable[]>("list_github_variables", {
        serverId: PERSONAL_ACCESS_TOKEN_KEY,
        owner,
        repo,
      });
      setVariables(data);
    } catch (e) {
      setVariablesError(e instanceof Error ? e.message : String(e));
    } finally {
      setVariablesLoading(false);
    }
  }, [server, owner, repo]);

  useEffect(() => {
    if (tokenConfigured && owner && repo) {
      fetchSecrets();
      fetchVariables();
    }
  }, [tokenConfigured, owner, repo, fetchSecrets, fetchVariables]);

  const handleSetToken = async () => {
    if (!server || !tokenInput.trim()) return;
    setTokenLoading(true);
    setTokenError(null);
    try {
      await invoke("set_github_token", {
        serverId: PERSONAL_ACCESS_TOKEN_KEY,
        token: tokenInput.trim(),
      });
      setTokenInput("");
      setTokenConfigured(true);
    } catch (e) {
      setTokenError(e instanceof Error ? e.message : String(e));
    } finally {
      setTokenLoading(false);
    }
  };

  const handleDeleteToken = async () => {
    if (!server) return;
    setTokenLoading(true);
    setTokenError(null);
    try {
      await invoke("delete_github_token", {
        serverId: PERSONAL_ACCESS_TOKEN_KEY,
      });
      setTokenConfigured(false);
      setSecrets([]);
      setVariables([]);
    } catch (e) {
      setTokenError(e instanceof Error ? e.message : String(e));
    } finally {
      setTokenLoading(false);
    }
  };

  const handleSaveSecret = async () => {
    if (!server || !secretDialog.name.trim() || !secretDialog.value.trim())
      return;
    setSecretDialog((d) => ({ ...d, saving: true, error: null }));
    try {
      await invoke("set_github_secret", {
        serverId: PERSONAL_ACCESS_TOKEN_KEY,
        owner,
        repo,
        name: secretDialog.name.trim(),
        value: secretDialog.value,
      });
      setSecretDialog({
        open: false,
        isNew: true,
        name: "",
        value: "",
        saving: false,
        error: null,
      });
      fetchSecrets();
    } catch (e) {
      setSecretDialog((d) => ({
        ...d,
        saving: false,
        error: e instanceof Error ? e.message : String(e),
      }));
    }
  };

  const handleSaveVariable = async () => {
    if (!server || !varDialog.name.trim() || !varDialog.value.trim()) return;
    setVarDialog((d) => ({ ...d, saving: true, error: null }));
    try {
      await invoke("set_github_variable", {
        serverId: PERSONAL_ACCESS_TOKEN_KEY,
        owner,
        repo,
        name: varDialog.name.trim(),
        value: varDialog.value,
        exists: varDialog.exists,
      });
      setVarDialog({
        open: false,
        name: "",
        value: "",
        exists: false,
        saving: false,
        error: null,
      });
      fetchVariables();
    } catch (e) {
      setVarDialog((d) => ({
        ...d,
        saving: false,
        error: e instanceof Error ? e.message : String(e),
      }));
    }
  };

  const openDeleteConfirm = (type: "secret" | "variable", name: string) => {
    setDeleteConfirm({
      open: true,
      type,
      name,
      input: "",
      deleting: false,
      error: null,
    });
  };

  const handleConfirmDelete = async () => {
    if (!server) return;
    const { type, name } = deleteConfirm;
    setDeleteConfirm((d) => ({ ...d, deleting: true, error: null }));
    try {
      if (type === "secret") {
        await invoke("delete_github_secret", {
          serverId: PERSONAL_ACCESS_TOKEN_KEY,
          owner,
          repo,
          name,
        });
        setSecrets((prev) => prev.filter((s) => s.name !== name));
      } else {
        await invoke("delete_github_variable", {
          serverId: PERSONAL_ACCESS_TOKEN_KEY,
          owner,
          repo,
          name,
        });
        setVariables((prev) => prev.filter((v) => v.name !== name));
      }
      setDeleteConfirm((d) => ({ ...d, open: false }));
    } catch (e) {
      setDeleteConfirm((d) => ({
        ...d,
        deleting: false,
        error: e instanceof Error ? e.message : String(e),
      }));
    }
  };

  if (!server) return null;

  const stackName = service?.stack ?? "unknown";

  const tabClass = (t: typeof tab) =>
    `px-4 py-2 text-sm font-medium transition-colors cursor-pointer ${
      tab === t
        ? "border-b-2 border-primary text-foreground"
        : "text-muted-foreground hover:text-foreground"
    }`;

  const canLoad = tokenConfigured && owner.trim() !== "" && repo.trim() !== "";

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b px-6 py-3 flex items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate(`/servers/${server.id}`, { state: server })}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex items-center gap-3 flex-1">
          <Shield className="h-5 w-5 text-muted-foreground" />
          <span className="font-semibold text-lg">GitHub Secrets</span>
          <Badge variant="secondary">{stackName}</Badge>
          <span className="text-sm text-muted-foreground">{server.name}</span>
        </div>
      </header>

      <main className="flex-1 p-6 space-y-4 max-w-4xl mx-auto w-full">
        {/* Token Configuration */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <KeyRound className="h-4 w-4" />
              GitHub Personal Access Token
              {tokenConfigured === true && (
                <Badge variant="default" className="ml-2">
                  Configured
                </Badge>
              )}
              {tokenConfigured === false && (
                <Badge variant="destructive" className="ml-2">
                  Not configured
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {tokenError && (
              <p className="text-sm text-destructive">{tokenError}</p>
            )}
            <div className="flex gap-2">
              <Input
                type="password"
                placeholder="ghp_..."
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                className="flex-1 font-mono text-sm"
                onKeyDown={(e) => e.key === "Enter" && handleSetToken()}
              />
              <Button
                onClick={handleSetToken}
                disabled={tokenLoading || !tokenInput.trim()}
              >
                {tokenConfigured ? "Update" : "Save"}
              </Button>
              {tokenConfigured && (
                <Button
                  variant="destructive"
                  onClick={handleDeleteToken}
                  disabled={tokenLoading}
                >
                  Remove
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Token requires <code className="font-mono">secrets</code> and{" "}
              <code className="font-mono">variables</code> scopes on the target
              repository.
            </p>
          </CardContent>
        </Card>

        {/* Repository */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Repository</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-3 items-end">
              <div className="flex-1 space-y-1">
                <Label className="text-xs">Owner</Label>
                <Input
                  placeholder="owner"
                  value={owner}
                  onChange={(e) => setOwner(e.target.value)}
                  className="font-mono text-sm"
                />
              </div>
              <span className="pb-2 text-muted-foreground">/</span>
              <div className="flex-1 space-y-1">
                <Label className="text-xs">Repository</Label>
                <Input
                  placeholder="repo"
                  value={repo}
                  onChange={(e) => setRepo(e.target.value)}
                  className="font-mono text-sm"
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  fetchSecrets();
                  fetchVariables();
                }}
                disabled={!canLoad || secretsLoading || variablesLoading}
              >
                <RefreshCw
                  className={`h-4 w-4 ${secretsLoading || variablesLoading ? "animate-spin" : ""}`}
                />
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Secrets / Variables tabs */}
        {canLoad && (
          <Card>
            <CardHeader className="pb-0">
              <div className="flex border-b -mx-6 px-6">
                <button
                  className={tabClass("secrets")}
                  onClick={() => setTab("secrets")}
                >
                  <Shield className="h-3 w-3 inline mr-1" />
                  Secrets {!secretsLoading && `(${secrets.length})`}
                </button>
                <button
                  className={tabClass("variables")}
                  onClick={() => setTab("variables")}
                >
                  <Variable className="h-3 w-3 inline mr-1" />
                  Variables {!variablesLoading && `(${variables.length})`}
                </button>
              </div>
            </CardHeader>
            <CardContent className="pt-4">
              {tab === "secrets" && (
                <div className="space-y-3">
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      onClick={() =>
                        setSecretDialog({
                          open: true,
                          isNew: true,
                          name: "",
                          value: "",
                          saving: false,
                          error: null,
                        })
                      }
                    >
                      <Plus className="h-3 w-3 mr-1" />
                      New Secret
                    </Button>
                  </div>
                  {secretsError && (
                    <p className="text-sm text-destructive">{secretsError}</p>
                  )}
                  {secretsLoading ? (
                    <p className="text-sm text-muted-foreground py-8 text-center">
                      Loading...
                    </p>
                  ) : secrets.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-8 text-center">
                      No secrets found.
                    </p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Name</TableHead>
                          <TableHead>Created</TableHead>
                          <TableHead>Updated</TableHead>
                          <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {secrets.map((secret) => (
                          <TableRow key={secret.name}>
                            <TableCell className="font-mono text-sm font-medium">
                              {secret.name}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {secret.created_at
                                ? new Date(secret.created_at).toLocaleString()
                                : "—"}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {secret.updated_at
                                ? new Date(secret.updated_at).toLocaleString()
                                : "—"}
                            </TableCell>
                            <TableCell className="text-right space-x-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  setSecretDialog({
                                    open: true,
                                    isNew: false,
                                    name: secret.name,
                                    value: "",
                                    saving: false,
                                    error: null,
                                  })
                                }
                              >
                                Update
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-destructive hover:text-destructive"
                                onClick={() =>
                                  openDeleteConfirm("secret", secret.name)
                                }
                              >
                                Delete
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </div>
              )}

              {tab === "variables" && (
                <div className="space-y-3">
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      onClick={() =>
                        setVarDialog({
                          open: true,
                          name: "",
                          value: "",
                          exists: false,
                          saving: false,
                          error: null,
                        })
                      }
                    >
                      <Plus className="h-3 w-3 mr-1" />
                      New Variable
                    </Button>
                  </div>
                  {variablesError && (
                    <p className="text-sm text-destructive">{variablesError}</p>
                  )}
                  {variablesLoading ? (
                    <p className="text-sm text-muted-foreground py-8 text-center">
                      Loading...
                    </p>
                  ) : variables.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-8 text-center">
                      No variables found.
                    </p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Name</TableHead>
                          <TableHead>Value</TableHead>
                          <TableHead>Created</TableHead>
                          <TableHead>Updated</TableHead>
                          <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {variables.map((v) => (
                          <TableRow key={v.name}>
                            <TableCell className="font-mono text-sm font-medium">
                              {v.name}
                            </TableCell>
                            <TableCell className="font-mono text-xs text-muted-foreground max-w-48 truncate">
                              {v.value}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {v.created_at
                                ? new Date(v.created_at).toLocaleString()
                                : "—"}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {v.updated_at
                                ? new Date(v.updated_at).toLocaleString()
                                : "—"}
                            </TableCell>
                            <TableCell className="text-right space-x-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  setVarDialog({
                                    open: true,
                                    name: v.name,
                                    value: v.value,
                                    exists: true,
                                    saving: false,
                                    error: null,
                                  })
                                }
                              >
                                Edit
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-destructive hover:text-destructive"
                                onClick={() =>
                                  openDeleteConfirm("variable", v.name)
                                }
                              >
                                Delete
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </main>

      {/* Secret Dialog */}
      <Dialog
        open={secretDialog.open}
        onOpenChange={(open) =>
          !secretDialog.saving &&
          setSecretDialog((d) => ({ ...d, open, error: null }))
        }
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {secretDialog.isNew
                ? "New Secret"
                : `Update Secret: ${secretDialog.name}`}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {secretDialog.isNew && (
              <div className="space-y-1">
                <Label>Name</Label>
                <Input
                  placeholder="SECRET_NAME"
                  value={secretDialog.name}
                  onChange={(e) =>
                    setSecretDialog((d) => ({
                      ...d,
                      name: e.target.value.toUpperCase().replace(/\s/g, "_"),
                    }))
                  }
                  className="font-mono"
                />
              </div>
            )}
            <div className="space-y-1">
              <Label>Value</Label>
              <Input
                type="password"
                placeholder="Secret value"
                value={secretDialog.value}
                onChange={(e) =>
                  setSecretDialog((d) => ({ ...d, value: e.target.value }))
                }
              />
            </div>
            {secretDialog.error && (
              <p className="text-sm text-destructive">{secretDialog.error}</p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() =>
                setSecretDialog((d) => ({ ...d, open: false, error: null }))
              }
              disabled={secretDialog.saving}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSaveSecret}
              disabled={
                secretDialog.saving ||
                !secretDialog.name.trim() ||
                !secretDialog.value.trim()
              }
            >
              {secretDialog.saving ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Variable Dialog */}
      <Dialog
        open={varDialog.open}
        onOpenChange={(open) =>
          !varDialog.saving &&
          setVarDialog((d) => ({ ...d, open, error: null }))
        }
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {varDialog.exists
                ? `Edit Variable: ${varDialog.name}`
                : "New Variable"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {!varDialog.exists && (
              <div className="space-y-1">
                <Label>Name</Label>
                <Input
                  placeholder="VARIABLE_NAME"
                  value={varDialog.name}
                  onChange={(e) =>
                    setVarDialog((d) => ({
                      ...d,
                      name: e.target.value.toUpperCase().replace(/\s/g, "_"),
                    }))
                  }
                  className="font-mono"
                />
              </div>
            )}
            <div className="space-y-1">
              <Label>Value</Label>
              <Input
                placeholder="Variable value"
                value={varDialog.value}
                onChange={(e) =>
                  setVarDialog((d) => ({ ...d, value: e.target.value }))
                }
              />
            </div>
            {varDialog.error && (
              <p className="text-sm text-destructive">{varDialog.error}</p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() =>
                setVarDialog((d) => ({ ...d, open: false, error: null }))
              }
              disabled={varDialog.saving}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSaveVariable}
              disabled={
                varDialog.saving ||
                !varDialog.name.trim() ||
                !varDialog.value.trim()
              }
            >
              {varDialog.saving ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation dialog */}
      <Dialog
        open={deleteConfirm.open}
        onOpenChange={(open) =>
          !deleteConfirm.deleting &&
          setDeleteConfirm((d) => ({ ...d, open, input: "", error: null }))
        }
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Delete {deleteConfirm.type === "secret" ? "Secret" : "Variable"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              This action cannot be undone. Type{" "}
              <code className="font-mono text-foreground font-medium">
                delete {deleteConfirm.name}
              </code>{" "}
              to confirm.
            </p>
            <Input
              placeholder={`delete ${deleteConfirm.name}`}
              value={deleteConfirm.input}
              onChange={(e) =>
                setDeleteConfirm((d) => ({ ...d, input: e.target.value }))
              }
              className="font-mono"
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  deleteConfirm.input === `delete ${deleteConfirm.name}`
                )
                  handleConfirmDelete();
              }}
            />
            {deleteConfirm.error && (
              <p className="text-sm text-destructive">{deleteConfirm.error}</p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() =>
                setDeleteConfirm((d) => ({
                  ...d,
                  open: false,
                  input: "",
                  error: null,
                }))
              }
              disabled={deleteConfirm.deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirmDelete}
              disabled={
                deleteConfirm.deleting ||
                deleteConfirm.input !== `delete ${deleteConfirm.name}`
              }
            >
              {deleteConfirm.deleting ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
