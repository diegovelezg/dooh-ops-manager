<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->

## Política de REMOVE seguro (migraciones destructivas)

Toda migración en `surreal/migrations/` que elimine datos o esquema (`REMOVE TABLE`, `REMOVE FIELD`,
`REMOVE DATABASE`, o `DELETE` masivo) DEBE blindarse. Reglas obligatorias:

1. **Pre-chequeo con `THROW`:** antes de cada `REMOVE TABLE` / `REMOVE FIELD` destructivo, contar filas
   y abortar si hay datos que nadie declaró vacíos:
   ```surql
   LET $n = (SELECT VALUE count() FROM mi_tabla GROUP ALL)[0] ?? 0;
   IF $n > 0 { THROW string::concat('REMOVE bloqueado: mi_tabla tiene ', <string> $n, ' filas; crear _backup o migrar antes') };
   REMOVE TABLE mi_tabla;
   ```
   Un comentario que afirme "cero filas" sin el `THROW` no cuenta.
2. **Backup antes de borrar:** si la tabla/campo puede tener filas en algún entorno (prod incluido), copiar a
   `_backup_<fecha>` (`INSERT INTO _backup_<fecha> (SELECT * FROM mi_tabla)`) en la misma migración en vez de
   `REMOVE` directo. Solo `REMOVE` directo con conteo 0 verificado por el `THROW` anterior.
3. **Irreversibles documentados:** operaciones sin vuelta atrás (p. ej. redondear precios) llevan comentario
   `IRREVERSIBLE:` con el porqué y el alcance medido (`SELECT count() … WHERE …` previo).
4. **Una migración aplicada no se edita** (el migrador compara checksums): los cambios van en una nueva.
5. **Historia pre-SurrealDB:** las 119 migraciones SQL de Supabase se retiraron con la migración a SurrealDB
   (2026-11); siguen en el historial de git (`git log -- supabase/migrations`).
