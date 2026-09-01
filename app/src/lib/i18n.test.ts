import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import i18next from "i18next";

import { LOCALES } from "@/store/locale.store";

/**
 * Los dos catálogos dicen lo mismo.
 *
 * Éste es **el** modo de fallo de traducir una aplicación, y no se parece a un
 * fallo: una clave que falta en castellano sale en inglés, sin error, sin traza
 * y sin romper nada. La interfaz queda medio traducida y sólo se entera quien la
 * mire — normalmente un cliente.
 *
 * Se comparan los ficheros, no lo que i18next haya cargado en memoria: lo que se
 * quiere vigilar es que nadie añada una frase a un idioma y se olvide del otro,
 * y eso pasa en el fichero.
 */

const RAIZ = join(process.cwd(), "src/locales");

/** Todas las claves de un objeto anidado, aplanadas: `action.save`. */
function claves(obj: unknown, prefijo = ""): string[] {
  if (typeof obj !== "object" || obj === null) return [prefijo];
  return Object.entries(obj).flatMap(([k, v]) =>
    claves(v, prefijo ? `${prefijo}.${k}` : k),
  );
}

function catalogo(locale: string, ns: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(RAIZ, locale, `${ns}.json`), "utf-8"));
}

const espacios = readdirSync(join(RAIZ, "en"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""));

/** Los `.ts` y `.tsx` de la aplicación, sin pruebas ni catálogos. */
function fuentes(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const ruta = join(dir, e.name);
    if (e.isDirectory()) return e.name === "locales" ? [] : fuentes(ruta);
    if (!/\.tsx?$/.test(e.name) || e.name.includes(".test.")) return [];
    return [ruta];
  });
}
/**
 * El fichero sin sus comentarios.
 *
 * Los comentarios **sí** van en castellano: es la regla del repositorio, y
 * son la mitad de la prosa de estos ficheros. Descartarlos por cómo empieza
 * la línea no vale —lo probé—: la segunda línea de un bloque `{/* … *\/}` de
 * JSX empieza por texto normal, así que medio repositorio salía como fuga.
 * Hay que llevar la cuenta de si se está dentro de un bloque, que es lo que
 * hace esto: se recorre carácter a carácter y se sustituye lo comentado por
 * espacios, para que los números de línea sigan siendo los del fichero.
 */
function sinComentarios(src: string): string {
  let fuera = "";
  let bloque = false;
  for (let i = 0; i < src.length; i++) {
    const dos = src.slice(i, i + 2);
    if (bloque) {
      if (dos === "*/") { bloque = false; fuera += "  "; i++; continue; }
      fuera += src[i] === "\n" ? "\n" : " ";
      continue;
    }
    if (dos === "/*") { bloque = true; fuera += "  "; i++; continue; }
    // `//` de una línea, pero no el de `https://`: sin esa salvedad se
    // comería el resto de cualquier línea con una URL dentro.
    if (dos === "//" && src[i - 1] !== ":") {
      while (i < src.length && src[i] !== "\n") { fuera += " "; i++; }
      fuera += "\n";
      continue;
    }
    fuera += src[i];
  }
  return fuera;
}
describe("los catálogos", () => {
  it("tienen los mismos ficheros en los dos idiomas", () => {
    for (const locale of LOCALES) {
      const suyos = readdirSync(join(RAIZ, locale)).filter((f) => f.endsWith(".json")).sort();
      expect(suyos).toEqual(espacios.map((n) => `${n}.json`).sort());
    }
  });

  // La prueba que importa: una clave añadida en inglés y olvidada en castellano
  // no se ve en ninguna pantalla hasta que alguien lee esa frase en español.
  it.each(espacios)("«%s» tiene las mismas claves en los dos", (ns) => {
    const enClaves = claves(catalogo("en", ns)).sort();
    for (const locale of LOCALES) {
      if (locale === "en") continue;
      const otras = claves(catalogo(locale, ns)).sort();
      const faltan = enClaves.filter((k) => !otras.includes(k));
      const sobran = otras.filter((k) => !enClaves.includes(k));
      expect({ faltan, sobran }).toEqual({ faltan: [], sobran: [] });
    }
  });

  // Una cadena vacía pasa el control de claves y deja un hueco en pantalla, que
  // es peor que la frase en inglés.
  it.each(espacios)("«%s» no tiene traducciones vacías", (ns) => {
    for (const locale of LOCALES) {
      const plano = catalogo(locale, ns);
      const vacias = claves(plano).filter((k) => {
        const valor = k.split(".").reduce<unknown>((o, p) => (o as never)?.[p], plano);
        return typeof valor === "string" && valor.trim() === "";
      });
      expect(vacias).toEqual([]);
    }
  });

  // Sin esto, una frase en inglés dentro del catálogo español pasaría por
  // traducida. No se puede comprobar el idioma, pero sí que alguien lo tocó.
  it("el castellano no es una copia literal del inglés", () => {
    const en = JSON.stringify(catalogo("en", "common"));
    const es = JSON.stringify(catalogo("es", "common"));
    expect(es).not.toBe(en);
  });
});

describe("el catálogo en marcha", () => {
  // La reserva es la red de la red: los catálogos se mantienen a la par por la
  // prueba de arriba, así que una clave que falte no debería existir. Cuando
  // exista igualmente —una clave escrita a mano con una errata, una rama que
  // alguien olvidó— tiene que salir en inglés y no un hueco.
  it("una clave que falte en castellano sale en inglés", () => {
    expect(i18next.options.fallbackLng).toContain("en");
  });

  it("y traduce de verdad cuando se le pide en castellano", () => {
    expect(i18next.t("notifications:tab.all", { lng: "es" })).toBe("Todo");
    expect(i18next.t("notifications:tab.all", { lng: "en" })).toBe("All");
  });

  // El plural del castellano no es el del inglés en todos los casos, y el
  // catálogo tiene formas separadas: si alguien las colapsa, esto se cae.
  it("el plural cambia con la cantidad", () => {
    const una = i18next.t("notifications:byAgent_group", { count: 1, lng: "es" });
    const varias = i18next.t("notifications:byAgent_group", { count: 3, lng: "es" });
    // Comparar las dos frases enteras no vale: **difieren por el número
    // interpolado** aunque el plural esté colapsado, así que la prueba pasaría
    // con una sola forma. Y «escritos» contiene «escrito», de modo que buscar
    // el singular tampoco distingue. Lo que separa las dos formas es que la del
    // singular **no** lleva la ese.
    expect(una).not.toContain("escritos");
    expect(varias).toContain("escritos");
  });
});

/**
 * La interfaz no habla dos idiomas a la vez.
 *
 * Éste no es el fallo de una traducción que falta sino el contrario: frases
 * escritas directamente en castellano dentro de una aplicación en inglés,
 * puestas ahí por quien las escribió pensando en castellano. Se veían en la
 * pantalla de fallo, en el cajón de una tarjeta y en los ajustes de la
 * organización, y nadie las reportó nunca — quien las leía asumía que la app
 * era así.
 *
 * Se buscan las letras que el inglés no tiene. Es una heurística, no una
 * gramática: se le escapa una frase en castellano sin tildes ni eñes. A cambio
 * no tiene falsos positivos que haya que ir apagando, que es lo que mata a un
 * guardián de éstos.
 */
describe("un solo idioma en el código", () => {
  const RAIZ_SRC = join(process.cwd(), "src");





  // El nombre de un idioma se escribe en ese idioma, en cualquier catálogo del
  // mundo: el selector dice «Español», no «Spanish», y eso es lo correcto.
  const PERMITIDO = [
    /"Español"/,
    // Y este otro no es texto de la interfaz sino un patrón contra **filas ya
    // guardadas**: los avisos de mensaje directo que escribió el servidor
    // antes de todo esto llevan el título en castellano. Traducir esas filas
    // no se puede —ya están escritas— así que hay que seguir sabiendo
    // reconocerlas. Ver `labelOf` en `notification-groups.ts`.
    / te escribió\$\//,
  ];

  /**
   * Las tildes no bastan, y lo demostró un caso real: `"Cargando…"` llevaba
   * meses en el cajón de una tarjeta y este guardián lo daba por bueno porque
   * no tiene ni tilde ni eñe.
   *
   * La lista es corta y deliberadamente conservadora — sólo palabras que en
   * inglés no existen o no significan nada parecido. Una lista larga acaba
   * marcando código legítimo, y un guardián que ladra de más se apaga.
   */
  const PALABRAS = new RegExp(
    "\\b(" +
      [
        "Cargando", "Guardar", "Cancelar", "Borrar", "Buscar", "Enviar",
        "Nombre", "Cerrar", "Abrir", "Nuevo", "Nueva", "Ninguno", "Ninguna",
        "Elige", "Escribe", "Todav", "Selecciona", "Pulsa",
      ].join("|") +
      ")\\b",
  );

  /**
   * Lo que se escribe **para el tablero** no es interfaz.
   *
   * Una tarjeta de fallo la lee quien la arregla, no quien la sufrió, y el
   * tablero de cac está en castellano entero. Pasar esos cuerpos por el
   * catálogo los partiría en dos idiomas según qué tuviera puesto cada quien —
   * y buscar un fallo repetido entre tarjetas en dos idiomas es peor que
   * leerlas todas en uno.
   *
   * Es una tercera categoría, distinta de «interfaz» y de «instrumento»: un
   * documento generado para consumo interno. Va por fichero y no por línea
   * porque estos tres existen para eso y nada más.
   */
  const DOCUMENTOS = [
    "lib/voice-report.ts",
    "components/ErrorBoundary.tsx",
    "components/TaskDetailDrawer.tsx",
  ];

  it("ninguna frase en castellano fuera de los catálogos", () => {
    const fugas: string[] = [];
    for (const fichero of fuentes(RAIZ_SRC)) {
      if (DOCUMENTOS.some((d) => fichero.endsWith(d))) continue;
      sinComentarios(readFileSync(fichero, "utf-8")).split("\n").forEach((linea, i) => {
        if (!/[áéíóúñ¿¡ÁÉÍÓÚÑ]/.test(linea) && !PALABRAS.test(linea)) return;
        if (PERMITIDO.some((p) => p.test(linea))) return;
        fugas.push(`${fichero.replace(RAIZ_SRC, "src")}:${i + 1}: ${linea.trim()}`);
      });
    }
    expect(fugas).toEqual([]);
  });
});

/**
 * Ningún aviso con la frase escrita a mano.
 *
 * Un `toast.error("Could not save")` es la forma más fácil de volver a dejar la
 * aplicación medio traducida: compila, funciona, se ve bien en inglés, y no lo
 * caza ninguna de las otras redes — no lleva plural, no lleva tildes, y el
 * compilador no tiene nada que decir sobre una cadena.
 *
 * Se mira sólo el **primer argumento**, que es el que se lee grande. El
 * `description` casi siempre lleva el error crudo del servidor y ése no se
 * traduce ni debe.
 */
describe("los avisos", () => {
  const RAIZ = join(process.cwd(), "src");

  // Los instrumentos van en inglés a conciencia; ver `docs/idiomas.md`.
  const INSTRUMENTOS = /\/(devtools|VoiceLab|CryptoTools|RequestClient|ImageTool)/;

  it("ninguno lleva la frase escrita a mano", () => {
    const fugas: string[] = [];
    for (const fichero of fuentes(RAIZ)) {
      if (INSTRUMENTOS.test(fichero)) continue;
      readFileSync(fichero, "utf-8")
        .split("\n")
        .forEach((linea, i) => {
          // Una comilla justo detrás del paréntesis: la frase, y no una
          // variable ni una llamada a `t`.
          if (!/toast\.(error|success|warning|info|message)\(\s*["`]/.test(linea)) return;
          fugas.push(`${fichero.replace(RAIZ, "src")}:${i + 1}: ${linea.trim()}`);
        });
    }
    expect(fugas).toEqual([]);
  });
});

/**
 * Prosa suelta en JSX, sin traducir.
 *
 * Es la tercera forma de dejarse una cadena, y la que sobrevivió a todos los
 * barridos: no lleva atributo ni comillas, así que ni `placeholder=` ni `"…"`
 * la encuentran. En integraciones había un párrafo de tres líneas explicando
 * qué es una llave de ingesta, en inglés, debajo de seis pestañas traducidas.
 *
 * Se busca **texto de tres o más palabras** entre etiquetas. Menos de tres deja
 * fuera el ruido —una palabra suelta suele ser un nombre propio o parte de una
 * expresión partida— y desde tres ya es una frase que alguien escribió para que
 * la lean.
 */
describe("la prosa de las pantallas", () => {
  const RAIZ = join(process.cwd(), "src");

  // Los instrumentos van en inglés a conciencia; ver `docs/idiomas.md`.
  const INSTRUMENTOS = /\/(devtools|VoiceLab|CryptoTools|RequestClient|ImageTool)/;

  /**
   * `components/ui/` es shadcn, copiado y regenerable.
   *
   * Su prosa —el texto para lectores de pantalla de un cajón lateral— no la
   * escribimos nosotros, y traducirla nos separa de la fuente: la próxima vez
   * que se actualice un componente habría que volver a meter el cambio a mano.
   * Es poco texto y ninguno de él decide nada.
   */
  const PRESTADO = /\/components\/ui\//;

  /**
   * Nombres propios y jerga que no se traducen, con su razón:
   *
   * - Docker y GitHub nombran sus cosas así, y traducirlas aleja la pantalla de
   *   su propia documentación.
   * - «COMMAND» y «CONTROL» son el nombre del producto.
   */
  const PERMITIDO =
    /Docker Swarm|Claude Code|COMMAND|CONTROL|GitHub|Personal Access Token|LiveKit|PipeWire/;

  it("ninguna frase suelta sin pasar por el catálogo", () => {
    const fugas: string[] = [];
    for (const fichero of fuentes(RAIZ)) {
      if (INSTRUMENTOS.test(fichero) || PRESTADO.test(fichero)) continue;
      sinComentarios(readFileSync(fichero, "utf-8"))
        .split("\n")
        .forEach((linea, i) => {
          // Entre `>` y `<`, o una línea de texto plano dentro de un bloque JSX.
          const suelto = linea.match(/>\s*([A-Z][a-zA-Z',.!?—-]*(?:\s+[a-zA-Z',.!?—-]+){2,})\s*</);
          const solo = linea.match(/^\s{6,}([A-Z][a-zA-Z',.!?—-]*(?:\s+[a-zA-Z',.!?—-]+){2,})\s*$/);
          const texto = suelto?.[1] ?? solo?.[1];
          if (!texto || PERMITIDO.test(texto)) return;
          fugas.push(`${fichero.replace(RAIZ, "src")}:${i + 1}: ${texto}`);
        });
    }
    expect(fugas).toEqual([]);
  });
});
