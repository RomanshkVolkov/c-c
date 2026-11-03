#!/usr/bin/env python3
"""Lo que comparten los hooks de cac (`cac-session`, `cac-handoff`,
`cac-prompt` y `cac-edit`).

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
import time
import unicodedata
import urllib.error
import urllib.request

TIMEOUT = 5
# Cada cuánto se vuelven a pedir los incidentes (cac-prompt, cac-edit).
VOCAB_TTL = 15 * 60


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


# ── Los incidentes, cacheados, y lo ya enseñado en cada sesión ──
#
# `cac-prompt` y `cac-edit` comparten la caché y el «ya enseñado»: un
# incidente que salió al nombrar su servidor no vuelve a salir al editar el
# fichero de su prueba, y al revés.

def cache_dir():
    base = os.environ.get("XDG_CACHE_HOME") or os.path.join(os.path.expanduser("~"), ".cache")
    d = os.path.join(base, "cac-hooks")
    os.makedirs(d, exist_ok=True)
    return d


def fold(s):
    """Minúsculas y sin acentos: «Kubernetes» y «kubernetes», «ñ» y «n»."""
    s = unicodedata.normalize("NFKD", s.lower())
    return "".join(c for c in s if not unicodedata.combining(c))


def incidents(cfg):
    """Los incidentes vigentes de las orgs del token, cacheados. Sin cuerpo."""
    path = os.path.join(cache_dir(), "incidents.json")
    try:
        with open(path, encoding="utf-8") as f:
            cached = json.load(f)
        if time.time() - cached.get("at", 0) < VOCAB_TTL:
            return cached.get("incidents") or []
    except (OSError, ValueError):
        pass
    data = api(cfg, "/api/v1/incidents/?limit=200")
    if data is None:
        return []
    found = data.get("incidents") or []
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"at": time.time(), "incidents": found}, f)
    except OSError:
        pass
    return found



def seen_path(session):
    safe = re.sub(r"[^A-Za-z0-9_-]", "", session or "")[:80] or "sin-sesion"
    return os.path.join(cache_dir(), f"seen-{safe}.json")


def load_seen(session):
    try:
        with open(seen_path(session), encoding="utf-8") as f:
            return set(json.load(f))
    except (OSError, ValueError):
        return set()


def save_seen(session, ids):
    try:
        with open(seen_path(session), "w", encoding="utf-8") as f:
            json.dump(sorted(ids), f)
    except OSError:
        pass
    # Lo de sesiones de hace más de un día ya no sirve a nadie.
    d = cache_dir()
    for name in os.listdir(d):
        p = os.path.join(d, name)
        if name.startswith("seen-") and time.time() - os.path.getmtime(p) > 86400:
            try:
                os.remove(p)
            except OSError:
                pass


# ── El fichero que se edita y las pruebas que guardan cada incidente ──
#
# Un guardián es texto libre, tal como se busca en el repo: `ansible::tests::x`
# (Rust), `app/src/pages/servers/ServerProvision.test.tsx «…»`,
# `ServerConfig.test.tsx («…»)` o `service.TestFoo` (Go). Se casa con el
# fichero sin pedir nada más a cac (command-and-control-296).

GUARD_SPLIT = re.compile(r"::|[./\s«»()\"',]+")
TEST_SUFFIX = re.compile(r"(\.test|\.spec|_test)$")
MIN_STEM = 3


def guard_candidates(rel):
    """Lo que de un fichero puede aparecer en un guardián: la ruta, el
    nombre, el nombre sin extensión ni sufijo de prueba (`ServerProvision`
    para `ServerProvision.tsx` y para `ServerProvision.test.tsx`), el prefijo
    de módulo de Rust (`ansible::`) y el de paquete de Go (`service.`)."""
    rel = rel.replace(os.sep, "/")
    base = rel.rsplit("/", 1)[-1]
    stem, ext = os.path.splitext(base)
    stem = TEST_SUFFIX.sub("", stem)
    out = {"rel": rel, "base": base, "stem": stem, "ext": ext}
    if ext == ".rs":
        out["rust"] = stem + "::"
    if ext == ".go":
        parent = rel.rsplit("/", 2)
        out["go"] = (parent[-2] if len(parent) >= 2 else "") + "."
        out["dir"] = rel.rsplit("/", 1)[0] if "/" in rel else "."
    return out


def guard_matches(c, guard, go_tests=None):
    """Si un guardián vive en el fichero `c` (de guard_candidates).

    Por la ruta o el nombre del fichero (dentro del texto); por el nombre sin
    sufijo como palabra entera del guardián; o por el prefijo del módulo de
    Rust. En Go, el prefijo del paquete casaría con todas las pruebas del
    paquete al editar cualquiera de sus ficheros: con `go_tests` (prueba →
    fichero) sólo casa la prueba que vive en el fichero de ese nombre."""
    if c["rel"] in guard or c["base"] in guard:
        return True
    if c.get("rust") and guard.startswith(c["rust"]):
        return True
    if c.get("go") and guard.startswith(c["go"]):
        test = GUARD_SPLIT.split(guard[len(c["go"]):])[0]
        if go_tests is None:
            return True
        where = go_tests.get(test)
        if where:
            stem = TEST_SUFFIX.sub("", os.path.splitext(where.rsplit("/", 1)[-1])[0])
            return stem == c["stem"]
        return False
    if c["ext"] in (".rs", ".go") or len(c["stem"]) < MIN_STEM:
        return False
    return c["stem"] in GUARD_SPLIT.split(guard)


def guards_for(rel, found, go_tests=None):
    """Los incidentes con alguna prueba que vive en `rel`, en el orden en que
    vienen, cada uno una vez y con el primer guardián que casa."""
    c = guard_candidates(rel)
    out = []
    for inc in found:
        for g in inc.get("guards") or []:
            if guard_matches(c, g, go_tests):
                out.append((inc, g))
                break
    return out


def go_test_index(root, pkg_dir):
    """Las pruebas de un paquete de Go y su fichero: `TestFoo → incident_test.go`.
    Con `git grep`, en milisegundos; vacío ante cualquier fallo."""
    out = {}
    for line in git(root, "grep", "-n", "^func Test", "--", f"{pkg_dir}/*_test.go").splitlines():
        path, _, rest = line.partition(":")
        m = re.search(r"func (Test\w+)", rest)
        if m:
            out[m.group(1)] = path
    return out
