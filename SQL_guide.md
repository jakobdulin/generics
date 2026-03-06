# SQL Style Guide

When we build an MSSQL SQL database for a project, we first build files with
CREATE statements, in a folder structure that mimics SSMS tree structure.

We STRIVE to build and maintain 3NF databases. We do not use plural names for
tables. Do not store calculated fields. Avoid combined data fields, except in
cases of date/time. Try to use the smallest field type possible for the data
forecasted to be stored.

## Folder Structure
```
SQL/
├── TABLES/              # CREATE TABLE statements
├── TABLES_HISTORY/      # History schema tables (generated)
├── STORED_PROCEDURES/   # CREATE PROCEDURE statements (sx_ prefix)
├── TYPES/               # User-defined table types
├── VIEWS/               # CREATE VIEW statements (vx_ prefix)
├── INDEXES/             # Index definitions
├── tables.json          # Table definitions for generators
├── views.json           # View definitions for generators
├── stored_procedures_by.json  # Filter SP definitions for generators
├── generate_tables.js         # Table & history table SQL generator
├── generate_stored_procedures.js      # CRUD SP generator
├── generate_stored_procedures_by.js   # Filter SP generator
├── generate_views.js          # View SQL generator
└── generators.md              # Generator documentation

SQL_Automation/
├── deploy_tables.sh           # Deploy tables to database
├── deploy_procedures.sh       # Deploy stored procedures to database
├── deploy_triggers.sh         # Deploy triggers to database
├── script_all_tables.sh       # Export table DDL from database
├── script_all_procedures.sh   # Export stored procedure DDL from database
├── script_all_triggers.sh     # Export trigger DDL from database
├── script_all_views.sh        # Export view DDL from database
├── Script_Create_Table.sql    # Helper: reconstruct CREATE TABLE from metadata
└── Script_Create_Trigger.sql  # Helper: reconstruct trigger DDL from metadata

lambda/
└── generate_handlers.js       # Lambda handler generator
```

## File Naming
- One object per file
- Filename = object name + `.sql`
- Tables: `{table_name}.sql`
- Stored procedures: `sx_{action}_{table}.sql`
- Views: `vx_{name}.sql`
- Types: `{TypeName}.sql` PascalCase

## Execution Order
1. TYPES (dependencies for procedures)
2. TABLES (foreign key order matters)
3. VIEWS
4. STORED_PROCEDURES
5. INDEXES

## Rules

- **No dynamic SQL** — never use `EXEC()`, `sp_executesql`, or string-built queries in stored procedures. Use static SQL with `CASE` expressions for conditional logic (e.g., dynamic sort columns). Dynamic SQL breaks ownership chaining and requires direct table permissions.

## Code Generators

Table definitions, views, stored procedures, and Lambda handlers can be generated from JSON data files. The generators read from `tables.json`, `views.json`, and `stored_procedures_by.json` and produce SQL files in the corresponding output folders.

See `generators.md` for full documentation on how to use the generators, JSON schema reference, and the workflow for adding new tables.

## SQL Automation Scripts

The `SQL_Automation/` folder contains shell scripts for deploying SQL to a database and extracting DDL from an existing database.

All scripts accept the same four required flags:
```
bash <script>.sh -s SERVER -d DATABASE -u USER -k SECRET_ID
```
- `-s` / `--server` — SQL Server hostname
- `-d` / `--database` — Database name
- `-u` / `--user` — Login username
- `-k` / `--secret-id` — AWS Secrets Manager secret ID for the password

### Deploy Scripts
Deploy generated or hand-written SQL files to the target database.

| Script | Deploys | Notes |
|--------|---------|-------|
| `deploy_tables.sh` | `TYPES/*.sql` then `TABLES/*.sql` | Uses `deploy_order.txt` for dependency ordering if present, otherwise alphabetical |
| `deploy_procedures.sh` | `STORED_PROCEDURES/*.sql` | All files in directory |
| `deploy_triggers.sh` | `TABLES/TRIGGERS/*.sql` | All files in directory |

#### Table Deployment Order
If tables have foreign key dependencies, create a `deploy_order.txt` file listing table files in dependency order (one per line, supports `#` comments):
```
# Level 0 - No dependencies
TABLES/account_type.sql
TABLES/setting.sql
# Level 1 - Depends on Level 0
TABLES/account.sql
```

### Scripting Scripts
Extract DDL from an existing database into local SQL files (reverse-engineering).

| Script | Exports | Output |
|--------|---------|--------|
| `script_all_tables.sh` | All user tables | `TABLES/*.sql` |
| `script_all_procedures.sh` | All stored procedures | `STORED_PROCEDURES/*.sql` |
| `script_all_triggers.sh` | All triggers (per table) | `TABLES/TRIGGERS/*.sql` |
| `script_all_views.sh` | All views | `VIEWS/*.sql` + consolidated `VIEWS/views.sql` |

## Related Guides
- Table creation: see `tables_guide.md`
- Stored procedure creation: see `sp_guide.md`
- View creation: see `views_guide.md`
- Code generators: see `generators.md`
