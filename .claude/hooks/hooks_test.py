#!/usr/bin/env python3
"""Las pruebas de los hooks de cac. Se corren desde la raíz del repo:

    python3 .claude/hooks/hooks_test.py

Un cac de mentira en un puerto local y un repo git desechable; los hooks se
ejecutan como los ejecuta Claude Code (un proceso, JSON por stdin).

Roturas que detectan: no buscar la raíz del repo desde una subcarpeta; imprimir
el token; no callar cuando el repo no está atado o cac no contesta; dejar parar
con un commit que nombra una tarea sin handoff posterior; bloquear otra vez con
`stop_hook_active`; tomar `PROTEUS-12` (Jira) por una referencia; pedir
handoff a una tarea ya hecha.
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
        cls.env = dict(os.environ, CLAUDE_CONFIG_DIR=cls.cfgdir, HOME=cls.tmp.name)

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


if __name__ == "__main__":
    unittest.main(verbosity=1)
