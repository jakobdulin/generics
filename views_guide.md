# Views Guide

## Overview

Views denormalize commonly joined tables to avoid repeating JOINs across multiple stored procedures. A single view definition is maintained and indexed, then SPs query the view instead of writing raw multi-table JOINs.

## Naming Convention

- **Prefix**: `vx_` (all views)
- **Format**: `vx_{descriptive_name}` — typically `vx_{base_table}_detail` or `vx_{relationship_name}`
- **File naming**: `vx_{name}.sql`, one view per file in `SQL/VIEWS/`

## View Types

### Indexed Views (WITH SCHEMABINDING)

Use indexed views when **all** of these conditions are met:
- All JOINs are INNER JOIN (no LEFT/RIGHT/OUTER)
- All FK columns involved are NOT NULL
- All functions used are deterministic (no GETDATE(), NEWID(), etc.)

**Requirements:**
- `CREATE VIEW ... WITH SCHEMABINDING` — references tables as `dbo.table_name`
- No `SELECT *` — all columns must be explicitly listed
- Create a **unique clustered index** on the base table's PK column
- Create **nonclustered indexes** on FK columns used for filtering in SPs

### Regular Views (No SCHEMABINDING)

Use regular views when any of these conditions apply:
- LEFT JOIN is needed (nullable FKs)
- Non-deterministic functions are required
- SCHEMABINDING restrictions cannot be met

**Characteristics:**
- No `WITH SCHEMABINDING`
- No indexes on the view itself
- Still centralizes JOIN logic for SP reuse

## Column Selection

Each view should include:
- **PKs** of all joined tables (for filtering and joining)
- **Business columns** from joined tables that SPs need
- **Audit columns** (`is_active`, `created_on`, `created_by`, `modified_on`, `modified_by`) from the **base table only**
- **Lookup names** from reference/lookup tables (e.g., `account_type_name`, `relationship_name`)

## File Structure

Each view file follows this pattern:

### Indexed View Template
```sql
IF EXISTS (SELECT * FROM sys.views WHERE name = 'vx_{name}')
    DROP VIEW vx_{name};
GO

CREATE VIEW vx_{name}
WITH SCHEMABINDING
AS
    SELECT
        -- base table PK and columns
        -- joined table PKs and columns
        -- audit columns from base table only
    FROM dbo.{base_table} bt
    INNER JOIN dbo.{joined_table} jt ON bt.{fk} = jt.{pk}
    -- additional INNER JOINs
GO

-- Unique clustered index on base table PK
CREATE UNIQUE CLUSTERED INDEX ix_vx_{name}_pk
    ON vx_{name} ({base_table}_id);

-- Nonclustered indexes on filter columns
CREATE NONCLUSTERED INDEX ix_vx_{name}_{filter_col}
    ON vx_{name} ({filter_col});
GO
```

### Regular View Template
```sql
IF EXISTS (SELECT * FROM sys.views WHERE name = 'vx_{name}')
    DROP VIEW vx_{name};
GO

CREATE VIEW vx_{name}
AS
    SELECT
        -- base table PK and columns
        -- joined table PKs and columns
        -- audit columns from base table only
    FROM {base_table} bt
    INNER JOIN {joined_table} jt ON bt.{fk} = jt.{pk}
    LEFT JOIN {optional_table} ot ON bt.{nullable_fk} = ot.{pk}
GO
```

## Index Naming for Views

- **Clustered**: `ix_vx_{view_name}_pk`
- **Nonclustered**: `ix_vx_{view_name}_{column_name}`

## Examples

### Indexed View Example
`vx_account_detail` — account joined with account_type and household:
- All FKs are NOT NULL → eligible for SCHEMABINDING
- Clustered index on `account_id`
- Nonclustered indexes on `household_id`, `account_type_id`

### Regular View Example
`vx_task_detail` — task joined with employee, optionally household/person/account:
- `household_id`, `person_id`, `account_id` are nullable → requires LEFT JOIN
- No SCHEMABINDING, no indexes on view
