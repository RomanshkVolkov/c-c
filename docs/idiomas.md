# Dos idiomas: qué se traduce, qué no, y por qué

cac se lee en inglés o en castellano. Este documento no explica cómo se usa
i18next —eso está en su documentación— sino **las decisiones que no se deducen
del código** y que, tomadas al revés, dejan la aplicación medio traducida sin
que nadie se entere.

Última revisión: **2026-08-29**.

## 1 · La distinción que lo ordena todo: efímero o persistido

Casi todas las preguntas de este trabajo se contestan solas sabiendo en cuál de
las dos cajas cae el texto.

| | **Efímero** | **Persistido** |
|---|---|---|
| Qué es | El mensaje de un error de la API, un toast, una etiqueta | Una fila de la bandeja de avisos |
| Cuándo se lee | En el acto | Meses después |
| Quién decide el idioma | Quien mira, ahora | **Quien la va a leer**, cuando se escribió |
| Dónde se traduce | **En el cliente** | **En el servidor**, al escribir la fila |

Lo persistido es lo único que **obliga** a que exista un catálogo en el
servidor. Una fila de `notifications` se escribe una vez y ya está en la base de
datos cuando el cliente la ve: si la frase se arma en el sitio que la provoca,
Ana escribiendo en castellano le deja a Bob una fila en castellano para siempre.
Por eso `Aviso` lleva `TitleKey`/`TitleArgs` y no sólo `Title`, y por eso el
idioma se resuelve dentro de `Notify` —que es el único punto que sabe quién es
el destinatario— y no en `dm.go` ni en `chat.go`.

Lo efímero **no** lo obliga, y ahí el plan original decía leer `Accept-Language`
en un middleware. Se descartó a conciencia: la etiqueta de código que ya viaja en
cada `SendErrorResponse` (`inbox-other-org`, `rate-limited`) **es** la clave de
traducción, el cliente ya la lee por separado, y el contrato público ya declara
la frase como decorativa. Traducirlo en el cliente sale mejor por tres lados: no
toca 530 llamadas, funciona contra servidores ya desplegados, y el mensaje cambia
de idioma al instante al cambiar la preferencia, sin ida y vuelta. Las claves de
error están igualmente en `internal/core/i18n/catalog.go`, porque el día que un
correo saliente las necesite ya estarán.

Lo hace `phraseFor` en `lib/server-errors.ts`, y tiene **tres emisores**: los
handlers de Go, el motor de voz de Rust (`voice-no-mic`, `voice-screen-denied`) y
el propio cliente. Módulo aparte y no un rincón de `api.ts` justamente por el
segundo: el store de voz no tiene por qué importar el cliente HTTP entero.

La regla que lo hace seguro: **una etiqueta que no esté en el catálogo se queda
con el texto que llegó**, no con la etiqueta cruda. Un servidor —o un binario del
motor— más nuevo puede inventar un código que esta versión no conoce, y
«Error: widget-exploded» es peor que la frase en inglés que ese emisor ya mandó.
La pertenencia se comprueba con un `in` contra el catálogo inglés, no
preguntándole a i18next si devolvió la clave: lo segundo es una heurística que
una traducción parecida a su clave rompería, y además no deja tipar nada.

## 2 · Qué NO se traduce, y por qué

Esta sección es la que más ahorra: casi todo el trabajo mal hecho de una
traducción es traducir algo que no debía traducirse.

### Los identificadores, nunca

`open`, `done`, `dm:message`, `inbox-other-org`. Son lo que una cosa **es**. El
rótulo va aparte, y en `types/report.ts` va **por clave de catálogo**
(`STATUS_LABEL_KEYS`), no por palabra. El repositorio avisa en cuatro sitios de
que renombrar una columna no cambia lo que esa columna es; guardar la palabra
traducida en la tabla de estados ataría la lógica al idioma.

### Los comentarios de sistema

`status: pending → closed`, `assigned to Ana`. Salen de la organización —los
pinta la app del tenant—, son **inmutables por contrato público documentado**, y
su forma es maquinal, no prosa. Traducirlos rompería a cualquier receptor que los
parsee, y traducir sólo los nuevos dejaría el hilo con dos formatos.

### Los payloads de webhook

Ya son identificadores y contenido de persona. Nada que hacer, y conviene no
tocarlos.

### El contenido de una persona

El título de un reporte, el nombre de una tarjeta, el cuerpo de un comentario.
Por eso `Aviso.Title` sigue existiendo junto a `TitleKey`: hay avisos cuyo título
es contenido, y ésos no se traducen ni deben.

### Los instrumentos

Una pantalla que **mide** en vez de servir a un cliente se queda en inglés y
fuera del catálogo. Hoy son `VoiceLab` y todo `/devtools/*` (`CryptoTools`,
`RequestClient`). El criterio: quien la usa mantiene el sistema, y lo que copia
de ahí acaba pegado en un reporte que lee el mismo equipo. Meter «addTransceiver»
o «unified plan» en un catálogo bilingüe es coste de mantenimiento a cambio de
nada. **El texto de un instrumento va en inglés**, no en castellano — eso también
es una regla, y la vigila la prueba de §4.

### Los sustantivos de una herramienta ajena

En la consola de servidores se traduce la chrome —botones, vacíos, errores— y se
dejan **Stack, Swarm, Replicas, Image, Node, Secret, Variable**. Son los nombres
que esas cosas tienen en Docker y en GitHub; traducirlos aleja la pantalla de la
documentación que quien la usa va a consultar.

### El nombre de un idioma

El selector dice «Español», no «Spanish». En cualquier catálogo del mundo el
nombre de un idioma se escribe en ese idioma.

## 3 · Lo que hubo que rehacer, no traducir

Cuatro formas que no sobreviven a una sustitución de cadenas. Están aquí porque
son el molde de lo que va a volver a aparecer.

- **Los plurales cosidos** (`? "" : "s"`, `noun(s)`). Sólo funcionan en inglés y
  sólo con plurales regulares: «reunión» hace «reuniones» y el acento
  desaparece. Ahora los decide el catálogo con `_one`/`_other`.
- **La concatenación** (`"Every " + n + " weeks"`). El número no cae en el mismo
  sitio y el sustantivo cambia de género. Cada caso es **un mensaje entero** con
  el número dentro.
- **La media oración** (`voice/frase.ts` devolvía `"Marta is"` para que la vista
  le pegara el verbo). La lista la junta `Intl.ListFormat` y la frase completa,
  con su verbo concordado, vive en el catálogo.
- **El sustantivo por prop** (`<ItemCalendar noun="report">`). Ahora entra la
  clave del mensaje entero.

Regla general: **una frase se traduce entera o no se traduce**. En cuanto una
pantalla pega dos trozos, hay un idioma en el que no encajan.

## 4 · Las redes que lo sostienen

Ninguna de estas pruebas comprueba una traducción. Comprueban que no se deshaga
lo que ya está hecho, que es distinto y es lo que se rompe solo.

| Prueba | Qué caza |
|---|---|
| `lib/i18n.test.ts` · claves | Una frase añadida en un idioma y olvidada en el otro |
| `lib/i18n.test.ts` · vacías | Una traducción en blanco, que pasa el control de claves y deja un hueco |
| `lib/i18n.test.ts` · un solo idioma | Castellano dentro de la app en inglés, escaneando el fuente |
| `lib/plurales.test.ts` | Un `? "" : "s"` o un `noun(s)` que vuelva |
| `lib/horas.test.ts` | Que la regla de una reunión no vuelva a concatenarse |
| `lib/locale-sync.test.ts` | Que elegir idioma se cuente al servidor y que entrar lo adopte |
| `core/i18n/leaks_test.go` | Castellano en un literal de Go fuera del catálogo |
| `core/i18n/i18n_test.go` | Que la `q` de `Accept-Language` mande sobre el orden del texto |
| `service/notification_locale_test.go` | Que el aviso se escriba en el idioma de quien lo lee |
| `lib/api-errors.test.ts` | Un código que Go o Rust emiten y el catálogo no conoce |
| `lib/i18n.test.ts` · avisos | Un `toast` con la frase escrita a mano |

Dos detalles de cómo están hechas, porque el primer intento de cada una estaba
mal:

- **Los comentarios van en castellano** por la regla del repositorio, así que el
  escáner tiene que distinguirlos. Descartar la línea por cómo empieza **no
  vale**: la segunda línea de un bloque `{/* … */}` de JSX empieza por texto
  normal y medio repositorio salía como fuga. En TypeScript hay un escáner que
  lleva la cuenta de si está dentro de un bloque; en Go se parsea el árbol con
  `go/parser` y se miran **sólo los literales de cadena**, que ahí sí es exacto.
- **Las plantillas tampoco se ven a simple vista.** El guardián de los avisos
  se escribió al final y encontró **veintiuna** frases escritas a mano que
  habían sobrevivido a todas las pasadas anteriores, por una razón tonta: eran
  `` toast.success(`Removed ${server.name}`) `` y las búsquedas iban detrás de
  comillas dobles. Mira sólo el primer argumento, que es el que se lee grande;
  el `description` casi siempre lleva el error crudo del servidor, y ése no se
  traduce.
- **Las tildes no bastan.** `"Cargando…"` llevaba meses en el cajón de una
  tarjeta y el guardián lo daba por bueno. Hay además una lista corta de
  palabras — deliberadamente corta: una lista larga acaba marcando código
  legítimo, y un guardián que ladra de más se apaga.

## 5 · Cómo añadir una frase

1. Al catálogo **inglés** primero: es el idioma base y el que define qué claves
   existen. Los tipos se declaran sobre él (`types/i18next.d.ts`), así que una
   clave mal escrita **no compila**.
2. Al castellano. Si se olvida, la prueba de claves falla.
3. En la pantalla, `const { t } = useT()` — con los espacios ya cargados, así que
   `t("nav:account.theme")` compila y una errata no.

Fuera de un componente hay dos salidas legítimas y una trampa:

- **`i18next.t` directo** cuando no hay hook posible: un componente de clase
  (`ErrorBoundary`, que tiene que serlo porque `componentDidCatch` no existe en
  función), o un callback fuera del árbol. Se pierde el repintado al cambiar de
  idioma; en una pantalla de la que se sale recargando, da igual.
- **`t` por parámetro** cuando una función de `lib/` arma una frase
  (`reglaLegible`). Así sigue siendo pura y se puede probar sin montar media
  aplicación, y la suscripción es la de la pantalla que la llama.
- La trampa: llamar a `i18next.t` desde dentro de una función de `lib/` que usa
  una pantalla. Compila, funciona, y no cambia de idioma hasta que algo más
  provoque un repintado.

## 6 · Dónde vive el idioma de cada quien

`domain.User.Locale` (`varchar(5)`; vacío = «el del sistema»), expuesto en
`/auth/me` y editable con `PATCH /auth/locale`. En el cliente, `locale.store.ts`
—calcado de `theme.store.ts`— y `lib/locale-sync.ts`, que es la única pieza que
sabe de las dos cosas.

Tres decisiones que parecen detalles y no lo son:

- **Vacío, no «en» por omisión.** Hay diferencia real entre «elegí inglés» y «no
  he elegido», y sólo la segunda debe seguir al sistema operativo.
- **Se aplica antes de contarlo.** Quien pulsa «ES» quiere verlo ya, no cuando
  conteste la red. Un fallo de red no se enseña: lo único que se pierde es que la
  otra máquina tarde en enterarse.
- **`chooseLocale` no rechaza nunca**, y con `try` y no con `.catch`. `.catch`
  sólo atrapa la promesa rechazada; una llamada que revienta **antes** de
  devolverla —el cliente sin montar, que es lo que pasa en una prueba que simula
  media API— se escapa por el lado. Lo destapó la suite entera.

## 7 · Lo que queda

Nada del alcance planeado. Lo que sí falta es **mirarlo**: el castellano ocupa
entre un 15 % y un 25 % más que el inglés, y ninguna de estas pruebas comprueba
que quepa donde tiene que caber. Los sitios donde se va a notar son los botones
estrechos y las cabeceras de tabla.

Y una deuda concreta que este trabajo dejó a la vista: `voice.store.ts`,
`VoiceStage.tsx` y `OrgMeetings.tsx` siguen con identificadores en castellano
—`compartiendo`, `sordo`, `Ficha`, `Formulario`—. Se renombra lo que se toca al
pasar, no de golpe.
