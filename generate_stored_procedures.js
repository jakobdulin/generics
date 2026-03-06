const fs = require('fs');
const path = require('path');

const tables = require('./generate_tables');

const SP_DIR = path.join(__dirname, 'STORED_PROCEDURES');

if (!fs.existsSync(SP_DIR)) {
  fs.mkdirSync(SP_DIR, { recursive: true });
}

// ============================================================
// Helpers
// ============================================================

function toPascalCase(snake) {
  return snake.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}

function getAllColumns(table) {
  return [
    `${table.name}_id`,
    ...table.columns.map(c => c.name),
    'modified',
    'created',
  ];
}

function pkParam(table) {
  return `@p_${toPascalCase(table.name)}RecordId`;
}

function colParam(col) {
  return `@p_${toPascalCase(col.name)}`;
}

// ============================================================
// sx_get_
// ============================================================

function generateGet(table) {
  const name = table.name;
  const pk = pkParam(table);
  const spName = `sx_get_${name}`;
  const cols = getAllColumns(table);
  const selectList = cols.map(c => `        ${c}`).join(',\n');

  return `/*
=============================================================================
Procedure: ${spName}
Purpose: Retrieves a single ${name} record by primary key
Author: Generated
Created: 2026-02-22

Parameters:
    ${pk} UNIQUEIDENTIFIER - The ${name} primary key

Returns:
    Single row result set or empty if not found
=============================================================================
*/
IF EXISTS (SELECT * FROM sys.procedures WHERE name = '${spName}')
    DROP PROCEDURE ${spName};
GO

CREATE PROCEDURE ${spName}
    ${pk} UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;

    SELECT
${selectList}
    FROM ${name}
    WHERE ${name}_id = ${pk};

    SET NOCOUNT OFF;
END;
GO
`;
}

// ============================================================
// sx_list_
// ============================================================

function generateList(table) {
  const name = table.name;
  const spName = `sx_list_${name}`;
  const cols = getAllColumns(table);
  const selectList = cols.map(c => `        ${c}`).join(',\n');

  // Build whitelist of sortable column names
  const sortableCols = cols.map(c => `'${c}'`).join(', ');

  return `/*
=============================================================================
Procedure: ${spName}
Purpose: Retrieves a paged list of ${name} records
Author: Generated
Created: 2026-02-22

Parameters:
    @p_PageNumber INT = 1 - Page number (1-based)
    @p_PageSize INT = 50 - Number of records per page
    @p_SortBy NVARCHAR(50) = 'created' - Column name to sort by
    @p_SortDirection NVARCHAR(4) = 'DESC' - Sort direction (ASC or DESC)
    @o_RecordCount INT OUTPUT - Total number of matching records

Returns:
    Paged result set with sort and direction applied
    @o_RecordCount contains total matching records for paging UI
=============================================================================
*/
IF EXISTS (SELECT * FROM sys.procedures WHERE name = '${spName}')
    DROP PROCEDURE ${spName};
GO

CREATE PROCEDURE ${spName}
    @p_PageNumber INT = 1,
    @p_PageSize INT = 50,
    @p_SortBy NVARCHAR(50) = 'created',
    @p_SortDirection NVARCHAR(4) = 'DESC',
    @o_RecordCount INT OUTPUT
AS
BEGIN
    SET NOCOUNT ON;

    -- Validate sort parameters
    IF @p_SortBy NOT IN (${sortableCols})
        SET @p_SortBy = 'created';

    IF @p_SortDirection NOT IN ('ASC', 'DESC')
        SET @p_SortDirection = 'DESC';

    -- Total count
    SELECT @o_RecordCount = COUNT(*)
    FROM ${name};

    -- Paged results
    SELECT
${selectList}
    FROM ${name}
    ORDER BY
        CASE WHEN @p_SortDirection = 'ASC' THEN
            CASE @p_SortBy
${cols.map(c => `                WHEN '${c}' THEN CAST(${c} AS SQL_VARIANT)`).join('\n')}
            END
        END ASC,
        CASE WHEN @p_SortDirection = 'DESC' THEN
            CASE @p_SortBy
${cols.map(c => `                WHEN '${c}' THEN CAST(${c} AS SQL_VARIANT)`).join('\n')}
            END
        END DESC
    OFFSET (@p_PageNumber - 1) * @p_PageSize ROWS
    FETCH NEXT @p_PageSize ROWS ONLY;

    SET NOCOUNT OFF;
END;
GO
`;
}

// ============================================================
// sx_upsert_
// ============================================================

function generateUpsert(table) {
  const name = table.name;
  const pk = pkParam(table);
  const spName = `sx_upsert_${name}`;
  const cols = table.columns;

  // -- Parameter list --
  const params = [];
  params.push(`    ${pk} UNIQUEIDENTIFIER = NULL`);

  const bitmaskDocs = [];
  cols.forEach((col, i) => {
    params.push(`    ${colParam(col)} ${col.type.toUpperCase()} = NULL`);
    bitmaskDocs.push(`        ${1 << i} = ${col.name}`);
  });

  params.push(`    @p_UpdateFields INT = 0`);
  params.push(`    @o_IsSuccess BIT OUTPUT`);
  params.push(`    @o_ErrorMessage NVARCHAR(255) OUTPUT`);
  params.push(`    @o_NewRecordId UNIQUEIDENTIFIER OUTPUT`);

  // -- Required field validation (NOT NULL, no default) --
  const requiredCols = cols.filter(c => !c.nullable && !c.default);
  let insertValidation = '';
  for (const col of requiredCols) {
    const p = colParam(col);
    insertValidation += `
            IF ${p} IS NULL
            BEGIN
                SET @o_ErrorMessage = '${col.name} is required';
                ROLLBACK TRANSACTION;
                RETURN -1;
            END
`;
  }

  // -- Natural key lookup (when pk is NULL, find existing by natural key) --
  let naturalKeyLookup = '';
  if (table.naturalKey && table.naturalKey.length > 0) {
    const nkCols = table.naturalKey;
    const nkConditions = nkCols.map(nk => {
      const col = cols.find(c => c.name === nk);
      const p = colParam(col);
      if (col.nullable) {
        return `(${nk} = ${p} OR (${nk} IS NULL AND ${p} IS NULL))`;
      }
      return `${nk} = ${p}`;
    }).join('\n                AND ');

    // Build the all-fields bitmask for natural key match (all non-key columns)
    const allFieldsBitmask = cols.reduce((mask, col, i) => {
      if (!nkCols.includes(col.name)) {
        return mask | (1 << i);
      }
      return mask;
    }, 0);

    naturalKeyLookup = `
        -- Natural key lookup: check if record already exists
        IF ${pk} IS NULL
        BEGIN
            SELECT ${pk} = ${name}_id
            FROM ${name}
            WHERE ${nkConditions};

            IF ${pk} IS NOT NULL
            BEGIN
                SET @o_NewRecordId = ${pk};
                -- Set update bitmask to all non-key fields
                SET @p_UpdateFields = ${allFieldsBitmask};
            END
        END
`;
  }

  // -- INSERT columns and values --
  const insertCols = cols.map(c => c.name);
  const insertVals = cols.map(col => {
    const p = colParam(col);
    if (col.default) {
      return `ISNULL(${p}, ${col.default})`;
    }
    return p;
  });

  const insertColStr = insertCols.map(c => `                ${c}`).join(',\n');
  const insertValStr = insertVals.map(v => `                ${v}`).join(',\n');

  // -- UPDATE SET clause with bitmask --
  const updateSets = [];
  cols.forEach((col, i) => {
    const bit = 1 << i;
    const p = colParam(col);
    updateSets.push(`                ${col.name} = CASE WHEN (@p_UpdateFields & ${bit}) = ${bit} THEN ${p} ELSE ${col.name} END`);
  });

  // -- Change detection: skip UPDATE if all bitmask fields already match --
  const changeChecks = [];
  cols.forEach((col, i) => {
    const bit = 1 << i;
    const p = colParam(col);
    changeChecks.push(`                AND ((@p_UpdateFields & ${bit}) = 0 OR ${col.name} = ${p} OR (${col.name} IS NULL AND ${p} IS NULL))`);
  });

  return `/*
=============================================================================
Procedure: ${spName}
Purpose: Inserts or updates a ${name} record
Author: Generated
Created: 2026-02-22

Parameters:
    ${pk} UNIQUEIDENTIFIER = NULL - NULL for insert, existing ID for update
    @p_UpdateFields INT = 0 - Bitmask for selective updates:
${bitmaskDocs.join('\n')}
    @o_IsSuccess BIT OUTPUT - 1 if succeeded, 0 if failed
    @o_ErrorMessage NVARCHAR(255) OUTPUT - Error description if failed
    @o_NewRecordId UNIQUEIDENTIFIER OUTPUT - The record ID (new or existing)

Returns:
    0 on success, -1 on failure
=============================================================================
*/
IF EXISTS (SELECT * FROM sys.procedures WHERE name = '${spName}')
    DROP PROCEDURE ${spName};
GO

CREATE PROCEDURE ${spName}
${params.join(',\n')}
AS
BEGIN
    SET NOCOUNT ON;

    -- Initialize output parameters
    SET @o_IsSuccess = 0;
    SET @o_ErrorMessage = '';
    SET @o_NewRecordId = ${pk};
${naturalKeyLookup}
    BEGIN TRY
        BEGIN TRANSACTION;

        IF ${pk} IS NULL
        BEGIN
            -- INSERT
${insertValidation}
            DECLARE @InsertedIds TABLE (id UNIQUEIDENTIFIER);

            INSERT INTO ${name} (
${insertColStr}
            )
            OUTPUT INSERTED.${name}_id INTO @InsertedIds
            VALUES (
${insertValStr}
            );

            SELECT @o_NewRecordId = id FROM @InsertedIds;
        END
        ELSE
        BEGIN
            -- UPDATE (only if at least one field has actually changed)
            IF NOT EXISTS (SELECT 1 FROM ${name} WHERE ${name}_id = ${pk})
            BEGIN
                SET @o_ErrorMessage = '${name} not found';
                ROLLBACK TRANSACTION;
                RETURN -1;
            END

            -- Skip update if all included fields already match (prevents unnecessary history)
            IF NOT EXISTS (
                SELECT 1 FROM ${name}
                WHERE ${name}_id = ${pk}
${changeChecks.join('\n')}
            )
            BEGIN
                UPDATE ${name}
                SET
${updateSets.join(',\n')}
                WHERE ${name}_id = ${pk};
            END
        END

        COMMIT TRANSACTION;
        SET @o_IsSuccess = 1;
        RETURN 0;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        SET @o_ErrorMessage = ERROR_MESSAGE();
        SET @o_IsSuccess = 0;
        RETURN -1;
    END CATCH

    SET NOCOUNT OFF;
END;
GO
`;
}

// ============================================================
// sx_list_*_history
// ============================================================

function generateListHistory(table) {
  const name = table.name;
  const pk = pkParam(table);
  const spName = `sx_list_${name}_history`;
  const cols = getAllColumns(table);
  const selectList = [
    `        ${name}_history_id`,
    ...cols.map(c => `        ${c}`),
    '        archived_at',
  ].join(',\n');

  return `/*
=============================================================================
Procedure: ${spName}
Purpose: Retrieves history records for a specific ${name} row
Author: Generated
Created: 2026-02-22

Parameters:
    ${pk} UNIQUEIDENTIFIER - The ${name} primary key to get history for

Returns:
    All archived versions of the record, most recent first
=============================================================================
*/
IF EXISTS (SELECT * FROM sys.procedures WHERE name = '${spName}')
    DROP PROCEDURE ${spName};
GO

CREATE PROCEDURE ${spName}
    ${pk} UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;

    SELECT
${selectList}
    FROM history.${name}
    WHERE ${name}_id = ${pk}
    ORDER BY archived_at DESC;

    SET NOCOUNT OFF;
END;
GO
`;
}

// ============================================================
// Write files
// ============================================================

let count = 0;
for (const table of tables) {
  const sps = [
    [`sx_get_${table.name}`, generateGet(table)],
    [`sx_list_${table.name}`, generateList(table)],
    [`sx_upsert_${table.name}`, generateUpsert(table)],
  ];

  if (table.hasHistory) {
    sps.push([`sx_list_${table.name}_history`, generateListHistory(table)]);
  }

  for (const [spName, sql] of sps) {
    fs.writeFileSync(path.join(SP_DIR, `${spName}.sql`), sql, 'utf8');
    count++;
  }
}

console.log(`Generated ${count} stored procedure files in ${SP_DIR}`);
