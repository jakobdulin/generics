const fs = require('fs');
const path = require('path');

const tables = require('./generate_tables');
const spByData = require('./stored_procedures_by.json');

const SP_DIR = path.join(__dirname, 'SQL', 'STORED_PROCEDURES');

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
    'is_active',
    'created_on',
    'created_by',
    'modified_on',
    'modified_by',
  ];
}

function getTableDef(name) {
  return tables.find(t => t.name === name);
}

// ============================================================
// Data — loaded from stored_procedures_by.json
// ============================================================

const viewColumns = spByData.viewColumns;

// ============================================================
// _by_ list SP generator
// ============================================================

/**
 * Generate a _by_ list SP.
 *
 * @param {object} opts
 * @param {string} opts.spName - Full SP name
 * @param {string} opts.source - Table or view to query from
 * @param {string[]} opts.columns - Columns to SELECT
 * @param {string} opts.purpose - Description for header comment
 * @param {Array<{name, type, desc}>} opts.filterParams - Filter parameters
 * @param {string} opts.filterWhere - WHERE clause for filter (uses param names)
 * @param {Array<{name, type, desc, default}>} [opts.extraParams] - Extra params (date ranges etc.)
 */
function generateListBy(opts) {
  const {
    spName, source, columns, purpose,
    filterParams, filterWhere,
    extraParams = [],
  } = opts;

  const selectList = columns.map(c => `        ${c}`).join(',\n');
  const sortableCols = columns.map(c => `'${c}'`).join(', ');

  // Build parameter list
  const paramLines = [];
  for (const fp of filterParams) {
    paramLines.push(`    ${fp.name} ${fp.type}`);
  }
  for (const ep of extraParams) {
    const defaultStr = ep.default !== undefined ? ` = ${ep.default}` : '';
    paramLines.push(`    ${ep.name} ${ep.type}${defaultStr}`);
  }
  paramLines.push(`    @p_PageNumber INT = 1`);
  paramLines.push(`    @p_PageSize INT = 50`);
  paramLines.push(`    @p_SortBy NVARCHAR(50) = 'created_on'`);
  paramLines.push(`    @p_SortDirection NVARCHAR(4) = 'DESC'`);
  paramLines.push(`    @p_IncludeInactive BIT = 0`);

  // Build parameter docs
  const paramDocs = [];
  for (const fp of filterParams) {
    paramDocs.push(`    ${fp.name} ${fp.type} - ${fp.desc}`);
  }
  for (const ep of extraParams) {
    paramDocs.push(`    ${ep.name} ${ep.type} - ${ep.desc}`);
  }
  paramDocs.push(`    @p_PageNumber INT = 1 - Page number (1-based)`);
  paramDocs.push(`    @p_PageSize INT = 50 - Number of records per page`);
  paramDocs.push(`    @p_SortBy NVARCHAR(50) = 'created_on' - Column name to sort by`);
  paramDocs.push(`    @p_SortDirection NVARCHAR(4) = 'DESC' - Sort direction (ASC or DESC)`);
  paramDocs.push(`    @p_IncludeInactive BIT = 0 - If 1, include inactive records in results`);
  paramDocs.push(`    @o_RecordCount INT OUTPUT - Total number of matching records`);

  // sp_executesql parameter declarations
  const execParamDecls = ['@IncludeInactive BIT', '@PageNumber INT', '@PageSize INT'];
  const execParamVals = [
    '@IncludeInactive = @p_IncludeInactive',
    '@PageNumber = @p_PageNumber',
    '@PageSize = @p_PageSize',
  ];

  for (const fp of filterParams) {
    const cleanName = fp.name.replace('@p_', '@');
    execParamDecls.push(`${cleanName} ${fp.type}`);
    execParamVals.push(`${cleanName} = ${fp.name}`);
  }
  for (const ep of extraParams) {
    const cleanName = ep.name.replace('@p_', '@');
    execParamDecls.push(`${cleanName} ${ep.type}`);
    execParamVals.push(`${cleanName} = ${ep.name}`);
  }

  // Build the WHERE clause for count and dynamic SQL
  // The filterWhere uses @p_ names for the count query, and clean names for dynamic SQL
  const countWhere = filterWhere;
  const dynWhere = filterWhere.replace(/@p_/g, '@');

  return `/*
=============================================================================
Procedure: ${spName}
Purpose: ${purpose}
Author: Generated
Created: 2026-02-18

Parameters:
${paramDocs.join('\n')}

Returns:
    Paged result set with sort and direction applied
    @o_RecordCount contains total matching records for paging UI
=============================================================================
*/
IF EXISTS (SELECT * FROM sys.procedures WHERE name = '${spName}')
    DROP PROCEDURE ${spName};
GO

CREATE PROCEDURE ${spName}
${paramLines.join(',\n')},
    @o_RecordCount INT OUTPUT
AS
BEGIN
    SET NOCOUNT ON;

    -- Validate sort parameters
    IF @p_SortBy NOT IN (${sortableCols})
        SET @p_SortBy = 'created_on';

    IF @p_SortDirection NOT IN ('ASC', 'DESC')
        SET @p_SortDirection = 'DESC';

    -- Total count
    SELECT @o_RecordCount = COUNT(*)
    FROM ${source}
    WHERE ${countWhere}
    AND (is_active = 1 OR @p_IncludeInactive = 1);

    -- Paged results
    DECLARE @SQL NVARCHAR(MAX);

    SET @SQL = N'
    SELECT
${selectList}
    FROM ${source}
    WHERE ${dynWhere}
    AND (is_active = 1 OR @IncludeInactive = 1)
    ORDER BY ' + QUOTENAME(@p_SortBy) + ' ' + @p_SortDirection + '
    OFFSET (@PageNumber - 1) * @PageSize ROWS
    FETCH NEXT @PageSize ROWS ONLY;';

    EXEC sp_executesql @SQL,
        N'${execParamDecls.join(', ')}',
        ${execParamVals.join(',\n        ')};

    SET NOCOUNT OFF;
END;
GO
`;
}

// ============================================================
// Build SP definitions from JSON data
// ============================================================

const spDefs = [];

// Resolve columns for an SP definition from JSON
function resolveColumns(def) {
  if (def.columnsFrom) {
    return viewColumns[def.columnsFrom];
  }
  if (def.columnsFromTable) {
    const tDef = getTableDef(def.columnsFromTable);
    return tDef ? getAllColumns(tDef) : null;
  }
  return def.columns;
}

// Load SP definitions from JSON
for (const def of spByData.spDefs) {
  const columns = resolveColumns(def);
  if (!columns) continue; // skip if table not found

  if (def.filterCol) {
    // Simple listBy-style definition
    const paramName = `@p_${toPascalCase(def.filterCol)}`;
    spDefs.push({
      spName: def.spName,
      source: def.source,
      columns,
      purpose: def.purpose,
      filterParams: [{ name: paramName, type: def.filterType, desc: `Filter by ${def.filterCol}` }],
      filterWhere: `${def.filterCol} = ${paramName}`,
    });
  } else {
    // Custom definition with explicit filterParams/filterWhere
    spDefs.push({
      spName: def.spName,
      source: def.source,
      columns,
      purpose: def.purpose,
      filterParams: def.filterParams || [],
      extraParams: def.extraParams,
      filterWhere: def.filterWhere,
    });
  }
}

// Note/Document _by_ parent SPs (dynamic — depends on table existence)
for (const parent of spByData.noteParents) {
  const tableName = `note_${parent}`;
  const tDef = getTableDef(tableName);
  if (!tDef) continue;
  const paramName = `@p_${toPascalCase(`${parent}_id`)}`;
  spDefs.push({
    spName: `sx_list_note_${parent}_by_${parent}`,
    source: tableName,
    columns: getAllColumns(tDef),
    purpose: `Retrieves ${tableName} records filtered by ${parent}`,
    filterParams: [{ name: paramName, type: 'UNIQUEIDENTIFIER', desc: `Filter by ${parent}_id` }],
    filterWhere: `${parent}_id = ${paramName}`,
  });
}

for (const parent of spByData.documentParents) {
  const tableName = `document_${parent}`;
  const tDef = getTableDef(tableName);
  if (!tDef) continue;
  const paramName = `@p_${toPascalCase(`${parent}_id`)}`;
  spDefs.push({
    spName: `sx_list_document_${parent}_by_${parent}`,
    source: tableName,
    columns: getAllColumns(tDef),
    purpose: `Retrieves ${tableName} records filtered by ${parent}`,
    filterParams: [{ name: paramName, type: 'UNIQUEIDENTIFIER', desc: `Filter by ${parent}_id` }],
    filterWhere: `${parent}_id = ${paramName}`,
  });
}

// ============================================================
// Write files
// ============================================================

let count = 0;

// _by_ list SPs
for (const def of spDefs) {
  const sql = generateListBy(def);
  fs.writeFileSync(path.join(SP_DIR, `${def.spName}.sql`), sql, 'utf8');
  count++;
}

console.log(`Generated ${count} stored procedure files in ${SP_DIR}`);
