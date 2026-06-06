# SQL & Lambda Code Generators

Code generators that produce SQL DDL, stored procedures, and Lambda handler JS from shared JSON data files. All schema definitions live in JSON — the generators contain only logic.

## Data Files (JSON)

| File | Purpose |
|------|---------|
| `tables.json` | All table definitions: columns, types, FKs, checks, uniques, indexes, history/newId flags, natural keys |
| `views.json` | View definitions: base table, joins (INNER/LEFT), column selections, filter indexes |
| `stored_procedures_by.json` | Data for `_by_` filter SPs: view column lists, SP definitions, note/document parent lists |

## Generators

### `generate_tables.js`

- **Reads**: `tables.json`
- **Writes**: `TABLES/*.sql` (CREATE TABLE + triggers + indexes) and `TABLES_HISTORY/*.sql` (history schema tables)
- **Exports**: `tables` array (used by other generators via `require('./generate_tables')`)
- **Run**: `node generate_tables.js`

Each table gets:
- A primary key column (`<table>_id uniqueidentifier`)
- `modified` and `created` audit columns (auto-added, not in JSON)
- A delete-prevention trigger (`TR_<table>_delete`)
- An update trigger that sets `modified` and optionally archives to `history.<table>`
- Unique constraints and indexes

**Options per table**:
- `hasHistory` (default `true`) — generates a history table and archive-on-update logic
- `useNewId` (default `false`) — uses `newid()` instead of `newsequentialid()` for the PK default
- `naturalKey` — array of column names for upsert natural key lookup
- `skipModified` (default `false`) — omits the `modified` audit column. The update trigger only blocks edits to `created` and does not auto-stamp `modified`. Use for true append-only tables (ledgers, event logs). The SP generator's `getAllColumns()` honors this flag so generated SELECTs don't reference the missing column.

### `generate_stored_procedures.js`

- **Reads**: `tables.json` (via `require('./generate_tables')`)
- **Writes**: `STORED_PROCEDURES/sx_get_*.sql`, `sx_list_*.sql`, `sx_upsert_*.sql`, `sx_list_*_history.sql`
- **Run**: `node generate_stored_procedures.js`

For each table generates:
- `sx_get_<table>` — get by PK
- `sx_list_<table>` — paged list with sort
- `sx_upsert_<table>` — insert or update with bitmask field selection and natural key lookup
- `sx_list_<table>_history` — history records for a given PK (only if `hasHistory`)

### `generate_stored_procedures_by.js`

- **Reads**: `tables.json` (via `require('./generate_tables')`), `stored_procedures_by.json`
- **Writes**: `STORED_PROCEDURES/sx_list_*_by_*.sql`
- **Run**: `node generate_stored_procedures_by.js`

Generates filter/navigation SPs that query views or tables by a foreign key. SP definitions in JSON use:
- `columnsFrom` — resolves columns from the `viewColumns` map in the JSON
- `columnsFromTable` — resolves columns dynamically from a table definition
- `filterCol` / `filterType` — simple single-column filter (auto-generates param name)
- `filterParams` / `filterWhere` — custom multi-column filter

Also generates note/document `_by_` SPs dynamically from `noteParents`/`documentParents` arrays (only for tables that exist in `tables.json`).

### `generate_views.js`

- **Reads**: `views.json`
- **Writes**: `VIEWS/vx_*.sql`
- **Run**: `node generate_views.js`

Two view types:
- **Indexed** (`type: "indexed"`) — uses `WITH SCHEMABINDING`, `dbo.` prefixed tables, creates clustered + nonclustered indexes
- **Regular** (`type: "regular"`) — no schemabinding, supports LEFT JOINs for nullable FKs

Join columns can be simple strings or `{"col": "source_col", "as": "alias_name"}` objects.

### `generate_handlers.js`

- **Reads**: `tables.json` (via `require('./generate_tables')` — adjust path as needed)
- **Writes**: `handlers/<table-kebab-case>.js`
- **Run**: `node generate_handlers.js`

Generates Lambda handler modules with `get`, `list`, and `upsert` functions. Each handler has a `FIELDS` bitmask map for selective updates.

**Warning**: Running this generator overwrites handler files. If you have manually customized any handlers, back up or diff before regenerating.

## JSON Schema Reference

### tables.json

Array of table objects:

```json
{
  "name": "my_table",
  "naturalKey": ["col1", "col2"],
  "columns": [
    { "name": "col1", "type": "varchar(50)", "nullable": false },
    { "name": "col2", "type": "int", "nullable": true, "default": "((0))", "defaultLabel": "0" }
  ],
  "fks": [
    { "col": "other_table_id", "refTable": "other_table", "refCol": "other_table_id" }
  ],
  "checks": [
    { "name": "ck__my_table__status", "expr": "status IN ('A', 'B')" }
  ],
  "uniques": [
    { "name": "uq__my_table__col1", "cols": ["col1"], "filter": "optional WHERE clause" }
  ],
  "indexes": [
    { "name": "ix_my_table_col2", "cols": ["col2"] }
  ],
  "hasHistory": true,
  "useNewId": false,
  "skipModified": false
}
```

**Column fields**: `name`, `type`, `nullable` (required); `default`, `defaultLabel` (optional — `default` is the SQL expression, `defaultLabel` is a short name for the constraint)

### views.json

Array of view objects:

```json
{
  "name": "my_detail",
  "type": "indexed",
  "baseTable": "my_table",
  "baseAlias": "m",
  "baseCols": ["col1", "col2"],
  "joins": [
    {
      "table": "other_table", "alias": "o", "type": "INNER",
      "on": "m.other_table_id = o.other_table_id",
      "cols": ["other_name", {"col": "name", "as": "other_display_name"}]
    }
  ],
  "filterIndexes": ["col1"]
}
```

**View types**: `"indexed"` (WITH SCHEMABINDING, INNER JOINs only) or `"regular"` (LEFT JOINs allowed)

### stored_procedures_by.json

```json
{
  "viewColumns": {
    "vx_my_detail": ["my_table_id", "col1", "col2", "other_name", "is_active", "created_on", "created_by", "modified_on", "modified_by"]
  },
  "spDefs": [
    {
      "spName": "sx_list_my_table_by_other",
      "source": "vx_my_detail",
      "columnsFrom": "vx_my_detail",
      "filterCol": "other_table_id",
      "filterType": "UNIQUEIDENTIFIER",
      "purpose": "Retrieves my_table records filtered by other_table"
    }
  ],
  "noteParents": [],
  "documentParents": []
}
```

**SP definition styles**:
- **Simple**: Use `filterCol` + `filterType` — param name is auto-generated as `@p_<PascalCase>`
- **Custom**: Use `filterParams` (array of `{name, type, desc}`) + `filterWhere` + optional `extraParams` (array of `{name, type, desc, default}`)
- **Column sources**: `columnsFrom` (lookup from `viewColumns`) or `columnsFromTable` (computed from table definition)

## Adding a New Table

1. Add the table definition to `tables.json`
2. Run `node generate_tables.js` — creates table + history SQL
3. Run `node generate_stored_procedures.js` — creates get/list/upsert/history SPs
4. Run `node generate_handlers.js` — creates Lambda handler (careful: overwrites existing files)
5. If the table needs `_by_` filter SPs, add entries to `stored_procedures_by.json` and run `node generate_stored_procedures_by.js`
6. If a new view is needed, add it to `views.json` and run `node generate_views.js`
