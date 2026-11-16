// Fragmentos SurrealQL de búsqueda, INLINE. Misma regla que las funciones de la migración 0003
// (`fn::norm`, `fn::token_hit`, `fn::match_all`, `fn::match_score`), que siguen definidas en la DB.
// Van inline porque cada llamada a una `fn::` de usuario cuesta ~35 µs por fila en SurrealDB 4.0.1: con 8 250
// contactos, `fn::match_all` tardaba 183 ms y el mismo cuerpo inline 51 ms (con typos: 230 → 46 ms).
// La prueba "búsqueda inline = fn::" (tests/surreal-search-inline.test.ts) garantiza que no se desincronizan.
// Los argumentos son expresiones/identificadores del propio código (nunca entrada de usuario); el texto del
// usuario viaja solo por variables (`$tokens`, `$qn`).

/** `fn::norm(expr)`: sin tildes, minúsculas, tokens por espacio. */
export const norm = (expr: string): string => `array::join(search::analyze('search_norm', ${expr} ?? ''), ' ')`;

/** `fn::match_all(hay, $tokens)`: AND de tokens; cada uno calza como subcadena o (4+ letras) parecido a alguna palabra. */
export const matchAll = (hay: string, tokens = "$tokens"): string =>
  `array::all(${tokens}, |$t| string::contains(${hay}, $t) OR (string::len($t) >= 4 AND array::any(string::split(${hay}, ' '), |$w| string::similarity::jaro_winkler($w, $t) >= 0.9)))`;

/** `fn::match_score(primary, hay, $qn)`: relevancia solo para ordenar (similitud con el campo principal, subcadena en él o en el resto). */
export const matchScore = (primary: string, hay: string, q = "$qn"): string =>
  `IF ${q} = '' { 0.0 } ELSE {
     math::max([string::similarity::jaro_winkler(${primary}, ${q}), IF string::contains(${primary}, ${q}) { 0.8 } ELSE { 0.0 }, IF string::contains(${hay}, ${q}) { 0.5 } ELSE { 0.0 }])
     + IF string::starts_with(${primary}, ${q}) { 0.15 } ELSE { 0.0 }
   }`;
