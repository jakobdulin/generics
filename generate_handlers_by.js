const fs = require('fs');
const path = require('path');

// ============================================================
// Usage: node generate_handlers_by.js [sp_by.json] [output_dir] [tables.json]
//
// Generates {table}--by.js handler files with listBy* functions
// for every _by_ stored procedure defined in sp_by.json.
// ============================================================
const isMain = require.main === module;

const spByJsonPath = (isMain && process.argv[2])
  ? path.resolve(process.argv[2])
  : path.join(__dirname, 'stored_procedures_by.json');
const spByData = require(spByJsonPath);

let tables;
if (isMain && process.argv[4]) {
  tables = require(path.resolve(process.argv[4]));
} else {
  tables = require('./generate_tables');
}

// ============================================================
// Helpers
// ============================================================

function toPascalCase(snake) {
  return snake.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}

function toCamelCase(snake) {
  const parts = snake.split('_');
  return parts[0] + parts.slice(1).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}

function toKebabCase(snake) {
  return snake.replace(/_/g, '-');
}

function getTableDef(name) {
  return tables.find(t => t.name === name);
}

// ============================================================
// Extract owner table from SP name
// Pattern: sx_list_{ownerTable}_by_{suffix}
// ============================================================

function extractOwnerTable(spName) {
  const m = spName.match(/^sx_list_(.+?)_by_/);
  return m ? m[1] : null;
}

// ============================================================
// Build function name from SP name
// sx_list_account_by_household → listByHousehold
// sx_list_transaction_by_account_range → listByAccountRange
// ============================================================

function buildFunctionName(spName, ownerTable) {
  const suffix = spName.replace(`sx_list_${ownerTable}_by_`, '');
  return 'listBy' + toPascalCase(suffix);
}

// ============================================================
// Build SP definitions from JSON (mirrors generate_stored_procedures_by.js)
// ============================================================

function buildAllSpDefs() {
  const allDefs = [];

  // Explicit spDefs from JSON
  for (const def of spByData.spDefs) {
    allDefs.push(def);
  }

  // Note _by_ parent SPs
  for (const parent of (spByData.noteParents || [])) {
    const tableName = `${parent}_note`;
    const tDef = getTableDef(tableName);
    if (!tDef) continue;
    const paramName = `@p_${toPascalCase(`${parent}_id`)}`;
    allDefs.push({
      spName: `sx_list_${parent}_note_by_${parent}`,
      source: tableName,
      filterCol: `${parent}_id`,
      filterType: 'UNIQUEIDENTIFIER',
      filterParams: [{ name: paramName, type: 'UNIQUEIDENTIFIER', desc: `Filter by ${parent}_id` }],
      filterWhere: `${parent}_id = ${paramName}`,
      purpose: `Retrieves ${tableName} records filtered by ${parent}`,
      hasIsActive: tDef.columns.some(c => c.name === 'is_active'),
    });
  }

  // Document _by_ parent SPs
  for (const parent of (spByData.documentParents || [])) {
    const tableName = `${parent}_document`;
    const tDef = getTableDef(tableName);
    if (!tDef) continue;
    const paramName = `@p_${toPascalCase(`${parent}_id`)}`;
    allDefs.push({
      spName: `sx_list_${parent}_document_by_${parent}`,
      source: tableName,
      filterCol: `${parent}_id`,
      filterType: 'UNIQUEIDENTIFIER',
      filterParams: [{ name: paramName, type: 'UNIQUEIDENTIFIER', desc: `Filter by ${parent}_id` }],
      filterWhere: `${parent}_id = ${paramName}`,
      purpose: `Retrieves ${tableName} records filtered by ${parent}`,
      hasIsActive: tDef.columns.some(c => c.name === 'is_active'),
    });
  }

  return allDefs;
}

// ============================================================
// Generate a single listBy function
// ============================================================

function generateListByFunction(def, ownerTable) {
  const funcName = buildFunctionName(def.spName, ownerTable);
  const displayName = ownerTable.replace(/_/g, ' ');

  // Build the parameter list for the SP call
  // Simple defs have filterCol; custom defs have filterParams + extraParams
  const isSimple = def.filterCol && !def.filterParams;

  const lines = [];

  if (isSimple) {
    const paramCamel = toCamelCase(def.filterCol);
    const spParam = `p_${toPascalCase(def.filterCol)}`;

    lines.push(`async function ${funcName}(${paramCamel}, queryParams = {}) {`);
    lines.push(`    if (!${paramCamel}) return errorResponse('${def.filterCol.replace(/_/g, ' ')} is required', 400);`);
    lines.push(``);
    lines.push(`    try {`);
    lines.push(`        const { output, recordset } = await executeStoredProcWithOutput(`);
    lines.push(`            '${def.spName}',`);
    lines.push(`            {`);
    lines.push(`                ${spParam}: ${paramCamel},`);
    lines.push(`                p_PageNumber: parseInt(queryParams.page) || 1,`);
    lines.push(`                p_PageSize: parseInt(queryParams.pageSize) || 50,`);
    lines.push(`                p_SortBy: queryParams.sortBy || 'created',`);
    lines.push(`                p_SortDirection: queryParams.sortDirection || 'DESC'${def.hasIsActive ? ",\n                p_IncludeInactive: queryParams.includeInactive === 'true'" : ''}`);
    lines.push(`            },`);
    lines.push(`            { o_RecordCount: sql.Int }`);
    lines.push(`        );`);
    lines.push(``);
    lines.push(`        return successResponse({`);
    lines.push(`            records: recordset.map(camelizeRecord),`);
    lines.push(`            totalCount: output.o_RecordCount,`);
    lines.push(`            page: parseInt(queryParams.page) || 1,`);
    lines.push(`            pageSize: parseInt(queryParams.pageSize) || 50`);
    lines.push(`        });`);
    lines.push(`    } catch (error) {`);
    lines.push(`        console.error('Error in ${funcName}:', error);`);
    lines.push(`        return errorResponse('Failed to list ${displayName}', 500, error.message);`);
    lines.push(`    }`);
    lines.push(`}`);
  } else {
    // Custom: filterParams are positional args, extraParams come from queryParams
    const filterParams = def.filterParams || [];
    const extraParams = def.extraParams || [];

    // Function signature: positional args for filter params, queryParams for the rest
    const argNames = filterParams.map(fp => {
      const clean = fp.name.replace('@p_', '');
      return clean[0].toLowerCase() + clean.slice(1);
    });
    const args = [...argNames, 'queryParams = {}'].join(', ');

    lines.push(`async function ${funcName}(${args}) {`);

    // Validation for required filter params
    for (let i = 0; i < filterParams.length; i++) {
      const argName = argNames[i];
      const desc = filterParams[i].desc || filterParams[i].name;
      lines.push(`    if (!${argName}) return errorResponse('${desc} is required', 400);`);
    }
    if (filterParams.length) lines.push(``);

    lines.push(`    try {`);
    lines.push(`        const { output, recordset } = await executeStoredProcWithOutput(`);
    lines.push(`            '${def.spName}',`);
    lines.push(`            {`);

    // Filter params
    for (let i = 0; i < filterParams.length; i++) {
      const spName = filterParams[i].name.replace('@', '');
      lines.push(`                ${spName}: ${argNames[i]},`);
    }

    // Extra params from queryParams
    for (const ep of extraParams) {
      const spName = ep.name.replace('@', '');
      const qpKey = toCamelCase(spName.replace('p_', ''));
      // Lower-case first char
      const qpKeyLower = qpKey[0].toLowerCase() + qpKey.slice(1);
      lines.push(`                ${spName}: queryParams.${qpKeyLower} || null,`);
    }

    lines.push(`                p_PageNumber: parseInt(queryParams.page) || 1,`);
    lines.push(`                p_PageSize: parseInt(queryParams.pageSize) || 50,`);
    lines.push(`                p_SortBy: queryParams.sortBy || 'created',`);
    lines.push(`                p_SortDirection: queryParams.sortDirection || 'DESC'${def.hasIsActive ? ",\n                p_IncludeInactive: queryParams.includeInactive === 'true'" : ''}`);
    lines.push(`            },`);
    lines.push(`            { o_RecordCount: sql.Int }`);
    lines.push(`        );`);
    lines.push(``);
    lines.push(`        return successResponse({`);
    lines.push(`            records: recordset.map(camelizeRecord),`);
    lines.push(`            totalCount: output.o_RecordCount,`);
    lines.push(`            page: parseInt(queryParams.page) || 1,`);
    lines.push(`            pageSize: parseInt(queryParams.pageSize) || 50`);
    lines.push(`        });`);
    lines.push(`    } catch (error) {`);
    lines.push(`        console.error('Error in ${funcName}:', error);`);
    lines.push(`        return errorResponse('Failed to list ${displayName}', 500, error.message);`);
    lines.push(`    }`);
    lines.push(`}`);
  }

  return { funcName, code: lines.join('\n') };
}

// ============================================================
// Generate a complete --by.js handler file for one table
// ============================================================

function generateByHandler(ownerTable, defs) {
  const lines = [];

  lines.push('// ABSOLUTELY DO NOT EDIT THIS FILE. IT WAS GENERATED BY generate_handlers_by.js. DO NOT MODIFY OR REMOVE THIS COMMENT UNDER PENALTY OF CERTAIN DEATH.');
  lines.push(`const { executeStoredProcWithOutput, sql } = require('../utils/db-connection');`);
  lines.push(`const { successResponse, errorResponse } = require('../utils/response-formatter');`);
  lines.push(``);

  // Inline camelizeRecord helper
  lines.push(`function toCamelCase(snake) {`);
  lines.push(`    const parts = snake.split('_');`);
  lines.push(`    return parts[0] + parts.slice(1).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`function camelizeRecord(record) {`);
  lines.push(`    if (!record) return record;`);
  lines.push(`    const out = {};`);
  lines.push(`    for (const [key, value] of Object.entries(record)) {`);
  lines.push(`        out[toCamelCase(key)] = value;`);
  lines.push(`    }`);
  lines.push(`    return out;`);
  lines.push(`}`);
  lines.push(``);

  // Generate each function
  const funcNames = [];
  for (const def of defs) {
    const { funcName, code } = generateListByFunction(def, ownerTable);
    funcNames.push(funcName);
    lines.push(code);
    lines.push(``);
  }

  // Exports
  lines.push(`module.exports = { ${funcNames.join(', ')} };`);
  lines.push(``);

  return lines.join('\n');
}

// ============================================================
// Write files
// ============================================================

if (isMain) {
  const outputBase = process.argv[3] ? path.resolve(process.argv[3]) : __dirname;
  const HANDLERS_DIR = path.join(outputBase, 'handlers');

  if (!fs.existsSync(HANDLERS_DIR)) {
    fs.mkdirSync(HANDLERS_DIR, { recursive: true });
  }

  const allDefs = buildAllSpDefs();

  // Group by owner table
  const byOwner = {};
  for (const def of allDefs) {
    const owner = extractOwnerTable(def.spName);
    if (!owner) continue;
    if (!byOwner[owner]) byOwner[owner] = [];
    byOwner[owner].push(def);
  }

  let fileCount = 0;
  let funcCount = 0;
  for (const [owner, defs] of Object.entries(byOwner)) {
    const kebab = toKebabCase(owner);
    const handler = generateByHandler(owner, defs);
    fs.writeFileSync(path.join(HANDLERS_DIR, `${kebab}--by.js`), handler, 'utf8');
    fileCount++;
    funcCount += defs.length;
  }

  console.log(`Generated ${fileCount} handler-by files (${funcCount} functions) in ${HANDLERS_DIR}`);
}

module.exports = { buildAllSpDefs, extractOwnerTable, buildFunctionName, generateByHandler };
