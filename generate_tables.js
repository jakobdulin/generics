const fs = require('fs');
const path = require('path');

const TABLES_DIR = path.join(__dirname, 'TABLES');

// ============================================================
// Table definitions — loaded from tables.json
// ============================================================
const tables = require('./tables.json');

// ============================================================
// SQL generation helpers
// ============================================================

function getAllColumnNames(table) {
  return [
    `${table.name}_id`,
    ...table.columns.map(c => c.name),
    'modified',
    'created',
  ];
}

// ============================================================
// Main table SQL generation
// ============================================================

function generateSQL(table) {
  const { name, columns, fks, checks, uniques, indexes } = table;
  const lines = [];

  lines.push(`CREATE TABLE ${name} (`);

  const colLines = [];

  // PK
  const idDefault = table.useNewId ? 'newid' : 'newsequentialid';
  colLines.push(`    ${name}_id uniqueidentifier ROWGUIDCOL CONSTRAINT df__${name}__${name}_id__${idDefault} DEFAULT (${idDefault}()) PRIMARY KEY NOT NULL`);

  // Business columns
  for (const col of columns) {
    let line = `    ${col.name} ${col.type}`;
    if (col.default) {
      line += ` CONSTRAINT df__${name}__${col.name}__${col.defaultLabel} DEFAULT ${col.default}`;
    }
    line += col.nullable ? ' NULL' : ' NOT NULL';
    colLines.push(line);
  }

  // Audit footer: modified, created
  colLines.push(`    modified datetime2(7) CONSTRAINT df__${name}__modified__getutcdate DEFAULT (getutcdate()) NOT NULL`);
  colLines.push(`    created datetime2(7) CONSTRAINT df__${name}__created__getutcdate DEFAULT (getutcdate()) NOT NULL`);

  // FKs
  for (const f of fks) {
    colLines.push(`    FOREIGN KEY (${f.col}) REFERENCES ${f.refTable}(${f.refCol})`);
  }

  // CHECK constraints
  for (const c of checks) {
    colLines.push(`    CONSTRAINT ${c.name} CHECK (${c.expr})`);
  }

  lines.push(colLines.join(',\n'));

  lines.push(');');
  lines.push('GO');
  lines.push('');

  // Delete prevention trigger
  lines.push(`CREATE TRIGGER TR_${name}_delete ON dbo.${name}`);
  lines.push('INSTEAD OF DELETE');
  lines.push('AS');
  lines.push('BEGIN');
  lines.push('    SET NOCOUNT ON;');
  lines.push('');
  lines.push(`    RAISERROR('Delete operations are not allowed on ${name} table', 16, 1);`);
  lines.push('');
  lines.push('    SET NOCOUNT OFF;');
  lines.push('END;');
  lines.push('GO');
  lines.push('');

  // Update audit trigger
  lines.push(`CREATE TRIGGER TR_${name}_update ON dbo.${name}`);
  lines.push('FOR UPDATE');
  lines.push('AS');
  lines.push('BEGIN');
  lines.push('    SET NOCOUNT ON;');
  lines.push('');
  lines.push('    IF UPDATE(created) OR UPDATE(modified)');
  lines.push('    BEGIN');
  lines.push(`        RAISERROR('Cannot update created or modified columns directly', 16, 1);`);
  lines.push('        ROLLBACK;');
  lines.push('        RETURN;');
  lines.push('    END');
  lines.push('');

  if (table.hasHistory) {
    const allCols = getAllColumnNames(table);
    const colList = allCols.map(c => `        ${c}`).join(',\n');

    lines.push('    -- Archive old rows to history');
    lines.push(`    INSERT INTO history.${name} (`);
    lines.push(colList);
    lines.push('    )');
    lines.push('    SELECT');
    lines.push(colList);
    lines.push('    FROM deleted;');
    lines.push('');
  }

  lines.push(`    UPDATE ${name}`);
  lines.push('    SET modified = GETUTCDATE()');
  lines.push(`    FROM ${name} t`);
  lines.push(`    INNER JOIN inserted i ON t.${name}_id = i.${name}_id;`);
  lines.push('');
  lines.push('    SET NOCOUNT OFF;');
  lines.push('END;');
  lines.push('GO');
  lines.push('');

  // Unique constraints (some are filtered)
  for (const u of uniques) {
    if (u.filter) {
      lines.push(`CREATE UNIQUE NONCLUSTERED INDEX ${u.name} ON ${name} (${u.cols.join(', ')}) WHERE ${u.filter};`);
    } else {
      lines.push(`CREATE UNIQUE NONCLUSTERED INDEX ${u.name} ON ${name} (${u.cols.join(', ')});`);
    }
  }

  // Indexes on FKs and other columns
  const coveredCols = new Set();
  for (const u of uniques) {
    coveredCols.add(u.cols[0]);
  }

  for (const ix of indexes) {
    if (ix.cols.length === 1 && coveredCols.has(ix.cols[0])) continue;
    lines.push(`CREATE NONCLUSTERED INDEX ${ix.name} ON ${name} (${ix.cols.join(', ')});`);
  }

  lines.push('');

  return lines.join('\n');
}

// ============================================================
// History table SQL generation (history schema, same table name)
// ============================================================

function generateHistorySQL(table) {
  const { name, columns } = table;
  const lines = [];

  lines.push(`CREATE TABLE history.${name} (`);

  const colLines = [];

  // History PK
  colLines.push(`    ${name}_history_id uniqueidentifier ROWGUIDCOL CONSTRAINT df__history_${name}__${name}_history_id__newsequentialid DEFAULT (newsequentialid()) PRIMARY KEY NOT NULL`);

  // Original PK as a regular column
  colLines.push(`    ${name}_id uniqueidentifier NOT NULL`);

  // All business columns (no defaults, no FKs, no checks — just data)
  for (const col of columns) {
    let line = `    ${col.name} ${col.type}`;
    line += col.nullable ? ' NULL' : ' NOT NULL';
    colLines.push(line);
  }

  // Audit columns from the original row
  colLines.push('    modified datetime2(7) NOT NULL');
  colLines.push('    created datetime2(7) NOT NULL');

  // History-specific
  colLines.push(`    archived_at datetime2(7) CONSTRAINT df__history_${name}__archived_at__getutcdate DEFAULT (getutcdate()) NOT NULL`);

  lines.push(colLines.join(',\n'));

  lines.push(');');
  lines.push('GO');
  lines.push('');

  // Prevent deletes on history
  lines.push(`CREATE TRIGGER TR_history_${name}_delete ON history.${name}`);
  lines.push('INSTEAD OF DELETE');
  lines.push('AS');
  lines.push('BEGIN');
  lines.push('    SET NOCOUNT ON;');
  lines.push('');
  lines.push(`    RAISERROR('Delete operations are not allowed on history.${name} table', 16, 1);`);
  lines.push('');
  lines.push('    SET NOCOUNT OFF;');
  lines.push('END;');
  lines.push('GO');
  lines.push('');

  // Prevent updates on history
  lines.push(`CREATE TRIGGER TR_history_${name}_update ON history.${name}`);
  lines.push('INSTEAD OF UPDATE');
  lines.push('AS');
  lines.push('BEGIN');
  lines.push('    SET NOCOUNT ON;');
  lines.push('');
  lines.push(`    RAISERROR('Update operations are not allowed on history.${name} table', 16, 1);`);
  lines.push('');
  lines.push('    SET NOCOUNT OFF;');
  lines.push('END;');
  lines.push('GO');
  lines.push('');

  // Indexes
  lines.push(`CREATE NONCLUSTERED INDEX ix_history_${name}_${name}_id ON history.${name} (${name}_id);`);
  lines.push(`CREATE NONCLUSTERED INDEX ix_history_${name}_archived_at ON history.${name} (archived_at);`);
  lines.push('');

  return lines.join('\n');
}

// ============================================================
// Write files
// ============================================================
if (require.main === module) {
  if (!fs.existsSync(TABLES_DIR)) {
    fs.mkdirSync(TABLES_DIR, { recursive: true });
  }

  const HISTORY_DIR = path.join(__dirname, 'TABLES_HISTORY');
  if (!fs.existsSync(HISTORY_DIR)) {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
  }

  // Schema creation script
  const schemaSQL = `IF NOT EXISTS (SELECT * FROM sys.schemas WHERE name = 'history')
    EXEC('CREATE SCHEMA history');
GO
`;
  fs.writeFileSync(path.join(HISTORY_DIR, '_create_schema.sql'), schemaSQL, 'utf8');

  let mainCount = 0;
  let histCount = 0;
  for (const table of tables) {
    const sql = generateSQL(table);
    fs.writeFileSync(path.join(TABLES_DIR, `${table.name}.sql`), sql, 'utf8');
    mainCount++;

    if (table.hasHistory) {
      const histSQL = generateHistorySQL(table);
      fs.writeFileSync(path.join(HISTORY_DIR, `${table.name}.sql`), histSQL, 'utf8');
      histCount++;
    }
  }
  console.log(`Generated ${mainCount} table files in ${TABLES_DIR}`);
  console.log(`Generated ${histCount} history table files in ${HISTORY_DIR}`);
  console.log(`Generated schema script: ${path.join(HISTORY_DIR, '_create_schema.sql')}`);
}

module.exports = tables;
