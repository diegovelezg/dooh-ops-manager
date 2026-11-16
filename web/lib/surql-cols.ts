// Proyecciones SurrealQL inline para columnas calculadas.
// `fn::iso` / `fn::key` son funciones de usuario: cada llamada cuesta ~6 µs (medido en SurrealDB 4.0.1:
// 247 ms vs 105 ms para 32 000 llamadas sobre 16 000 líneas). Un `<string>` / `record::id` inline es
// el mismo resultado sin la llamada: en tablas grandes y listas completas se nota.
// Los campos son identificadores/rutas del propio código (nunca entrada de usuario).

/** Instante ISO (string) o NONE; equivale a `fn::iso(f)`. */
export const iso = (f: string): string => `IF ${f} { <string> ${f} } ELSE { NONE }`;

/** Id plano del record enlazado o NONE; equivale a `fn::key(f)`. */
export const key = (f: string): string => `IF ${f} { record::id(${f}) } ELSE { NONE }`;
