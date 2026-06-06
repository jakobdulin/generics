const fs = require('fs');
const path = require('path');

// ============================================================
// Usage: node generate_tests.js [tables.json path] [output directory]
//
// Generates one JS test file per table following the 15-step
// API_TEST_GUIDE.md procedure, plus a shared test-utils.js and
// a run-all.js orchestrator.
// ============================================================
const isMain = require.main === module;

const jsonPath = (isMain && process.argv[2])
  ? path.resolve(process.argv[2])
  : path.join(__dirname, 'tables.json');
const tables = require(jsonPath);

// Build a lookup map: tableName -> table definition
const tableMap = {};
for (const t of tables) tableMap[t.name] = t;

// ============================================================
// Helpers
// ============================================================

function toCamelCase(snake) {
  const parts = snake.split('_');
  return parts[0] + parts.slice(1).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}

function toKebabCase(snake) {
  return snake.replace(/_/g, '-');
}

function resourceName(tableName) {
  return tableName.split('_').slice(1).join('-');
}

function pkCamel(tableName) {
  return toCamelCase(`${tableName}_id`);
}

function hasIsActive(table) {
  return table.columns.some(c => c.name === 'is_active');
}

/**
 * Extract max length from a type like varchar(20), nvarchar(100), char(2).
 * Returns null if no length constraint found.
 */
function getMaxLength(colType) {
  const m = colType.match(/\((\d+)\)/);
  return m ? parseInt(m[1]) : null;
}

/**
 * Generate a synthetic test value for a column based on its type.
 * String values use ${TS} marker which gets emitted as template literal referencing t.TS.
 */
function testValue(col, suffix = '') {
  const ct = col.type.toLowerCase();
  if (col.name === 'is_active') return null;
  if (ct === 'uniqueidentifier') return null;
  if (ct === 'bit') return suffix ? false : true;
  if (ct.startsWith('date') && !ct.startsWith('datetime')) return suffix ? '2025-06-20' : '2025-01-15';
  if (ct.startsWith('datetime')) return suffix ? '2025-06-20T18:30:00Z' : '2025-01-15T12:00:00Z';
  if (ct === 'money' || ct.startsWith('decimal') || ct.startsWith('numeric')) return suffix ? 200.75 : 100.50;
  if (ct.startsWith('int') || ct === 'smallint' || ct === 'tinyint' || ct === 'bigint') return suffix ? 99 : 42;
  // String value — mark with ${TS} for uniqueness, respecting max length
  const maxLen = getMaxLength(ct);
  return { str: true, label: suffix || 'create', maxLen };
}

/**
 * Build the template string for a string test value, respecting maxLen.
 * Full format: `t-${t.TS}-label`  (~20 chars with 8-char TS)
 * If maxLen is tight, shorten progressively:
 *   >= 15: `t-${t.TS}-label`  (full, truncate label if needed)
 *   >= 10: `${t.TS}-L`        (TS + 1-char label code)
 *   <  10: `tL`               (static, no TS — can't fit uniqueness)
 */
function strTemplate(val) {
  const label = val.label;
  const maxLen = val.maxLen;
  if (!maxLen || maxLen >= 15) {
    // Full format — truncate label to fit
    const overhead = 3 + 8; // "t-" + TS(~8) + "-"
    const availLabel = maxLen ? Math.max(1, maxLen - overhead) : label.length;
    const truncLabel = label.slice(0, availLabel);
    return `t-\${t.TS}-${truncLabel}`;
  }
  if (maxLen >= 10) {
    const code = label[0].toUpperCase();
    return `\${t.TS}-${code}`;
  }
  // Very short — use a static short label (no uniqueness guarantee)
  const code = label[0].toUpperCase();
  return `t${code}`;
}

function jsLiteral(val) {
  if (val === null || val === undefined) return 'null';
  if (typeof val === 'boolean') return String(val);
  if (typeof val === 'number') return String(val);
  if (typeof val === 'object' && val.str) return '`' + strTemplate(val) + '`';
  return `'${val}'`;
}

/** Is this value a string test value (for assertions)? */
function isStrVal(val) {
  return typeof val === 'object' && val !== null && val.str;
}

/** Emit the expected assertion value as a template literal */
function expectedLiteral(val) {
  return '`' + strTemplate(val) + '`';
}

/**
 * Build the ordered list of ancestor tables that must be created before this table.
 * Returns an array of ancestor info objects in creation order.
 * Walks FK chains recursively, deduplicating.
 */
function getAncestors(table, visited = new Set()) {
  const ancestors = [];
  for (const fk of (table.fks || [])) {
    const parentName = fk.refTable;
    if (visited.has(parentName)) continue;
    visited.add(parentName);
    const parentTable = tableMap[parentName];
    if (!parentTable) continue;

    // Recurse to get grandparents first
    ancestors.push(...getAncestors(parentTable, visited));

    // Build create body entries — static values for regular cols, variable refs for FK cols
    const bodyEntries = []; // { key, value, isVar }
    for (const col of parentTable.columns) {
      if (col.name === 'is_active') continue;
      const camel = toCamelCase(col.name);
      if (col.type === 'uniqueidentifier') {
        // FK col — reference the ancestor variable
        const parentFk = (parentTable.fks || []).find(f => f.col === col.name);
        if (parentFk) {
          const varName = toCamelCase(parentFk.refTable) + 'Id';
          bodyEntries.push({ key: camel, value: varName, isVar: true });
        }
      } else {
        const val = testValue(col, '');
        if (val !== null) bodyEntries.push({ key: camel, value: jsLiteral(val), isVar: false });
      }
    }

    ancestors.push({
      tableName: parentName,
      fkCamel: toCamelCase(fk.col),
      pkCamel: pkCamel(parentName),
      apiPath: `/api/${resourceName(parentName)}`,
      bodyEntries,
      hasHistory: parentTable.hasHistory
    });
  }
  return ancestors;
}

/**
 * Emit JS code for an ancestor's createRecord call with inline body object.
 */
function emitAncestorSetup(anc) {
  const varName = toCamelCase(anc.tableName) + 'Id';
  const bodyParts = anc.bodyEntries.map(e =>
    e.isVar ? `${e.key}: ${e.value}` : `${e.key}: ${e.value}`
  ).join(', ');
  const lines = [];
  lines.push(`    const ${varName} = await t.createRecord('${anc.apiPath}', { ${bodyParts} }, '${anc.pkCamel}');`);
  lines.push(`    console.log('  Created ${anc.tableName}:', ${varName});`);
  lines.push(`    if (!${varName}) { console.log('  ABORT: could not create ${anc.tableName}'); process.exit(1); }`);
  return lines;
}

// ============================================================
// Generate test-utils.js
// ============================================================

function generateTestUtils() {
  return `// Generated by generate_tests.js — shared test utilities
// Usage: const t = require('./test-utils')(baseUrl);

const { execSync } = require('child_process');

module.exports = function (baseUrl) {
    if (!baseUrl) {
        console.error('ERROR: base URL required as first argument');
        process.exit(1);
    }

    const AUTH = 'Bearer Development';
    let passCount = 0;
    let failCount = 0;

    // Unique suffix for this test run to avoid duplicate key collisions
    const TS = Date.now().toString(36);

    // -- colors --
    const R = '\\x1b[31m', G = '\\x1b[32m', Y = '\\x1b[33m', C = '\\x1b[36m', N = '\\x1b[0m';

    // -- HTTP helpers --
    async function api(method, path, body, qs) {
        let url = baseUrl + path;
        if (qs) url += '?' + new URLSearchParams(qs).toString();
        const opts = {
            method,
            headers: { 'Authorization': AUTH, 'Content-Type': 'application/json' }
        };
        if (body && (method === 'POST' || method === 'PUT')) {
            opts.body = JSON.stringify(body);
        }
        const res = await fetch(url, opts);
        const text = await res.text();
        let json;
        try { json = JSON.parse(text); } catch { json = null; }
        return { status: res.status, body: json, raw: text };
    }

    async function apiGet(path, qs)         { return api('GET', path, null, qs); }
    async function apiPost(path, body)      { return api('POST', path, body); }
    async function apiPut(path, body)       { return api('PUT', path, body); }
    async function apiDelete(path)          { return api('DELETE', path); }
    async function apiRaw(method, url)      {
        const res = await fetch(url, { method });
        return { status: res.status };
    }

    /**
     * Create a record via POST and return its ID.
     * pkField is the camelCase PK field name in the response.
     */
    async function createRecord(apiPath, body, pkField) {
        const res = await apiPost(apiPath, body);
        if (res.status !== 201 || !res.body?.success) {
            console.log(\`  \${R}SETUP FAIL\${N} POST \${apiPath}: \${res.raw}\`);
            return null;
        }
        return res.body.data[pkField] || null;
    }

    // -- sqlcmd --
    function sqlcmd(query) {
        const server = process.env.DB_SERVER;
        const db     = process.env.DB_NAME;
        const user   = process.env.DB_USER || 'admin';
        const pass   = process.env.DB_PASS;
        if (!server || !db || !pass) {
            console.log(\`  \${Y}SKIP\${N} sqlcmd not configured (set DB_SERVER, DB_NAME, DB_PASS)\`);
            return false;
        }
        try {
            const cmd = process.env.SQLCMD || 'sqlcmd';
            execSync(\`\${cmd} -S "\${server}" -C -d "\${db}" -U "\${user}" -P "\${pass}" -Q "\${query}"\`, { stdio: 'pipe' });
            return true;
        } catch {
            return false;
        }
    }

    // -- assertions --
    function assertStatus(res, expected, label) {
        if (res.status === expected) {
            console.log(\`  \${G}PASS\${N} [\${label}] HTTP \${res.status}\`);
            passCount++;
        } else {
            console.log(\`  \${R}FAIL\${N} [\${label}] HTTP \${res.status} (expected \${expected})\`);
            console.log(\`       \${res.raw || JSON.stringify(res.body)}\`);
            failCount++;
        }
    }

    function assertSuccess(res, label) {
        if (res.body && res.body.success === true) {
            console.log(\`  \${G}PASS\${N} [\${label}] success=true\`);
            passCount++;
        } else {
            console.log(\`  \${R}FAIL\${N} [\${label}] success=\${res.body?.success}\`);
            console.log(\`       \${res.raw || JSON.stringify(res.body)}\`);
            failCount++;
        }
    }

    function assertField(res, field, expected, label) {
        const actual = res.body?.data?.[field];
        if (String(actual) === String(expected)) {
            console.log(\`  \${G}PASS\${N} [\${label}] \${field} == "\${expected}"\`);
            passCount++;
        } else {
            console.log(\`  \${R}FAIL\${N} [\${label}] \${field} == "\${actual}" (expected "\${expected}")\`);
            failCount++;
        }
    }

    function assertFieldNot(res, field, notExpected, label) {
        const actual = res.body?.data?.[field];
        if (String(actual) !== String(notExpected)) {
            console.log(\`  \${G}PASS\${N} [\${label}] \${field} != "\${notExpected}"\`);
            passCount++;
        } else {
            console.log(\`  \${R}FAIL\${N} [\${label}] \${field} == "\${actual}" (should differ)\`);
            failCount++;
        }
    }

    function assertNotEmpty(res, field, label) {
        const actual = res.body?.data?.[field];
        if (actual !== null && actual !== undefined && actual !== '') {
            console.log(\`  \${G}PASS\${N} [\${label}] \${field} is set\`);
            passCount++;
        } else {
            console.log(\`  \${R}FAIL\${N} [\${label}] \${field} is empty\`);
            failCount++;
        }
    }

    function assertError(res, label) {
        if (res.body && res.body.success === false) {
            console.log(\`  \${G}PASS\${N} [\${label}] success=false\`);
            passCount++;
        } else {
            console.log(\`  \${R}FAIL\${N} [\${label}] success=\${res.body?.success} (expected false)\`);
            failCount++;
        }
    }

    function extractId(res, pkField) {
        return res.body?.data?.[pkField] || null;
    }

    // -- display --
    function section(title) { console.log(\`\\n\${C}=== \${title} ===\${N}\`); }
    function step(num, desc) { console.log(\`\${Y}--- Step \${num}: \${desc} ---\${N}\`); }

    // -- cleanup --
    function hardDeleteCleanup(table, pkCol, recordId) {
        section('Hard Delete Cleanup');
        const trigger = \`tr_\${table}_delete\`;
        step('12', 'Disable delete trigger');
        sqlcmd(\`ALTER TABLE [\${table}] DISABLE TRIGGER [\${trigger}];\`);
        step('13', 'Hard delete record');
        sqlcmd(\`DELETE FROM [\${table}] WHERE [\${pkCol}] = '\${recordId}';\`);
        sqlcmd(\`DELETE FROM [history].[\${table}] WHERE [\${pkCol}] = '\${recordId}';\`);
        step('14', 'Re-enable delete trigger');
        sqlcmd(\`ALTER TABLE [\${table}] ENABLE TRIGGER [\${trigger}];\`);
    }

    function simpleHardDelete(table, pkCol, recordId) {
        section('Hard Delete Cleanup');
        const trigger = \`tr_\${table}_delete\`;
        step('12', 'Disable delete trigger');
        sqlcmd(\`ALTER TABLE [\${table}] DISABLE TRIGGER [\${trigger}];\`);
        step('13', 'Hard delete record');
        sqlcmd(\`DELETE FROM [\${table}] WHERE [\${pkCol}] = '\${recordId}';\`);
        step('14', 'Re-enable delete trigger');
        sqlcmd(\`ALTER TABLE [\${table}] ENABLE TRIGGER [\${trigger}];\`);
    }

    function printSummary() {
        console.log(\`\\n\${C}==============================\${N}\`);
        console.log(\`  \${G}PASSED: \${passCount}\${N}\`);
        console.log(\`  \${R}FAILED: \${failCount}\${N}\`);
        console.log(\`\${C}==============================\${N}\`);
        return failCount === 0;
    }

    return {
        TS,
        apiGet, apiPost, apiPut, apiDelete, apiRaw, createRecord,
        sqlcmd,
        assertStatus, assertSuccess, assertField, assertFieldNot, assertNotEmpty, assertError,
        extractId,
        section, step,
        hardDeleteCleanup, simpleHardDelete, printSummary
    };
};
`;
}

// ============================================================
// Generate test script for one table
// ============================================================

function generateTestScript(table) {
  const name = table.name;
  const resource = resourceName(name);
  const pk = pkCamel(name);
  const apiPath = `/api/${resource}`;
  const cols = table.columns;
  const hasSoftDelete = hasIsActive(table);
  const hasHistory = table.hasHistory;

  // FK ancestors that need setup
  const ancestors = getAncestors(table);

  // Updatable columns (skip is_active and FK UUIDs)
  const updatableCols = cols.filter(c =>
    c.name !== 'is_active' && c.type !== 'uniqueidentifier'
  );

  // Create body: all columns except is_active (FKs handled via ancestor IDs)
  const createCols = cols.filter(c => c.name !== 'is_active');

  // Bitmask map (uses column index, matches handler FIELDS)
  const fieldBitmask = {};
  cols.forEach((col, i) => { fieldBitmask[col.name] = 1 << i; });

  const fieldA = updatableCols[0];
  const fieldB = updatableCols.length > 1 ? updatableCols[1] : null;
  const fieldABit = fieldA ? fieldBitmask[fieldA.name] : 1;
  const multiBitmask = fieldB ? (fieldABit | fieldBitmask[fieldB.name]) : fieldABit;

  // camelCase versions for assertions
  const fieldACamel = fieldA ? toCamelCase(fieldA.name) : null;
  const fieldBCamel = fieldB ? toCamelCase(fieldB.name) : null;

  const lines = [];
  lines.push(`// Generated by generate_tests.js — full CRUD test for ${name}`);
  lines.push(`// Table: ${name} | API: ${apiPath}`);
  lines.push(`// hasHistory: ${hasHistory} | hasSoftDelete: ${hasSoftDelete}`);
  lines.push(`const t = require('./test-utils')(process.argv[2]);`);
  lines.push(``);
  lines.push(`const TABLE = '${name}';`);
  lines.push(`const PK    = '${pk}';`);
  lines.push(`const API   = '${apiPath}';`);
  lines.push(``);
  lines.push(`(async () => {`);
  lines.push(`    t.section('Testing: ${name}');`);
  lines.push(`    let id;`);
  lines.push(``);

  // ---- Setup: create ancestor records for FK dependencies ----
  if (ancestors.length > 0) {
    lines.push(`    // Setup: create ancestor records for FK dependencies`);
    lines.push(`    t.section('FK Setup');`);
    for (const anc of ancestors) {
      lines.push(...emitAncestorSetup(anc));
    }
    lines.push(``);
  }

  // ---- Step 1: POST ----
  lines.push(`    // Step 1: POST (Create)`);
  lines.push(`    t.step('1', 'POST - Create');`);
  lines.push(`    let res = await t.apiPost(API, {`);
  const createEntries = [];
  for (const col of createCols) {
    const camel = toCamelCase(col.name);
    if (col.type === 'uniqueidentifier') {
      // FK — use the ancestor variable
      const fk = (table.fks || []).find(f => f.col === col.name);
      if (fk) {
        const varName = toCamelCase(fk.refTable) + 'Id';
        createEntries.push(`        ${camel}: ${varName}`);
      }
    } else {
      const val = testValue(col, '');
      if (val !== null) {
        createEntries.push(`        ${camel}: ${jsLiteral(val)}`);
      }
    }
  }
  lines.push(createEntries.join(',\n'));
  lines.push(`    });`);
  lines.push(`    t.assertStatus(res, 201, 'create-status');`);
  lines.push(`    t.assertSuccess(res, 'create-success');`);
  lines.push(`    id = t.extractId(res, PK);`);
  lines.push(`    t.assertNotEmpty(res, PK, 'create-has-id');`);
  lines.push(`    console.log('  Record ID:', id);`);
  lines.push(``);

  // Helper: emit assertField for a string value using template literal
  function emitAssertField(field, val, label) {
    if (isStrVal(val)) {
      lines.push(`    t.assertField(res, '${field}', ${expectedLiteral(val)}, '${label}');`);
    }
  }

  // ---- Step 2: GET ----
  lines.push(`    // Step 2: GET`);
  lines.push(`    t.step('2', 'GET - Retrieve');`);
  lines.push(`    res = await t.apiGet(\`\${API}/\${id}\`);`);
  lines.push(`    t.assertStatus(res, 200, 'get-status');`);
  lines.push(`    t.assertSuccess(res, 'get-success');`);
  if (fieldACamel) emitAssertField(fieldACamel, testValue(fieldA, ''), `get-${fieldACamel}`);
  lines.push(``);

  // ---- Step 3: PUT (Auto bitmask) ----
  lines.push(`    // Step 3: PUT (Auto-calculated bitmask)`);
  lines.push(`    t.step('3', 'PUT - Auto bitmask update');`);
  lines.push(`    res = await t.apiPut(\`\${API}/\${id}\`, {`);
  const autoEntries = [];
  if (fieldA) autoEntries.push(`        ${fieldACamel}: ${jsLiteral(testValue(fieldA, 'auto'))}`);
  if (fieldB) autoEntries.push(`        ${fieldBCamel}: ${jsLiteral(testValue(fieldB, 'auto'))}`);
  lines.push(autoEntries.join(',\n'));
  lines.push(`    });`);
  lines.push(`    t.assertStatus(res, 200, 'auto-update-status');`);
  lines.push(`    t.assertSuccess(res, 'auto-update-success');`);
  lines.push(``);

  // ---- Step 4: GET (Verify auto) ----
  lines.push(`    // Step 4: GET (Verify auto-update)`);
  lines.push(`    t.step('4', 'GET - Verify auto update');`);
  lines.push(`    res = await t.apiGet(\`\${API}/\${id}\`);`);
  lines.push(`    t.assertStatus(res, 200, 'verify-auto-status');`);
  if (fieldACamel) emitAssertField(fieldACamel, testValue(fieldA, 'auto'), `verify-auto-${fieldACamel}`);
  lines.push(``);

  // ---- Step 5: PUT (Selective bitmask) ----
  lines.push(`    // Step 5: PUT (Explicit bitmask - only ${fieldACamel}, bit=${fieldABit})`);
  lines.push(`    t.step('5', 'PUT - Selective bitmask (updateFields=${fieldABit})');`);
  lines.push(`    res = await t.apiPut(\`\${API}/\${id}\`, {`);
  const selectiveEntries = [];
  if (fieldA) selectiveEntries.push(`        ${fieldACamel}: ${jsLiteral(testValue(fieldA, 'sel'))}`);
  if (fieldB) selectiveEntries.push(`        ${fieldBCamel}: ${jsLiteral(testValue(fieldB, 'sel'))}`);
  selectiveEntries.push(`        updateFields: ${fieldABit}`);
  lines.push(selectiveEntries.join(',\n'));
  lines.push(`    });`);
  lines.push(`    t.assertStatus(res, 200, 'selective-status');`);
  lines.push(`    t.assertSuccess(res, 'selective-success');`);
  lines.push(``);

  // ---- Step 6: GET (Verify selective) ----
  lines.push(`    // Step 6: GET (Verify selective update)`);
  lines.push(`    t.step('6', 'GET - Verify selective update');`);
  lines.push(`    res = await t.apiGet(\`\${API}/\${id}\`);`);
  lines.push(`    t.assertStatus(res, 200, 'verify-selective-status');`);
  if (fieldACamel) emitAssertField(fieldACamel, testValue(fieldA, 'sel'), `verify-selective-${fieldACamel}`);
  if (fieldBCamel) emitAssertField(fieldBCamel, testValue(fieldB, 'auto'), `verify-selective-${fieldBCamel}-unchanged`);
  lines.push(``);

  // ---- Step 7-8: Multi-field bitmask ----
  if (fieldB) {
    lines.push(`    // Step 7: PUT (Multiple field bitmask=${multiBitmask})`);
    lines.push(`    t.step('7', 'PUT - Multi-field bitmask (updateFields=${multiBitmask})');`);
    lines.push(`    res = await t.apiPut(\`\${API}/\${id}\`, {`);
    const multiEntries = [];
    multiEntries.push(`        ${fieldACamel}: ${jsLiteral(testValue(fieldA, 'multi'))}`);
    multiEntries.push(`        ${fieldBCamel}: ${jsLiteral(testValue(fieldB, 'multi'))}`);
    multiEntries.push(`        updateFields: ${multiBitmask}`);
    lines.push(multiEntries.join(',\n'));
    lines.push(`    });`);
    lines.push(`    t.assertStatus(res, 200, 'multi-update-status');`);
    lines.push(`    t.assertSuccess(res, 'multi-update-success');`);
    lines.push(``);

    lines.push(`    // Step 8: GET (Verify multi-field update)`);
    lines.push(`    t.step('8', 'GET - Verify multi-field update');`);
    lines.push(`    res = await t.apiGet(\`\${API}/\${id}\`);`);
    lines.push(`    t.assertStatus(res, 200, 'verify-multi-status');`);
    if (fieldACamel) emitAssertField(fieldACamel, testValue(fieldA, 'multi'), `verify-multi-${fieldACamel}`);
    if (fieldBCamel) emitAssertField(fieldBCamel, testValue(fieldB, 'multi'), `verify-multi-${fieldBCamel}`);
    lines.push(``);
  }

  // ---- Steps 9-11: Soft delete ----
  if (hasSoftDelete) {
    lines.push(`    // Step 9: DELETE (Soft delete)`);
    lines.push(`    t.step('9', 'DELETE - Soft delete');`);
    lines.push(`    res = await t.apiDelete(\`\${API}/\${id}\`);`);
    lines.push(`    t.assertStatus(res, 200, 'soft-delete-status');`);
    lines.push(`    t.assertSuccess(res, 'soft-delete-success');`);
    lines.push(``);

    lines.push(`    // Step 10: GET (Verify soft delete - 404)`);
    lines.push(`    t.step('10', 'GET - Should be 404 after soft delete');`);
    lines.push(`    res = await t.apiGet(\`\${API}/\${id}\`);`);
    lines.push(`    t.assertStatus(res, 404, 'verify-soft-delete');`);
    lines.push(``);

    lines.push(`    // Step 11: GET with includeInactive`);
    lines.push(`    t.step('11', 'GET - includeInactive=true');`);
    lines.push(`    res = await t.apiGet(\`\${API}/\${id}\`, { includeInactive: 'true' });`);
    lines.push(`    t.assertStatus(res, 200, 'include-inactive-status');`);
    lines.push(`    t.assertSuccess(res, 'include-inactive-success');`);
    lines.push(`    t.assertField(res, 'isActive', 'false', 'include-inactive-flag');`);
    lines.push(``);
  }

  // ---- Steps 12-14: Hard delete cleanup (child first, then ancestors in reverse) ----
  if (hasHistory) {
    lines.push(`    // Steps 12-14: Hard delete cleanup`);
    lines.push(`    t.hardDeleteCleanup(TABLE, '${name}_id', id);`);
  } else {
    lines.push(`    // Hard delete cleanup (no history/triggers)`);
    lines.push(`    t.simpleHardDelete(TABLE, '${name}_id', id);`);
  }

  // Clean up ancestors in reverse order
  if (ancestors.length > 0) {
    lines.push(``);
    lines.push(`    // Cleanup ancestor records`);
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const anc = ancestors[i];
      const varName = toCamelCase(anc.tableName) + 'Id';
      if (anc.hasHistory) {
        lines.push(`    t.hardDeleteCleanup('${anc.tableName}', '${anc.tableName}_id', ${varName});`);
      } else {
        lines.push(`    t.simpleHardDelete('${anc.tableName}', '${anc.tableName}_id', ${varName});`);
      }
    }
  }
  lines.push(``);

  // ---- Step 15: Final verification ----
  lines.push(`    // Step 15: Final verification`);
  lines.push(`    t.step('15', 'GET - Final verify (should be 404)');`);
  lines.push(`    res = await t.apiGet(\`\${API}/\${id}\`, { includeInactive: 'true' });`);
  lines.push(`    t.assertStatus(res, 404, 'final-verify');`);
  lines.push(``);

  // ---- LIST test ----
  lines.push(`    // LIST test`);
  lines.push(`    t.section('LIST');`);
  lines.push(`    t.step('L1', 'GET - List');`);
  lines.push(`    res = await t.apiGet(API);`);
  lines.push(`    t.assertStatus(res, 200, 'list-status');`);
  lines.push(`    t.assertSuccess(res, 'list-success');`);
  lines.push(``);

  lines.push(`    const ok = t.printSummary();`);
  lines.push(`    process.exit(ok ? 0 : 1);`);
  lines.push(`})();`);
  lines.push(``);

  return lines.join('\n');
}

// ============================================================
// Generate test-public-routes.js
// ============================================================

function generatePublicRoutesTest() {
  return `// Generated by generate_tests.js — public route tests
const t = require('./test-utils')(process.argv[2]);

(async () => {
    t.section('Public Routes');

    // Health check
    t.step('1', 'GET / - Health check');
    let res = await t.apiGet('/');
    t.assertStatus(res, 200, 'health-status');
    t.assertSuccess(res, 'health-success');

    // DB test
    t.step('2', 'GET /dbtest - DB connectivity');
    res = await t.apiGet('/dbtest');
    t.assertStatus(res, 200, 'dbtest-status');
    t.assertSuccess(res, 'dbtest-success');

    // 404
    t.step('3', 'GET /api/nonexistent - 404');
    res = await t.apiGet('/api/nonexistent-xyz');
    t.assertStatus(res, 404, 'not-found');
    t.assertError(res, 'not-found-error');

    // CORS preflight
    t.step('4', 'OPTIONS - CORS');
    res = await t.apiRaw('OPTIONS', process.argv[2] + '/api/contract');
    t.assertStatus(res, 200, 'cors-preflight');

    // No auth - 401
    t.step('5', 'GET /api/contract without auth - 401');
    const noAuthRes = await fetch(process.argv[2] + '/api/contract');
    t.assertStatus({ status: noAuthRes.status, body: null, raw: '' }, 401, 'no-auth');

    // POST with ID - 400
    t.step('6', 'POST with ID - 400');
    res = await t.apiPost('/api/contract/00000000-0000-0000-0000-000000000000', {});
    t.assertStatus(res, 400, 'post-with-id');

    // PUT without ID - 400
    t.step('7', 'PUT without ID - 400');
    res = await t.apiPut('/api/contract', {});
    t.assertStatus(res, 400, 'put-without-id');

    const ok = t.printSummary();
    process.exit(ok ? 0 : 1);
})();
`;
}

// ============================================================
// Generate run-all.js
// ============================================================

function generateRunAll(tableNames) {
  const lines = [];
  lines.push(`// Generated by generate_tests.js — run all tests`);
  lines.push(`// Usage: node run-all.js <base_url>`);
  lines.push(`const { execSync } = require('child_process');`);
  lines.push(`const path = require('path');`);
  lines.push(``);
  lines.push(`const url = process.argv[2];`);
  lines.push(`if (!url) { console.error('Usage: node run-all.js <base_url>'); process.exit(1); }`);
  lines.push(``);
  lines.push(`const dir = __dirname;`);
  lines.push(`let passed = 0, failed = 0;`);
  lines.push(`const failures = [];`);
  lines.push(``);
  lines.push(`function run(script) {`);
  lines.push(`    const name = path.basename(script, '.js');`);
  lines.push(`    console.log('\\n================================================================');`);
  lines.push(`    console.log('  Running: ' + name);`);
  lines.push(`    console.log('================================================================');`);
  lines.push(`    try {`);
  lines.push(`        execSync(\`node "\${path.join(dir, script)}" "\${url}"\`, { stdio: 'inherit' });`);
  lines.push(`        passed++;`);
  lines.push(`    } catch {`);
  lines.push(`        failed++;`);
  lines.push(`        failures.push(name);`);
  lines.push(`    }`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`run('test-public-routes.js');`);

  for (const name of tableNames) {
    lines.push(`run('test-${toKebabCase(name)}.js');`);
  }

  lines.push(``);
  lines.push(`console.log('\\n================================================================');`);
  lines.push(`console.log('  ALL TESTS COMPLETE');`);
  lines.push(`console.log('  Suites passed: ' + passed);`);
  lines.push(`console.log('  Suites failed: ' + failed);`);
  lines.push(`if (failures.length > 0) console.log('  Failed: ' + failures.join(', '));`);
  lines.push(`console.log('================================================================');`);
  lines.push(`process.exit(failed > 0 ? 1 : 0);`);
  lines.push(``);

  return lines.join('\n');
}

// ============================================================
// Write files
// ============================================================

if (isMain) {
  const outputDir = process.argv[3] ? path.resolve(process.argv[3]) : path.join(process.cwd(), 'TESTS');

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(path.join(outputDir, 'test-utils.js'), generateTestUtils(), 'utf8');
  fs.writeFileSync(path.join(outputDir, 'test-public-routes.js'), generatePublicRoutesTest(), 'utf8');

  const tableNames = [];
  for (const table of tables) {
    const kebab = toKebabCase(table.name);
    const script = generateTestScript(table);
    fs.writeFileSync(path.join(outputDir, `test-${kebab}.js`), script, 'utf8');
    tableNames.push(table.name);
  }

  fs.writeFileSync(path.join(outputDir, 'run-all.js'), generateRunAll(tableNames), 'utf8');

  console.log(`Generated ${tableNames.length + 2} test files in ${outputDir}`);
  console.log(`  test-utils.js`);
  console.log(`  test-public-routes.js`);
  for (const name of tableNames) {
    console.log(`  test-${toKebabCase(name)}.js`);
  }
  console.log(`  run-all.js`);
}

module.exports = { generateTestScript, generateTestUtils, generateRunAll };
