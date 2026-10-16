import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `scripts/next-version.sh`, la ley del versionado (ver `CLAUDE.md`, «Soltar
 * una release»): sobre un repositorio de mentira, cada clase de commit sube lo
 * que le toca. Vive en la suite de la app para que corra en el CI.
 *
 * Mutantes: `feat` como parche; no reiniciar el parche al subir la del medio;
 * tomar como base la etiqueta más reciente y no la más alta (reusaría un
 * número gastado); no ver el `!` de un cambio que rompe.
 */
const script = join(process.cwd(), "..", "scripts", "next-version.sh");
let repo = "";

function git(...args: string[]) {
  execFileSync("git", args, { cwd: repo, stdio: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
}

function commit(msg: string) {
  git("commit", "--allow-empty", "-q", "-m", msg);
}

function next(): string {
  return execFileSync("bash", [script, "--no-fetch"], { cwd: repo, stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
}

function setup(tag = "v1.6.105") {
  repo = mkdtempSync(join(tmpdir(), "next-version-"));
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  git("config", "tag.gpgsign", "false");
  commit("chore: inicio");
  git("tag", tag);
}

afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
  repo = "";
});

describe("la versión siguiente", () => {
  it("sólo arreglos: la última", () => {
    setup();
    commit("fix(voz): un hueco");
    commit("docs: notas");
    expect(next()).toBe("v1.6.106");
  });

  it("alguna función nueva: la del medio, y el parche vuelve a cero", () => {
    setup();
    commit("fix: algo");
    commit("feat(chat): responder");
    expect(next()).toBe("v1.7.0");
  });

  it("algo que rompe: la primera", () => {
    setup("v1.7.3");
    commit("feat(api)!: otra forma de entrar");
    expect(next()).toBe("v2.0.0");
  });

  it("la base es la etiqueta más alta, aunque otra sea más reciente", () => {
    setup("v1.6.104");
    commit("fix: viejo");
    git("tag", "v1.6.9");
    commit("fix: nuevo");
    expect(next()).toBe("v1.6.105");
  });
});
