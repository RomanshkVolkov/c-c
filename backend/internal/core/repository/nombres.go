package repository

// nombreVisible: cómo se llama a alguien, no cómo entra.
//
// El nombre, y sólo si no lo hay, el usuario. Un identificador de acceso no es
// la forma de llamar a una persona: «rvolkov» donde cabe «Romanshk Volkov».
//
// Aquí y no dentro de una superficie concreta porque lo usan tres —la
// documentación, el chat y los directos— y las tres tienen que decir el mismo
// nombre. Escrito por separado, basta con que alguien arregle una para que las
// otras dos se queden diciendo otra cosa sobre la misma persona.
//
// `NULLIF` porque la columna existe desde antes que el hábito de rellenarla: hay
// filas con el nombre vacío, y `COALESCE` sobre `”` devuelve la cadena vacía en
// vez de caer al usuario.
//
// **Sólo para pintar.** Buscar, mencionar o identificar va por `username`, que
// es único y lo elige quien entra; un nombre no lo es ni lo elige nadie.
const nombreVisible = "COALESCE(NULLIF(name, ''), username, '')"
