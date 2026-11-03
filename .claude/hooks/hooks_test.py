#!/usr/bin/env python3
"""Las pruebas de los hooks de cac. Se corren desde la raíz del repo:

    python3 .claude/hooks/hooks_test.py

Un cac de mentira en un puerto local y un repo git desechable; los hooks se
ejecutan como los ejecuta Claude Code (un proceso, JSON por stdin).

Roturas que detectan: no buscar la raíz del repo desde una subcarpeta; imprimir
el token; no callar cuando el repo no está atado o cac no contesta; dejar parar
con un commit que nombra una tarea sin handoff posterior; bloquear otra vez con
`stop_hook_active`; tomar `PROTEUS-12` (Jira) por una referencia; pedir
handoff a una tarea ya hecha; no enseñar al arrancar lo abierto que puede
morder; que el prompt no traiga lo que mordió en lo que nombra, lo traiga por
una palabra de dos letras o a medias, lo repita en la misma sesión, o no
refresque el vocabulario viejo; y que al editar un fichero no salgan los
incidentes cuya prueba vive ahí, salgan los de otro fichero por casar a medias,
se impriman en texto plano (no le llegan al modelo) o aprueben la edición.
"""
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from cac_hooks import go_test_index, guards_for  # noqa: E402

ANSWERS = {}


class FakeCac(BaseHTTPRequestHandler):
    def do_GET(self):
        for prefix, (code, body) in ANSWERS.items():
            if self.path.startswith(prefix):
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"success": code == 200, "data": body}).encode())
                return
        self.send_response(404)
        self.end_headers()

    def log_message(self, *a):
        pass


def run_hook(name, payload, env):
    return subprocess.run(
        [sys.executable, os.path.join(HERE, name)],
        input=json.dumps(payload), capture_output=True, text=True, env=env, timeout=30,
    )


def git_repo(path, commit_subject):
    os.makedirs(path, exist_ok=True)

    def g(*a):
        subprocess.run(["git", "-C", path, *a], check=True, capture_output=True)

    g("init", "-q")
    g("config", "user.email", "x@y.z")
    g("config", "user.name", "x")
    g("config", "commit.gpgsign", "false")
    g("remote", "add", "origin", "git@github.com:guz-studio/cac.git")
    with open(os.path.join(path, "a"), "w") as f:
        f.write("a")
    g("add", "a")
    g("commit", "-q", "-m", commit_subject)


class Hooks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), FakeCac)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}"
        cls.tmp = tempfile.TemporaryDirectory()
        cls.cfgdir = os.path.join(cls.tmp.name, "cfg")
        os.makedirs(cls.cfgdir)
        with open(os.path.join(cls.cfgdir, ".claude.json"), "w") as f:
            json.dump({"mcpServers": {"cac": {"env": {"CAC_URL": cls.url, "CAC_TOKEN": "t-prueba"}}}}, f)
        cls.repo = os.path.join(cls.tmp.name, "repo")
        git_repo(cls.repo, "feat: algo (cc-7)")
        os.makedirs(os.path.join(cls.repo, "app"))
        cls.env = dict(os.environ, CLAUDE_CONFIG_DIR=cls.cfgdir, HOME=cls.tmp.name,
                       XDG_CACHE_HOME=os.path.join(cls.tmp.name, ".cache"))

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.tmp.cleanup()

    def setUp(self):
        ANSWERS.clear()

    # ── cac-session ──

    def test_session_prints_the_space_and_what_is_in_progress_from_a_subfolder(self):
        ANSWERS["/api/v1/context?repo=guz-studio%2Fcac"] = (200, {
            "space": {"name": "cac", "key": "cc", "orgName": "G Studio"},
            "inProgress": [{
                "ref": "cc-7", "title": "Claves", "assignees": ["ana"],
                "handoff": "Falta la release.\nSiguiente: probar.", "handoffBy": "Ana", "handoffAt": "2026-10-22T08:00:00Z",
            }],
        })
        r = run_hook("cac-session", {"cwd": os.path.join(self.repo, "app"), "source": "startup"}, self.env)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("cac (cc)", r.stdout)
        self.assertIn("- cc-7 Claves — ana · dónde quedó: Falta la release. (Ana, 2026-10-22)", r.stdout)
        self.assertNotIn("t-prueba", r.stdout, "el token nunca se imprime")

    def test_session_says_nothing_when_the_repo_is_not_linked_or_there_is_no_repo(self):
        ANSWERS["/api/v1/context"] = (404, {"error": "context-repo-not-linked"})
        r = run_hook("cac-session", {"cwd": self.repo}, self.env)
        self.assertEqual((r.returncode, r.stdout), (0, ""))
        r = run_hook("cac-session", {"cwd": self.tmp.name}, self.env)
        self.assertEqual((r.returncode, r.stdout), (0, ""))

    def test_session_shows_what_is_still_open_in_the_space(self):
        ANSWERS["/api/v1/context?repo=guz-studio%2Fcac"] = (200, {"space": {"id": "sp-1", "name": "cac"}, "inProgress": []})
        ANSWERS["/api/v1/incidents/?spaceId=sp-1&status=open"] = (200, {"incidents": [
            {"id": "inc-1", "title": "pixel-vps corre cert-manager 1.14", "servers": [{"name": "pixel-vps"}], "areas": ["cert-manager"]},
        ]})
        r = run_hook("cac-session", {"cwd": self.repo}, self.env)
        self.assertIn("Trampas abiertas (1):", r.stdout)
        self.assertIn("- pixel-vps, cert-manager · pixel-vps corre cert-manager 1.14 (inc-1)", r.stdout)

    def test_session_lists_the_tasks_whose_commits_already_shipped(self):
        ANSWERS["/api/v1/context?repo=guz-studio%2Fcac"] = (200, {"space": {"name": "cac", "key": "cc"}, "inProgress": [
            {"ref": "cc-7", "title": "Salió", "shipped": {"tag": "v1.9.1", "at": "2026-11-03T00:00:00Z"}},
            {"ref": "cc-8", "title": "Falta"},
        ]})
        r = run_hook("cac-session", {"cwd": self.repo}, self.env)
        self.assertIn("Ya salieron (ciérralas con status done y un comentario):\n- cc-7 · v1.9.1", r.stdout)
        tail = r.stdout.split("Ya salieron")[1]
        self.assertNotIn("cc-8", tail, "una sin shipped no está entre las que salieron")

    def test_session_says_when_an_open_trap_is_already_fixed_in_a_release(self):
        ANSWERS["/api/v1/context?repo=guz-studio%2Fcac"] = (200, {"space": {"id": "sp-1", "name": "cac"}, "inProgress": []})
        ANSWERS["/api/v1/incidents/?spaceId=sp-1&status=open"] = (200, {"incidents": [
            {"id": "inc-1", "title": "verificando para siempre", "areas": ["provisioning"], "shipped": {"tag": "v1.9.1"}},
            {"id": "inc-2", "title": "sigue mordiendo", "areas": ["mcp"]},
        ]})
        r = run_hook("cac-session", {"cwd": self.repo}, self.env)
        self.assertIn("verificando para siempre (inc-1) · arreglo publicado en v1.9.1", r.stdout)
        self.assertIn("sigue mordiendo (inc-2)\n", r.stdout)

    # ── cac-prompt ──

    def prompt(self, text, session="s-1"):
        r = run_hook("cac-prompt", {"prompt": text, "session_id": session, "cwd": self.repo}, self.env)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout

    def fresh_vocabulary(self, incidents):
        cache = os.path.join(self.tmp.name, ".cache", "cac-hooks")
        if os.path.isdir(cache):
            for f in os.listdir(cache):
                os.remove(os.path.join(cache, f))
        ANSWERS["/api/v1/incidents/"] = (200, {"incidents": incidents})

    INCIDENTS = [
        {"id": "inc-1", "title": "cert-manager 1.14 no limpia el reto", "status": "open",
         "servers": [{"name": "pixel-vps"}], "areas": ["cert-manager"]},
        {"id": "inc-2", "title": "ufw corta la red del clúster", "status": "fixed",
         "servers": [{"name": "gstd"}], "areas": ["k8s", "ui"]},
    ]

    def test_a_prompt_that_names_a_server_brings_what_bit_there(self):
        self.fresh_vocabulary(self.INCIDENTS)
        out = self.prompt("Vamos a actualizar Pixel-VPS mañana")
        self.assertIn("pixel-vps", out)
        self.assertIn("[abierto] cert-manager 1.14 no limpia el reto", out)
        self.assertIn("get_incident inc-1", out)
        self.assertNotIn("inc-2", out, "trae lo de otro servidor")
        self.assertNotIn("t-prueba", out)

    def test_a_prompt_without_known_names_says_nothing(self):
        self.fresh_vocabulary(self.INCIDENTS)
        # «ui» es un área de inc-2, pero dos letras casarían con medio idioma;
        # y «gstdx» no es «gstd».
        self.assertEqual(self.prompt("arregla la ui del gstdx", session="s-2"), "")

    def test_an_incident_is_shown_once_per_session(self):
        self.fresh_vocabulary(self.INCIDENTS)
        self.assertIn("inc-2", self.prompt("en gstd falla k8s", session="s-3"))
        self.assertEqual(self.prompt("y otra vez gstd", session="s-3"), "", "se repite en la misma sesión")
        self.assertIn("inc-2", self.prompt("gstd", session="s-4"), "otra sesión no lo ve")

    def test_the_vocabulary_is_asked_again_when_it_is_old(self):
        self.fresh_vocabulary([])
        self.assertEqual(self.prompt("gstd", session="s-5"), "")
        # Lo cacheado está vacío y fresco: aunque cac ya tenga uno, no se pide.
        ANSWERS["/api/v1/incidents/"] = (200, {"incidents": self.INCIDENTS})
        self.assertEqual(self.prompt("gstd", session="s-5"), "")
        path = os.path.join(self.tmp.name, ".cache", "cac-hooks", "incidents.json")
        with open(path) as f:
            cached = json.load(f)
        cached["at"] -= 3600
        with open(path, "w") as f:
            json.dump(cached, f)
        self.assertIn("inc-2", self.prompt("gstd", session="s-5"), "no se refresca lo viejo")

    # ── cac-handoff ──

    def test_stop_is_blocked_until_the_task_named_by_a_commit_has_a_newer_handoff(self):
        ANSWERS["/api/v1/tasks/by-ref/cc-7"] = (200, {"task": {"handoffAt": "2020-01-01T00:00:00Z"}})
        r = run_hook("cac-handoff", {"cwd": os.path.join(self.repo, "app"), "stop_hook_active": False}, self.env)
        self.assertEqual(r.returncode, 0, r.stderr)
        out = json.loads(r.stdout)
        self.assertEqual(out["decision"], "block")
        self.assertIn("cc-7", out["reason"])
        self.assertIn("handoff", out["reason"])

    def test_stop_passes_with_a_fresh_handoff_or_when_already_continuing(self):
        ANSWERS["/api/v1/tasks/by-ref/cc-7"] = (200, {"task": {"handoffAt": "2999-01-01T00:00:00Z"}})
        r = run_hook("cac-handoff", {"cwd": self.repo, "stop_hook_active": False}, self.env)
        self.assertEqual((r.returncode, r.stdout), (0, ""))
        ANSWERS["/api/v1/tasks/by-ref/cc-7"] = (200, {"task": {}})
        r = run_hook("cac-handoff", {"cwd": self.repo, "stop_hook_active": True}, self.env)
        self.assertEqual((r.returncode, r.stdout), (0, ""), "con stop_hook_active no se bloquea otra vez")

    def test_stop_passes_when_the_task_named_by_the_commit_is_already_done(self):
        # La primera vez que corrió de verdad pidió handoff a dos tareas ya
        # publicadas: una hecha o cerrada no lo necesita.
        for status in ("resolved", "closed"):
            ANSWERS["/api/v1/tasks/by-ref/cc-7"] = (200, {"task": {"status": status}})
            r = run_hook("cac-handoff", {"cwd": self.repo, "stop_hook_active": False}, self.env)
            self.assertEqual((r.returncode, r.stdout), (0, ""), status)
        ANSWERS["/api/v1/tasks/by-ref/cc-7"] = (200, {"task": {"status": "in_progress"}})
        r = run_hook("cac-handoff", {"cwd": self.repo, "stop_hook_active": False}, self.env)
        self.assertEqual(json.loads(r.stdout)["decision"], "block", "una en curso sin handoff sí se pide")

    def test_stop_passes_when_no_recent_commit_names_a_task(self):
        other = os.path.join(self.tmp.name, "sinref")
        git_repo(other, "docs: sin tarea PROTEUS-12")
        ANSWERS["/api/v1/tasks/by-ref/"] = (200, {"task": {}})
        r = run_hook("cac-handoff", {"cwd": other, "stop_hook_active": False}, self.env)
        self.assertEqual((r.returncode, r.stdout), (0, ""))

    # ── cac-edit ──

    EDIT_INCIDENTS = [
        {"id": "inc-3", "title": "verificando para siempre", "status": "open",
         "guards": ["app/src/pages/servers/ServerProvision.test.tsx «correr una autorizada»"]},
        {"id": "inc-4", "title": "cert-manager no limpia", "status": "fixed", "servers": [{"name": "gstd"}],
         "guards": ["ansible::tests::cert_manager_can_clean_its_cloudflare_challenge"]},
    ]

    def edit(self, rel, session="e-1"):
        r = run_hook("cac-edit", {"session_id": session, "cwd": self.repo, "hook_event_name": "PreToolUse",
                                  "tool_name": "Edit", "tool_input": {"file_path": os.path.join(self.repo, rel)}}, self.env)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout

    def test_editing_a_file_brings_the_incidents_whose_test_lives_there(self):
        self.fresh_vocabulary(self.EDIT_INCIDENTS)
        out = self.edit("app/src/pages/servers/ServerProvision.tsx")
        got = json.loads(out)["hookSpecificOutput"]
        self.assertEqual(got["hookEventName"], "PreToolUse")
        self.assertIn("[abierto] verificando para siempre", got["additionalContext"])
        self.assertIn("get_incident inc-3", got["additionalContext"])
        self.assertNotIn("inc-4", got["additionalContext"])
        self.assertNotIn("permissionDecision", got, "el hook no aprueba ediciones")
        self.assertNotIn("t-prueba", out)

    def test_an_incident_already_shown_by_the_prompt_is_not_repeated_on_edit(self):
        self.fresh_vocabulary(self.EDIT_INCIDENTS)
        self.assertIn("inc-4", self.prompt("toca gstd", session="e-2"))
        self.assertEqual(self.edit("app/src-tauri/src/ansible.rs", session="e-2"), "")
        self.assertIn("inc-4", self.edit("app/src-tauri/src/ansible.rs", session="e-3"))

    def test_editing_a_file_without_guards_or_outside_the_repo_says_nothing(self):
        # Uno cuyo guardián nombra un fichero de fuera: que no salga dice que
        # se mira el repo, no sólo el nombre.
        self.fresh_vocabulary(self.EDIT_INCIDENTS + [{"id": "inc-5", "title": "fuera", "guards": ["/etc/hosts"]}])
        self.assertEqual(self.edit("app/src/lib/month.ts", session="e-4"), "")
        r = run_hook("cac-edit", {"session_id": "e-4", "cwd": self.repo,
                                  "tool_input": {"file_path": "/etc/hosts"}}, self.env)
        self.assertEqual((r.returncode, r.stdout), (0, ""))
        r = run_hook("cac-edit", {"session_id": "e-4", "cwd": self.repo, "tool_input": {}}, self.env)
        self.assertEqual((r.returncode, r.stdout), (0, ""))


class Guards(unittest.TestCase):
    """El casado de un fichero con los guardianes, sin cac (cac_hooks.guards_for)."""

    def ids(self, rel, guards, go_tests=None):
        found = [{"id": f"i{n}", "guards": g} for n, g in enumerate(guards)]
        return [inc["id"] for inc, _ in guards_for(rel, found, go_tests)]

    def test_a_component_matches_the_test_of_the_same_name(self):
        g = [["app/src/pages/servers/ServerProvision.test.tsx «correr una autorizada»"]]
        self.assertEqual(self.ids("app/src/pages/servers/ServerProvision.tsx", g), ["i0"])
        self.assertEqual(self.ids("app/src/pages/servers/ServerProvision.test.tsx", g), ["i0"])

    def test_a_guard_named_by_its_file_alone_matches(self):
        self.assertEqual(self.ids("app/src/pages/servers/ServerConfig.tsx", [["ServerConfig.test.tsx («aplicar es ensayar»)"]]), ["i0"])

    def test_rust_matches_by_module_not_by_a_word_inside(self):
        g = [["ansible::tests::cert_manager_can_clean_its_cloudflare_challenge"],
             ["ansible::tests::every_host_is_reachable"]]
        self.assertEqual(self.ids("app/src-tauri/src/ansible.rs", g), ["i0", "i1"])
        self.assertEqual(self.ids("app/src-tauri/src/host.rs", g), [], "«host» dentro de un nombre no es host.rs")

    def test_go_matches_by_package_and_by_the_file_of_the_test(self):
        g = [["service.TestTheListAndTheMapCarryTheGuards"], ["repository.TestNadieResuelveElNombreASuAire"]]
        tests = {"TestTheListAndTheMapCarryTheGuards": "backend/internal/core/service/incident_test.go"}
        self.assertEqual(self.ids("backend/internal/core/service/incident.go", g, tests), ["i0"])
        self.assertEqual(self.ids("backend/internal/core/service/task.go", g, tests), [],
                         "otra prueba del paquete no es de este fichero")
        self.assertEqual(self.ids("backend/internal/core/service/task.go", g), ["i0"], "sin el mapa, el paquete basta")
        self.assertEqual(self.ids("backend/internal/core/service/incident_test.go", g, tests), ["i0"],
                         "editar el fichero de la prueba también la trae")

    def test_a_go_file_named_by_its_name_matches(self):
        self.assertEqual(self.ids("backend/internal/core/service/incident_test.go",
                                  [["incident_test.go (TestTheListAndTheMapCarryTheGuards)"]]), ["i0"])

    def test_the_go_index_finds_each_test_in_its_file(self):
        # Sobre este mismo repo: la prueba de la que depende el casado en Go.
        root = os.path.dirname(os.path.dirname(HERE))
        idx = go_test_index(root, "backend/internal/core/service")
        self.assertEqual(idx.get("TestTheListAndTheMapCarryTheGuards"), "backend/internal/core/service/incident_test.go")

    def test_an_incident_with_two_matching_guards_comes_once(self):
        g = [["ansible::tests::a", "ansible::tests::b"]]
        self.assertEqual(self.ids("app/src-tauri/src/ansible.rs", g), ["i0"])


if __name__ == "__main__":
    unittest.main(verbosity=1)
