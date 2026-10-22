#!/usr/bin/env python3
"""Lo que comparten los dos hooks de cac (`cac-session` y `cac-handoff`).

Un hook corre con el usuario, en cada sesión, sin que el agente tenga que
acordarse: es la diferencia entre una nota y un guardián. Viven en el repo
(decidido con jose el 22-oct-2026) y tienen que funcionar aunque Claude Code
se abra desde una subcarpeta: la raíz la da git, no el cwd. Por eso el mismo
`settings.json` está en la raíz, en `app/` y en `backend/`: Claude Code sólo
lee el de la carpeta donde se abre.

Nunca imprimen el token ni rompen la sesión: ante cualquier fallo (sin remote,
sin token, cac caído, repo no atado) callan y devuelven 0.
"""
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

TIMEOUT = 5


def git(cwd, *args):
    try:
        out = subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True, timeout=TIMEOUT)
    except (OSError, subprocess.SubprocessError):
        return ""
    return out.stdout.strip() if out.returncode == 0 else ""


def github_repo(url):
    """`owner/name` de un remote de GitHub, en cualquiera de sus formas."""
    m = re.search(r"github\.com[:/]([^/\s]+)/([^/\s]+?)(?:\.git)?/?$", url.strip())
    return f"{m.group(1)}/{m.group(2)}" if m else ""


def cac_config():
    """`CAC_URL` y `CAC_TOKEN` del MCP de cac, de la cuenta en uso: el
    `.claude.json` de `CLAUDE_CONFIG_DIR` si está, y si no el de casa."""
    dirs = [os.environ.get("CLAUDE_CONFIG_DIR", ""), os.path.expanduser("~")]
    for d in dirs:
        if not d:
            continue
        path = os.path.join(d, ".claude.json")
        try:
            with open(path, encoding="utf-8") as f:
                env = (json.load(f).get("mcpServers") or {}).get("cac", {}).get("env") or {}
        except (OSError, ValueError):
            continue
        if env.get("CAC_URL") and env.get("CAC_TOKEN"):
            return env["CAC_URL"].rstrip("/"), env["CAC_TOKEN"]
    return None


def api(cfg, path):
    """GET a cac; `None` si no contesta o no es un 200."""
    url, token = cfg
    req = urllib.request.Request(url + path, headers={"Authorization": "Bearer " + token})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return json.load(r).get("data")
    except (urllib.error.URLError, ValueError, OSError):
        return None


def repo_of(cwd):
    """(raíz del repo, `owner/name`), o vacíos si no es un repo de GitHub."""
    root = git(cwd, "rev-parse", "--show-toplevel")
    if not root:
        return "", ""
    return root, github_repo(git(root, "remote", "get-url", "origin"))


def read_input():
    try:
        return json.load(sys.stdin)
    except ValueError:
        return {}
