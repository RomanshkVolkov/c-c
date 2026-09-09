#!/usr/bin/env python3
"""Aplica mutantes de uno en uno y dice si la prueba los mata.

El ritual se hacía a mano y se rompió por la mecánica, no por la idea:

  - Las comillas del shell lo tumbaron dos veces (un backtick, una línea con
    `const`). Aquí el texto del mutante viaja en un JSON y se aplica leyendo y
    escribiendo el fichero, así que ningún shell lo interpreta.
  - Un patrón que **no casaba** dejaba puesto el mutante anterior y reportaba su
    resultado como si fuera el nuevo. De ahí salieron conclusiones falsas. Aquí
    un patrón que no casa es un error ruidoso que aborta todo, y nunca un
    veredicto.
  - Un mutante que colgaba el proceso no imprimía nada y había que decidir a
    mano si contaba como muerto. Aquí el cuelgue cuenta como muerto, pero se
    marca, porque una prueba que tarda infinito no es una prueba que falla.

Uso:  mutar.py plan.json
      mutar.py plan.json --only <nombre>     # un mutante suelto

Formato del plan:

  {
    "test": "go test ./internal/core/domain/",
    "cwd": "backend",              // opcional, relativo a la raíz del repo
    "timeout": 300,                // opcional, segundos; por defecto 300
    "mutants": [
      {
        "name": "el guard de pertenencia",
        "file": "internal/core/service/voice.go",
        "find": "if !member {",
        "replace": "if false {",
        "times": 1                 // opcional; casos esperados, por defecto 1
      }
    ]
  }

`file` es relativo a `cwd`. `find` tiene que casar `times` veces exactamente.

Los mensajes que salen por pantalla van en castellano a propósito: los lee una
persona, y eso no es código.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

KILLED = "muerto"
SURVIVED = "VIVO"
HUNG = "muerto (por cuelgue)"


class PlanError(Exception):
    """El plan no se puede ejecutar. Ruidoso a propósito: no es un veredicto."""


@dataclass
class Verdict:
    name: str
    state: str
    detail: str


class Backup:
    """Copia de seguridad de los ficheros que se van a tocar.

    Se restaura en un `finally` y también desde el manejador de señales: un
    Ctrl-C a mitad dejaba el mutante puesto en el árbol de trabajo, y el
    siguiente `git diff` mentía sobre lo que había cambiado.
    """

    def __init__(self) -> None:
        self.dir = Path(tempfile.mkdtemp(prefix="mutar-"))
        self.copies: dict[Path, Path] = {}

    def keep(self, target: Path) -> None:
        if target in self.copies:
            return
        copy = self.dir / f"{len(self.copies)}-{target.name}"
        shutil.copy2(target, copy)
        self.copies[target] = copy

    def restore(self) -> None:
        for original, copy in self.copies.items():
            shutil.copy2(copy, original)

    def discard(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)


def run(cmd: str, cwd: Path, timeout: int) -> tuple[str, str]:
    """Devuelve (estado, cola-de-la-salida). Estado: pass | fail | hang.

    Se lanza en su propia sesión y al vencer el plazo se mata **el grupo
    entero**, no el hijo directo. Matando sólo el shell, el `go test` que había
    debajo se quedaba huérfano: un mutante que abre un bucle dejó un proceso
    girando al 99% de una CPU después de que el script diera su veredicto y
    saliera tan tranquilo.
    """
    proc = subprocess.Popen(
        cmd,
        shell=True,
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )
    try:
        raw, _ = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait()
        return "hang", f"sin terminar en {timeout}s"
    lines = (raw or "").strip().splitlines()
    tail = "\n".join(lines[-4:]) if lines else "(sin salida)"
    return ("pass" if proc.returncode == 0 else "fail"), tail


def apply(target: Path, find: str, replace: str, times: int) -> None:
    text = target.read_text()
    found = text.count(find)
    if found != times:
        raise PlanError(
            f"el patrón casa {found} vez/veces en {target}, y se esperaban {times}.\n"
            f"    busca: {find!r}\n"
            "  Un patrón que no casa no es un mutante que sobrevive: es un plan "
            "mal escrito.\n"
            "  Corrige el patrón — copiar la línea del fichero tal cual suele "
            "bastar — y vuelve a correr."
        )
    target.write_text(text.replace(find, replace))


def main() -> int:
    parser = argparse.ArgumentParser(description="Mutación a mano, con la mecánica atada.")
    parser.add_argument("plan", type=Path)
    parser.add_argument("--only", help="corre sólo el mutante con este nombre")
    args = parser.parse_args()

    plan = json.loads(args.plan.read_text())
    cwd = (Path.cwd() / plan.get("cwd", ".")).resolve()
    test = plan["test"]
    timeout = int(plan.get("timeout", 300))
    mutants = plan["mutants"]
    if args.only:
        mutants = [m for m in mutants if m["name"] == args.only]
        if not mutants:
            sys.stdout.flush()
            print(f"no hay ningún mutante llamado {args.only!r}", file=sys.stderr)
            return 2

    # La línea base primero. Sin esto, unas pruebas que ya fallaban harían pasar
    # por «muertos» a todos los mutantes sin que ninguno tuviera mérito.
    print(f"→ línea base: {test}")
    state, tail = run(test, cwd, timeout)
    if state != "pass":
        sys.stdout.flush()
        print(
            f"\n✗ la línea base no está en verde ({state}).\n{tail}\n\n"
            "  Mutar ahora no diría nada: todo saldría «muerto» por un fallo que "
            "ya estaba.",
            file=sys.stderr,
        )
        return 1
    print("  en verde.\n")

    backup = Backup()
    verdicts: list[Verdict] = []

    def on_signal(_sig, _frame):
        backup.restore()
        backup.discard()
        sys.stdout.flush()
        print("\n(interrumpido: ficheros restaurados)", file=sys.stderr)
        sys.exit(130)

    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGTERM, on_signal)

    try:
        for mutant in mutants:
            target = (cwd / mutant["file"]).resolve()
            if not target.is_file():
                raise PlanError(f"no existe el fichero {target}")
            backup.keep(target)
            print(f"→ mutante: {mutant['name']}")
            try:
                apply(target, mutant["find"], mutant["replace"], int(mutant.get("times", 1)))
                state, tail = run(test, cwd, timeout)
            finally:
                # Restaurar entre mutantes, siempre. Es lo que garantiza que el
                # siguiente veredicto hable de su propio mutante y no arrastre
                # el anterior.
                backup.restore()

            if state == "fail":
                verdicts.append(Verdict(mutant["name"], KILLED, tail.splitlines()[-1] if tail else ""))
                print("  muerto.\n")
            elif state == "hang":
                verdicts.append(Verdict(mutant["name"], HUNG, tail))
                print(f"  muerto, pero por cuelgue ({timeout}s). Mirar por qué.\n")
            else:
                verdicts.append(Verdict(mutant["name"], SURVIVED, "las pruebas pasan con el fallo dentro"))
                print("  VIVO — las pruebas pasan con el fallo dentro.\n")
    except PlanError as e:
        backup.restore()
        sys.stdout.flush()
        print(f"\n✗ {e}", file=sys.stderr)
        return 1
    finally:
        backup.restore()
        backup.discard()

    width = max((len(v.name) for v in verdicts), default=8)
    print("\n" + "─" * (width + 26))
    for v in verdicts:
        print(f"{v.name.ljust(width)}  {v.state}")
    print("─" * (width + 26))

    survivors = [v for v in verdicts if v.state == SURVIVED]
    hangs = [v for v in verdicts if v.state == HUNG]
    if hangs:
        print(
            f"\n{len(hangs)} mutante(s) contados como muertos por cuelgue. Una prueba "
            "que tarda infinito no es una prueba que falla: mirar si es un bucle "
            "que el mutante abre, o una espera sin tope."
        )
    if survivors:
        print(
            f"\n{len(survivors)} mutante(s) VIVO(s). Se investiga, no se ignora: casi "
            "siempre es la prueba la que está mal, no el código. Si de verdad es "
            "un mutante equivalente, anótalo como tal en vez de inventarle una "
            "prueba."
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
