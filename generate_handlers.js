const fs = require('fs');
const path = require('path');

const tables = require('../SQL/generate_tables');

const HANDLERS_DIR = path.join(__dirname, 'handlers');

if (!fs.existsSync(HANDLERS_DIR)) {
  fs.mkdirSync(HANDLERS_DIR, { recursive: true });
}

// ============================================================
// Helpers (mirrors generate_stored_procedures.js naming)
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

function pkParamName(table) {
  return `p_${toPascalCase(table.name)}RecordId`;
}

function colParamName(col) {
  return `p_${toPascalCase(col.name)}`;
}

// ============================================================
// Generate handler JS for one table
// ============================================================

function generateHandler(table) {
  const name = table.name;
  const displayName = name.replace(/_/g, ' ');
  const pk = pkParamName(table);
  const cols = table.columns;

  // Build FIELDS bitmask map
  const fieldLines = [];
  cols.forEach((col, i) => {
    const camel = toCamelCase(col.name);
    const bit = 1 << i;
    const pad = ' '.repeat(Math.max(1, 30 - camel.length));
    fieldLines.push(`    ${camel}:${pad}${bit},${' '.repeat(Math.max(1, 10 - String(bit).length))}// Bit ${i}: 2^${i} = ${bit}`);
  });

  // Build destructure list for upsert
  const destructureList = cols.map(c => `        ${toCamelCase(c.name)}`).join(',\n');

  // Build SP input params for upsert
  const upsertParams = [];
  upsertParams.push(`            ${pk}: id || null`);
  for (const col of cols) {
    const camel = toCamelCase(col.name);
    const spParam = colParamName(col);
    // For booleans and numbers, use !== undefined check to allow falsy values
    if (col.type === 'bit' || col.type.startsWith('int') || col.type.startsWith('smallint') ||
        col.type.startsWith('decimal') || col.type.startsWith('money') || col.type === 'tinyint') {
      upsertParams.push(`            ${spParam}: ${camel} !== undefined ? ${camel} : null`);
    } else {
      upsertParams.push(`            ${spParam}: ${camel} || null`);
    }
  }
  upsertParams.push(`            p_UpdateFields: updateFields || 0`);

  const lines = [];

  lines.push(`const { executeStoredProc, executeStoredProcWithOutput, sql } = require('../utils/db-connection');`);
  lines.push(`const { successResponse, errorResponse, notFoundResponse } = require('../utils/response-formatter');`);
  lines.push(`const { calculateBitmask } = require('../utils/bitmask-utils');`);
  lines.push(``);
  lines.push(`const FIELDS = {`);
  lines.push(fieldLines.join('\n'));
  lines.push(`};`);
  lines.push(``);

  // --- get ---
  lines.push(`async function get(id, queryParams = {}) {`);
  lines.push(`    if (!id) return errorResponse('${displayName} ID is required', 400);`);
  lines.push(``);
  lines.push(`    try {`);
  lines.push(`        const results = await executeStoredProc('sx_get_${name}', {`);
  lines.push(`            ${pk}: id`);
  lines.push(`        });`);
  lines.push(``);
  lines.push(`        if (!results || results.length === 0) return notFoundResponse('${displayName}');`);
  lines.push(`        return successResponse(results[0]);`);
  lines.push(`    } catch (error) {`);
  lines.push(`        console.error('Error getting ${name}:', error);`);
  lines.push(`        return errorResponse('Failed to get ${displayName}', 500, error.message);`);
  lines.push(`    }`);
  lines.push(`}`);
  lines.push(``);

  // --- list ---
  lines.push(`async function list(queryParams = {}) {`);
  lines.push(`    try {`);
  lines.push(`        const { output, recordset } = await executeStoredProcWithOutput(`);
  lines.push(`            'sx_list_${name}',`);
  lines.push(`            {`);
  lines.push(`                p_PageNumber: parseInt(queryParams.page) || 1,`);
  lines.push(`                p_PageSize: parseInt(queryParams.pageSize) || 50,`);
  lines.push(`                p_SortBy: queryParams.sortBy || 'created',`);
  lines.push(`                p_SortDirection: queryParams.sortDirection || 'DESC'`);
  lines.push(`            },`);
  lines.push(`            { o_RecordCount: sql.Int }`);
  lines.push(`        );`);
  lines.push(``);
  lines.push(`        return successResponse({`);
  lines.push(`            records: recordset,`);
  lines.push(`            totalCount: output.o_RecordCount,`);
  lines.push(`            page: parseInt(queryParams.page) || 1,`);
  lines.push(`            pageSize: parseInt(queryParams.pageSize) || 50`);
  lines.push(`        });`);
  lines.push(`    } catch (error) {`);
  lines.push(`        console.error('Error listing ${name}:', error);`);
  lines.push(`        return errorResponse('Failed to list ${displayName}', 500, error.message);`);
  lines.push(`    }`);
  lines.push(`}`);
  lines.push(``);

  // --- upsert ---
  lines.push(`async function upsert(id, body) {`);
  lines.push(`    const {`);
  lines.push(destructureList);
  lines.push(`    } = body;`);
  lines.push(``);
  lines.push(`    let updateFields = body.updateFields;`);
  lines.push(`    if (updateFields === undefined && id) {`);
  lines.push(`        updateFields = calculateBitmask(body, FIELDS);`);
  lines.push(`    }`);
  lines.push(``);
  lines.push(`    try {`);
  lines.push(`        const { output } = await executeStoredProcWithOutput(`);
  lines.push(`            'sx_upsert_${name}',`);
  lines.push(`            {`);
  lines.push(upsertParams.join(',\n'));
  lines.push(`            },`);
  lines.push(`            {`);
  lines.push(`                o_IsSuccess: sql.Bit,`);
  lines.push(`                o_ErrorMessage: sql.NVarChar(255),`);
  lines.push(`                o_NewRecordId: sql.UniqueIdentifier`);
  lines.push(`            }`);
  lines.push(`        );`);
  lines.push(``);
  lines.push(`        if (!output.o_IsSuccess) {`);
  lines.push(`            return errorResponse(output.o_ErrorMessage || 'Failed to save ${displayName}', 400);`);
  lines.push(`        }`);
  lines.push(``);
  lines.push(`        const statusCode = id ? 200 : 201;`);
  lines.push(`        return successResponse({ id: output.o_NewRecordId }, statusCode);`);
  lines.push(`    } catch (error) {`);
  lines.push(`        console.error('Error upserting ${name}:', error);`);
  lines.push(`        return errorResponse('Failed to save ${displayName}', 500, error.message);`);
  lines.push(`    }`);
  lines.push(`}`);
  lines.push(``);

  // --- exports ---
  lines.push(`module.exports = { get, list, upsert, FIELDS };`);
  lines.push(``);

  return lines.join('\n');
}

// ============================================================
// Write files
// ============================================================

let count = 0;
for (const table of tables) {
  const kebab = toKebabCase(table.name);
  const handler = generateHandler(table);
  fs.writeFileSync(path.join(HANDLERS_DIR, `${kebab}.js`), handler, 'utf8');
  count++;
}

console.log(`Generated ${count} handler files in ${HANDLERS_DIR}`);
