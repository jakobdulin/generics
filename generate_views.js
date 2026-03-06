const fs = require('fs');
const path = require('path');

const VIEWS_DIR = path.join(__dirname, 'SQL', 'VIEWS');

if (!fs.existsSync(VIEWS_DIR)) {
  fs.mkdirSync(VIEWS_DIR, { recursive: true });
}

// ============================================================
// View definitions — loaded from views.json
// ============================================================
const views = require('./views.json');

// ============================================================
// SQL generation
// ============================================================

function colExpr(alias, col) {
  if (typeof col === 'string') {
    return `        ${alias}.${col}`;
  }
  // { col, as } — aliased column
  return `        ${alias}.${col.col} AS ${col.as}`;
}

function generateView(view) {
  const vName = `vx_${view.name}`;
  const isIndexed = view.type === 'indexed';
  const lines = [];

  // Drop if exists
  lines.push(`IF EXISTS (SELECT * FROM sys.views WHERE name = '${vName}')`);
  lines.push(`    DROP VIEW ${vName};`);
  lines.push('GO');
  lines.push('');

  // CREATE VIEW
  if (isIndexed) {
    lines.push(`CREATE VIEW ${vName}`);
    lines.push('WITH SCHEMABINDING');
  } else {
    lines.push(`CREATE VIEW ${vName}`);
  }
  lines.push('AS');

  // SELECT columns
  const selectCols = [];

  // Base table PK
  selectCols.push(`        ${view.baseAlias}.${view.baseTable}_id`);

  // Base table business columns
  for (const col of view.baseCols) {
    selectCols.push(`        ${view.baseAlias}.${col}`);
  }

  // Joined table columns
  for (const join of view.joins) {
    for (const col of join.cols) {
      selectCols.push(colExpr(join.alias, col));
    }
  }

  // Base table audit columns
  selectCols.push(`        ${view.baseAlias}.is_active`);
  selectCols.push(`        ${view.baseAlias}.created_on`);
  selectCols.push(`        ${view.baseAlias}.created_by`);
  selectCols.push(`        ${view.baseAlias}.modified_on`);
  selectCols.push(`        ${view.baseAlias}.modified_by`);

  lines.push('    SELECT');
  lines.push(selectCols.join(',\n'));

  // FROM
  const tableRef = isIndexed ? `dbo.${view.baseTable}` : view.baseTable;
  lines.push(`    FROM ${tableRef} ${view.baseAlias}`);

  // JOINs
  for (const join of view.joins) {
    const joinType = join.type || 'INNER';
    const joinTableRef = isIndexed ? `dbo.${join.table}` : join.table;
    lines.push(`    ${joinType} JOIN ${joinTableRef} ${join.alias} ON ${join.on}`);
  }

  // Close view
  lines.push('GO');
  lines.push('');

  // Indexes (indexed views only)
  if (isIndexed) {
    // Unique clustered index on base PK
    lines.push(`CREATE UNIQUE CLUSTERED INDEX ix_${vName}_pk`);
    lines.push(`    ON ${vName} (${view.baseTable}_id);`);

    // Nonclustered indexes on filter columns
    for (const filterCol of (view.filterIndexes || [])) {
      lines.push(`CREATE NONCLUSTERED INDEX ix_${vName}_${filterCol}`);
      lines.push(`    ON ${vName} (${filterCol});`);
    }

    lines.push('GO');
    lines.push('');
  }

  return lines.join('\n');
}

// ============================================================
// Write files
// ============================================================

let count = 0;
for (const view of views) {
  const sql = generateView(view);
  const fileName = `vx_${view.name}.sql`;
  fs.writeFileSync(path.join(VIEWS_DIR, fileName), sql, 'utf8');
  count++;
}

console.log(`Generated ${count} view files in ${VIEWS_DIR}`);
