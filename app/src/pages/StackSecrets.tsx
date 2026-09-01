import { fechaYHora } from "@/lib/fechas";
import { useT } from "@/lib/i18n";
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
  const { t } = useT();
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

  // 1Password state
  const [opReference, setOpReference] = useState<string>("");
  const [opLoading, setOpLoading] = useState(false);
  const [opStored, setOpStored] = useState<boolean>(false);

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
    try {
      const ref = await invoke<string | null>("get_op_reference", {
        serverId: PERSONAL_ACCESS_TOKEN_KEY,
      });
      if (ref) {
        setOpReference(ref);
        setOpStored(true);
      }
    } catch {
      // no-op: keychain lookup failure is non-fatal
    }
  }, [server]);

  useEffect(() => {
    fetchTokenStatus();
  }, [fetchTokenStatus]);

  const handleLoadFromOnePassword = async () => {
    if (!opReference.trim()) return;
    setOpLoading(true);
    setTokenError(null);
    try {
      await invoke("load_github_token_from_1password", {
        serverId: PERSONAL_ACCESS_TOKEN_KEY,
        opReference: opReference.trim(),
      });
      setTokenConfigured(true);
      setOpStored(true);
    } catch (e) {
      setTokenError(e instanceof Error ? e.message : String(e));
    } finally {
      setOpLoading(false);
    }
  };

  const handleRefreshFromOnePassword = async () => {
    setOpLoading(true);
    setTokenError(null);
    try {
      await invoke("refresh_github_token_from_1password", {
        serverId: PERSONAL_ACCESS_TOKEN_KEY,
      });
      setTokenConfigured(true);
    } catch (e) {
      setTokenError(e instanceof Error ? e.message : String(e));
    } finally {
      setOpLoading(false);
    }
  };

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
      setOpStored(false);
      setOpReference("");
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
          <span className="font-semibold text-lg">{t("common:servers.githubSecrets")}</span>
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
              {t("common:servers.githubPat")}
              {tokenConfigured === true && (
                <Badge variant="default" className="ml-2">
                  {t("common:servers.configured")}
                </Badge>
              )}
              {tokenConfigured === false && (
                <Badge variant="destructive" className="ml-2">
                  {t("common:servers.notConfigured")}
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {tokenError && (
              <p className="text-sm text-destructive">{tokenError}</p>
            )}

            <div className="space-y-2">
              <Label className="text-xs">1Password reference</Label>
              <div className="flex gap-2">
                <Input
                  type="text"
                  placeholder="op://Vault/Item/credential"
                  value={opReference}
                  onChange={(e) => setOpReference(e.target.value)}
                  className="flex-1 font-mono text-sm"
                  onKeyDown={(e) =>
                    e.key === "Enter" && handleLoadFromOnePassword()
                  }
                />
                <Button
                  onClick={handleLoadFromOnePassword}
                  disabled={opLoading || !opReference.trim()}
                >
                  {opLoading ? t("common:servers.loading") : opStored ? t("common:servers.update") : t("common:servers.load")}
                </Button>
                {opStored && (
                  <Button
                    variant="outline"
                    onClick={handleRefreshFromOnePassword}
                    disabled={opLoading}
                  >
                    <RefreshCw
                      className={`h-3 w-3 mr-1 ${opLoading ? "animate-spin" : ""}`}
                    />
                    {t("common:servers.refresh")}
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Reads the PAT from 1Password via <code className="font-mono">op read</code>.
                Requires the 1Password CLI installed and signed in.
              </p>
            </div>

            <div className="space-y-2">
              <Label className="text-xs">{t("common:servers.orPasteManually")}</Label>
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
                  {tokenConfigured ? t("common:servers.update") : t("common:servers.save")}
                </Button>
                {tokenConfigured && (
                  <Button
                    variant="destructive"
                    onClick={handleDeleteToken}
                    disabled={tokenLoading}
                  >
                    {t("common:servers.remove")}
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Token requires <code className="font-mono">secrets</code> and{" "}
                <code className="font-mono">variables</code> scopes on the
                target repository.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Repository */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">{t("common:servers.repository")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-3 items-end">
              <div className="flex-1 space-y-1">
                <Label className="text-xs">{t("common:servers.owner")}</Label>
                <Input
                  placeholder="owner"
                  value={owner}
                  onChange={(e) => setOwner(e.target.value)}
                  className="font-mono text-sm"
                />
              </div>
              <span className="pb-2 text-muted-foreground">/</span>
              <div className="flex-1 space-y-1">
                <Label className="text-xs">{t("common:servers.repository")}</Label>
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
                      {t("common:servers.newSecret")}
                    </Button>
                  </div>
                  {secretsError && (
                    <p className="text-sm text-destructive">{secretsError}</p>
                  )}
                  {secretsLoading ? (
                    <p className="text-sm text-muted-foreground py-8 text-center">
                      {t("common:servers.loading")}
                    </p>
                  ) : secrets.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-8 text-center">
                      {t("common:servers.noSecrets")}
                    </p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t("common:servers.thName")}</TableHead>
                          <TableHead>{t("common:servers.thCreated")}</TableHead>
                          <TableHead>{t("common:servers.thUpdated")}</TableHead>
                          <TableHead className="text-right">{t("common:servers.thActions")}</TableHead>
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
                                ? fechaYHora(secret.created_at)
                                : "—"}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {secret.updated_at
                                ? fechaYHora(secret.updated_at)
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
                                {t("common:servers.update")}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-destructive hover:text-destructive"
                                onClick={() =>
                                  openDeleteConfirm("secret", secret.name)
                                }
                              >
                                {t("common:servers.delete")}
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
                      {t("common:servers.newVariable")}
                    </Button>
                  </div>
                  {variablesError && (
                    <p className="text-sm text-destructive">{variablesError}</p>
                  )}
                  {variablesLoading ? (
                    <p className="text-sm text-muted-foreground py-8 text-center">
                      {t("common:servers.loading")}
                    </p>
                  ) : variables.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-8 text-center">
                      {t("common:servers.noVariables")}
                    </p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t("common:servers.thName")}</TableHead>
                          <TableHead>{t("common:servers.thValue")}</TableHead>
                          <TableHead>{t("common:servers.thCreated")}</TableHead>
                          <TableHead>{t("common:servers.thUpdated")}</TableHead>
                          <TableHead className="text-right">{t("common:servers.thActions")}</TableHead>
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
                                ? fechaYHora(v.created_at)
                                : "—"}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {v.updated_at
                                ? fechaYHora(v.updated_at)
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
                                {t("common:servers.edit")}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-destructive hover:text-destructive"
                                onClick={() =>
                                  openDeleteConfirm("variable", v.name)
                                }
                              >
                                {t("common:servers.delete")}
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
                ? t("common:servers.newSecret")
                : `Update Secret: ${secretDialog.name}`}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {secretDialog.isNew && (
              <div className="space-y-1">
                <Label>{t("common:servers.thName")}</Label>
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
              <Label>{t("common:servers.thValue")}</Label>
              <Input
                type="password"
                placeholder={t("common:servers.secretValue")}
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
              {t("common:servers.cancel")}
            </Button>
            <Button
              onClick={handleSaveSecret}
              disabled={
                secretDialog.saving ||
                !secretDialog.name.trim() ||
                !secretDialog.value.trim()
              }
            >
              {secretDialog.saving ? t("common:servers.saving") : t("common:servers.save")}
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
                : t("common:servers.newVariable")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {!varDialog.exists && (
              <div className="space-y-1">
                <Label>{t("common:servers.thName")}</Label>
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
              <Label>{t("common:servers.thValue")}</Label>
              <Input
                placeholder={t("common:servers.variableValue")}
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
              {t("common:servers.cancel")}
            </Button>
            <Button
              onClick={handleSaveVariable}
              disabled={
                varDialog.saving ||
                !varDialog.name.trim() ||
                !varDialog.value.trim()
              }
            >
              {varDialog.saving ? t("common:servers.saving") : t("common:servers.save")}
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
              {t("common:servers.deleteThing", {
                what:
                  deleteConfirm.type === "secret" ? t("common:servers.secret") : t("common:servers.variable"),
              })}
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
              {t("common:servers.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirmDelete}
              disabled={
                deleteConfirm.deleting ||
                deleteConfirm.input !== `delete ${deleteConfirm.name}`
              }
            >
              {deleteConfirm.deleting ? t("common:servers.deleting") : t("common:servers.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
