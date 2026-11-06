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

Desde el 5-nov-2026 también se instalan **globales** con `install_hooks` del
MCP (command-and-control-317): copiados en `$CLAUDE_CONFIG_DIR/hooks/cac/` y
enlazados en el `settings.json` de la persona, para que corran en todos sus
repos. En un repo que trae los suyos (éste), la copia global calla
(`shadowed`): si no, cada hook correría dos veces.

La versión de abajo se sube a mano al cambiar cualquier hook: es lo que hace
que el MCP ofrezca actualizar la copia global.
"""
# cac-hooks v1
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


def shadowed(inp, script=None):
    """Si el repo donde se trabaja trae su propia copia de este hook (como
    cac) y ésta no es esa copia: entonces calla, y habla la del repo."""
    script = os.path.realpath(script or sys.argv[0])
    root = git(inp.get("cwd") or os.getcwd(), "rev-parse", "--show-toplevel")
    if not root:
        return False
    own = os.path.join(root, ".claude", "hooks", os.path.basename(script))
    return os.path.exists(own) and os.path.realpath(own) != script


# ── Cuándo empezó la sesión ──
#
# `cac-session` lo apunta la primera vez que corre en una sesión; `cac-handoff`
# lo usa para saber qué tareas se tocaron en ella.

def _start_path(session):
    safe = re.sub(r"[^A-Za-z0-9_-]", "", session or "")[:80]
    return os.path.join(cache_dir(), f"start-{safe}.json") if safe else ""


def mark_session_start(session, now=None):
    path = _start_path(session)
    if not path or os.path.exists(path):
        return
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"at": now if now is not None else time.time()}, f)
    except OSError:
        pass


def session_start(session):
    path = _start_path(session)
    try:
        with open(path, encoding="utf-8") as f:
            return float(json.load(f)["at"])
    except (OSError, ValueError, KeyError, TypeError):
        return None


def parse_instant(s):
    """Un instante RFC 3339 de cac (`2026-11-05T21:33:00.123Z`) en segundos."""
    from datetime import datetime
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


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


# Las tareas en curso del espacio del repo cambian más que los incidentes.
TASKS_TTL = 5 * 60


def in_progress(cfg, repo):
    """Las tareas en curso del espacio al que está atado `repo`, cacheadas por
    repo: `ref`, título, handoff y las claves de fuera que nombran (`keys`,
    p. ej. `PROTEUS-224`). Vacío si el repo no está atado o cac no contesta."""
    if not repo:
        return []
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", repo)
    path = os.path.join(cache_dir(), f"tasks-{safe}.json")
    try:
        with open(path, encoding="utf-8") as f:
            cached = json.load(f)
        if time.time() - cached.get("at", 0) < TASKS_TTL:
            return cached.get("tasks") or []
    except (OSError, ValueError):
        pass
    data = api(cfg, "/api/v1/context?repo=" + repo.replace("/", "%2F") + "&only=inProgress")
    if data is None:
        return []
    found = data.get("inProgress") or []
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"at": time.time(), "tasks": found}, f)
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


# ── Lo que un agente escribe en cac, en una línea para quien mira ──
#
# jose preguntaba «¿actualizaste cac?» con la escritura hecha un minuto
# antes: la llamada sale plegada en la terminal y no se ve qué dejó. En las
# tres sesiones de crossfire (30-oct → 5-nov), 12 de 16 recordatorios fueron
# así (command-and-control-316). `cac-wrote` lo enseña con `systemMessage`,
# que es para la persona, no para el modelo.

MCP_PREFIX = "mcp__cac__"
SHOWN_CHARS = 60


def _short(text):
    text = " ".join(str(text or "").split())
    return text if len(text) <= SHOWN_CHARS else text[: SHOWN_CHARS - 1] + "…"


def _response_json(response):
    """El JSON que devolvió la herramienta, venga como venga: un dict, un
    texto con JSON, o la lista de bloques de un resultado de MCP."""
    if isinstance(response, dict):
        if "content" in response:
            return _response_json(response["content"])
        return response
    if isinstance(response, list):
        for block in response:
            if isinstance(block, dict) and block.get("type") == "text":
                got = _response_json(block.get("text"))
                if got:
                    return got
        return {}
    if isinstance(response, str):
        try:
            got = json.loads(response)
        except ValueError:
            return {}
        return got if isinstance(got, dict) else {}
    return {}


def _task_changes(a):
    parts = []
    if a.get("claim"):
        parts.append("tomada")
    if a.get("status"):
        parts.append("estado " + str(a["status"]))
    if "handoff" in a:
        parts.append("dónde quedó" if a["handoff"] else "dónde quedó borrado")
    for key, label in (("description", "descripción"), ("title", "título"), ("blockedBy", "depende de"),
                       ("assignees", "responsables"), ("priority", "prioridad"), ("dueAt", "fecha"),
                       ("tags", "etiquetas"), ("visibility", "visibilidad " + str(a.get("visibility")))):
        if key in a:
            parts.append(label)
    return ", ".join(parts) or "cambios"


def describe_write(tool, args, response=None):
    """La línea para una escritura en cac, o None si la herramienta sólo lee
    (o era un ensayo). Sin llamar a cac: todo está en la llamada."""
    if not tool.startswith(MCP_PREFIX):
        return None
    name = tool[len(MCP_PREFIX):]
    a = args if isinstance(args, dict) else {}
    if a.get("dryRun"):
        return None
    r = _response_json(response)
    task = a.get("id") or ""
    what = {
        "update_task": lambda: f"{task} · {_task_changes(a)}",
        "add_task_comment": lambda: f"{task} · comentario: {_short(a.get('body'))}",
        "create_task": lambda: f"{r.get('ref') or 'tarea nueva'} · creada: {_short(a.get('title'))}"
        + (f" (+{len(a['subtasks'])} subtareas)" if a.get("subtasks") else ""),
        "link_pull_request": lambda: f"{task} · PR enlazada {a.get('url', '')}",
        "add_task_attachment": lambda: f"{task} · adjunto {a.get('fileName') or os.path.basename(str(a.get('path') or a.get('url') or ''))}",
        "record_decision": lambda: f"decisión: {_short(a.get('title'))}",
        "link_decision": lambda: f"decisión {a.get('id', '')} enlazada",
        "record_incident": lambda: f"incidente: {_short(a.get('title'))}",
        "update_incident": lambda: f"incidente {a.get('id', '')} · " + (f"estado {a['status']}" if a.get("status") else "actualizado"),
        "remember": lambda: f"nota: {_short(a.get('text'))}",
        "create_doc_page": lambda: f"página nueva: {_short(a.get('title'))}",
        "write_doc_page": lambda: f"página reescrita: {_short(a.get('title') or a.get('pageId'))}",
        "write_doc_page_section": lambda: f"sección «{_short(a.get('renameTo') or a.get('section'))}» de una página",
        "append_doc_page": lambda: f"página ampliada: {_short(a.get('text'))}",
        "write_doc_section": lambda: f"sección «{_short(a.get('renameTo') or a.get('section'))}» de {a.get('tab', 'un doc')}",
        "write_doc_tab": lambda: f"pestaña {a.get('tab', '')} reescrita",
        "append_doc_tab": lambda: f"{a.get('tab', 'doc')} ampliado: {_short(a.get('text'))}",
        "move_doc_page": lambda: "página movida",
        "delete_doc_page": lambda: "página borrada",
        "request_doc_review": lambda: "revisión de doc pedida",
        "create_note": lambda: f"nota nueva: {_short(a.get('title'))}",
        "update_note": lambda: f"nota {_short(a.get('title') or a.get('id'))} actualizada",
        "add_note_attachment": lambda: "adjunto en una nota",
        "send_message": lambda: f"mensaje a {a.get('channel') or a.get('person') or '?'}: {_short(a.get('text'))}",
        "create_post": lambda: f"publicación (borrador): {_short(a.get('title'))}",
        "comment_post": lambda: "comentario en el muro",
        "update_report": lambda: f"reporte {task} · " + (f"estado {a['status']}" if a.get("status") else "actualizado"),
        "add_report_comment": lambda: f"reporte {task} · comentario: {_short(a.get('body'))}",
        "create_task_list": lambda: f"lista nueva: {_short(a.get('name'))}",
        "create_task_folder": lambda: f"carpeta nueva: {_short(a.get('name'))}",
        "create_task_space": lambda: f"espacio nuevo: {_short(a.get('name'))}",
        "set_server_config": lambda: "configuración de servidor",
        "set_secret_refs": lambda: "referencias de secretos",
        "request_provisioning": lambda: f"aprovisionamiento pedido: {a.get('playbook', '')}",
    }.get(name)
    return ("cac ✓ " + what()) if what else None
