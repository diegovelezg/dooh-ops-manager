-- 0003 · Búsqueda de texto tolerante (reemplaza pg_trgm + unaccent + los RPC *_search_*).
--
-- Un solo normalizador en la DB (`fn::norm`): sin tildes, minúsculas, tokens por
-- espacio. Las tablas buscables exponen un campo COMPUTED `search` (se evalúa al
-- leer: siempre refleja renombres de empresa/venue relacionados). El query se
-- normaliza con la misma función, así que no hay paridad TS↔SQL que mantener.
--
-- Un token calza si es subcadena del haystack, o —con 4+ letras— si se parece a
-- alguna palabra (Jaro-Winkler ≥ 0.9: tolera typos como "publicitria").
DEFINE ANALYZER search_norm TOKENIZERS blank FILTERS ascii, lowercase;

DEFINE FUNCTION fn::norm($s: option<string>) -> string {
  RETURN array::join(search::analyze('search_norm', $s ?? ''), ' ');
};

/** Hasta 6 tokens normalizados del query del usuario. */
DEFINE FUNCTION fn::tokens($q: option<string>) -> array<string> {
  RETURN array::slice(search::analyze('search_norm', $q ?? ''), 0, 6);
};

DEFINE FUNCTION fn::token_hit($hay: string, $t: string) -> bool {
  RETURN string::contains($hay, $t)
    OR (string::len($t) >= 4
        AND array::any(string::split($hay, ' '), |$w| string::similarity::jaro_winkler($w, $t) >= 0.9));
};

/** AND de tokens (sin tokens = todo calza). */
DEFINE FUNCTION fn::match_all($hay: string, $tokens: array<string>) -> bool {
  RETURN array::all($tokens, |$t| fn::token_hit($hay, $t));
};

/** Relevancia: similitud con el campo principal, subcadena en él (0.8) o en el
 *  resto (0.5), más 0.15 si el principal empieza con el query. Solo para ordenar. */
DEFINE FUNCTION fn::match_score($primary: string, $hay: string, $q: string) -> float {
  IF $q = '' { RETURN 0.0 };
  LET $best = math::max([
    string::similarity::jaro_winkler($primary, $q),
    IF string::contains($primary, $q) { 0.8 } ELSE { 0.0 },
    IF string::contains($hay, $q) { 0.5 } ELSE { 0.0 }
  ]);
  RETURN $best + IF string::starts_with($primary, $q) { 0.15 } ELSE { 0.0 };
};
