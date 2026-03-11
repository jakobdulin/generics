DECLARE @TableName NVARCHAR(128) = '$(TableName)';
DECLARE @CreateTableSQL NVARCHAR(MAX) = '';
DECLARE @ColumnName NVARCHAR(128);
DECLARE @DataType NVARCHAR(128);
DECLARE @MaxLength INT;
DECLARE @IsNullable BIT;
DECLARE @DefaultConstraint NVARCHAR(MAX);
DECLARE @IsIdentity BIT;
DECLARE @IsRowGuid BIT;
DECLARE @IsPrimaryKey BIT;

-- Check if table exists
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = @TableName)
BEGIN
    PRINT 'Table ' + @TableName + ' does not exist.';
    RETURN;
END

-- Start building the CREATE TABLE statement
SET @CreateTableSQL = 'CREATE TABLE ' + @TableName + ' (' + CHAR(13) + CHAR(10);

-- Cursor to iterate through columns
DECLARE column_cursor CURSOR FOR
SELECT 
    c.name AS column_name,
    t.name + 
        CASE 
            WHEN t.name IN ('varchar', 'nvarchar', 'char', 'nchar') THEN 
                CASE WHEN c.max_length = -1 THEN '(MAX)' 
                     ELSE '(' + CAST(CASE WHEN t.name LIKE 'n%' THEN c.max_length/2 ELSE c.max_length END AS VARCHAR(10)) + ')' 
                END
            WHEN t.name IN ('decimal', 'numeric') THEN '(' + CAST(c.precision AS VARCHAR(10)) + ',' + CAST(c.scale AS VARCHAR(10)) + ')'
            WHEN t.name IN ('float') THEN CASE WHEN c.precision = 53 THEN '' ELSE '(' + CAST(c.precision AS VARCHAR(10)) + ')' END
            WHEN t.name IN ('datetime2', 'time', 'datetimeoffset') THEN '(' + CAST(c.scale AS VARCHAR(10)) + ')'
            ELSE ''
        END AS data_type,
    c.max_length,
    c.is_nullable,
    dc.definition AS default_constraint,
    c.is_identity,
    c.is_rowguidcol,
    CASE WHEN pk.column_name IS NOT NULL THEN 1 ELSE 0 END AS is_primary_key
FROM sys.columns c
INNER JOIN sys.types t ON c.user_type_id = t.user_type_id
LEFT JOIN sys.default_constraints dc ON c.default_object_id = dc.object_id
LEFT JOIN (
    SELECT 
        kc.column_name,
        kc.table_name
    FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kc
    INNER JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc ON kc.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'PRIMARY KEY'
) pk ON c.name = pk.column_name AND pk.table_name = @TableName
WHERE c.object_id = OBJECT_ID(@TableName)
ORDER BY c.column_id;

OPEN column_cursor;
FETCH NEXT FROM column_cursor INTO @ColumnName, @DataType, @MaxLength, @IsNullable, @DefaultConstraint, @IsIdentity, @IsRowGuid, @IsPrimaryKey;

DECLARE @IsFirstColumn BIT = 1;

WHILE @@FETCH_STATUS = 0
BEGIN
    -- Add comma and newline for subsequent columns
    IF @IsFirstColumn = 0
        SET @CreateTableSQL = @CreateTableSQL + ',' + CHAR(13) + CHAR(10);
    
    -- Add column definition
    SET @CreateTableSQL = @CreateTableSQL + '    ' + @ColumnName + ' ' + @DataType;
    
    -- Add IDENTITY if applicable
    IF @IsIdentity = 1
        SET @CreateTableSQL = @CreateTableSQL + ' IDENTITY(1,1)';
    
    -- Add ROWGUIDCOL if applicable
    IF @IsRowGuid = 1
        SET @CreateTableSQL = @CreateTableSQL + ' ROWGUIDCOL';
    
    -- Add DEFAULT constraint if exists
    IF @DefaultConstraint IS NOT NULL
        SET @CreateTableSQL = @CreateTableSQL + ' DEFAULT ' + @DefaultConstraint;
    
    -- Primary key will be handled separately at the end
    
    -- Add NULL/NOT NULL
    IF @IsNullable = 0
        SET @CreateTableSQL = @CreateTableSQL + ' NOT NULL';
    ELSE
        SET @CreateTableSQL = @CreateTableSQL + ' NULL';
    
    SET @IsFirstColumn = 0;
    FETCH NEXT FROM column_cursor INTO @ColumnName, @DataType, @MaxLength, @IsNullable, @DefaultConstraint, @IsIdentity, @IsRowGuid, @IsPrimaryKey;
END

CLOSE column_cursor;
DEALLOCATE column_cursor;

-- Add primary key constraint
DECLARE @PrimaryKeyColumns NVARCHAR(MAX) = '';
SELECT @PrimaryKeyColumns = @PrimaryKeyColumns + 
    CASE WHEN @PrimaryKeyColumns != '' THEN ', ' ELSE '' END + c.name
FROM sys.columns c
INNER JOIN sys.index_columns ic ON c.object_id = ic.object_id AND c.column_id = ic.column_id
INNER JOIN sys.indexes i ON ic.object_id = i.object_id AND ic.index_id = i.index_id
WHERE c.object_id = OBJECT_ID(@TableName) AND i.is_primary_key = 1
ORDER BY ic.key_ordinal;

IF @PrimaryKeyColumns != ''
    SET @CreateTableSQL = @CreateTableSQL + ',' + CHAR(13) + CHAR(10) + '    PRIMARY KEY (' + @PrimaryKeyColumns + ')';

-- Add unique constraints
DECLARE @UniqueConstraints NVARCHAR(MAX) = '';
SELECT @UniqueConstraints = @UniqueConstraints + 
    CASE WHEN @UniqueConstraints != '' THEN ',' + CHAR(13) + CHAR(10) ELSE '' END +
    '    CONSTRAINT ' + i.name + ' UNIQUE (' +
    (
        SELECT STRING_AGG(c.name, ', ') WITHIN GROUP (ORDER BY ic.key_ordinal)
        FROM sys.index_columns ic
        INNER JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
        WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
    ) + ')'
FROM sys.indexes i
WHERE i.object_id = OBJECT_ID(@TableName)
    AND i.is_primary_key = 0
    AND i.is_unique_constraint = 1
    AND i.type > 0;

IF @UniqueConstraints != ''
    SET @CreateTableSQL = @CreateTableSQL + ',' + CHAR(13) + CHAR(10) + @UniqueConstraints;

-- Add foreign key constraints
DECLARE @ForeignKeys NVARCHAR(MAX) = '';
SELECT @ForeignKeys = @ForeignKeys + 
    CASE WHEN @ForeignKeys != '' THEN ',' + CHAR(13) + CHAR(10) ELSE '' END +
    '    FOREIGN KEY (' + fk_cols.name + ') REFERENCES ' + pk_table.name + '(' + pk_cols.name + ')'
FROM sys.foreign_keys fk
INNER JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
INNER JOIN sys.columns fk_cols ON fkc.parent_object_id = fk_cols.object_id AND fkc.parent_column_id = fk_cols.column_id
INNER JOIN sys.columns pk_cols ON fkc.referenced_object_id = pk_cols.object_id AND fkc.referenced_column_id = pk_cols.column_id
INNER JOIN sys.tables pk_table ON fkc.referenced_object_id = pk_table.object_id
WHERE fk.parent_object_id = OBJECT_ID(@TableName);

-- Add foreign keys if they exist
IF @ForeignKeys != ''
    SET @CreateTableSQL = @CreateTableSQL + ',' + CHAR(13) + CHAR(10) + @ForeignKeys;

-- Close the CREATE TABLE statement
SET @CreateTableSQL = @CreateTableSQL + CHAR(13) + CHAR(10) + ');';

-- Add indexes
DECLARE @IndexSQL NVARCHAR(MAX) = '';
SELECT @IndexSQL = @IndexSQL + 
    CHAR(13) + CHAR(10) + CHAR(13) + CHAR(10) +
    'CREATE ' + 
    CASE WHEN i.is_unique = 1 THEN 'UNIQUE ' ELSE '' END +
    CASE WHEN i.type_desc = 'CLUSTERED' THEN 'CLUSTERED ' 
         WHEN i.type_desc = 'NONCLUSTERED' THEN 'NONCLUSTERED ' 
         ELSE '' END +
    'INDEX ' + i.name + ' ON ' + @TableName + ' (' +
    (
        SELECT STRING_AGG(
            c.name + CASE WHEN ic.is_descending_key = 1 THEN ' DESC' ELSE '' END, 
            ', '
        ) WITHIN GROUP (ORDER BY ic.key_ordinal)
        FROM sys.index_columns ic
        INNER JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
        WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
    ) +
    ')' +
    CASE 
        WHEN EXISTS (
            SELECT 1 FROM sys.index_columns ic 
            WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 1
        ) THEN 
            ' INCLUDE (' +
            (
                SELECT STRING_AGG(c.name, ', ')
                FROM sys.index_columns ic
                INNER JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
                WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 1
            ) + ')'
        ELSE ''
    END +
    ';' + CHAR(13) + CHAR(10) + 'GO;'
FROM sys.indexes i
WHERE i.object_id = OBJECT_ID(@TableName)
    AND i.is_primary_key = 0  -- Exclude primary key (already in CREATE TABLE)
    AND i.is_unique_constraint = 0  -- Exclude unique constraints
    AND i.type > 0  -- Exclude heaps
ORDER BY i.name;  -- Alphabetical order

DECLARE @TriggerSQL NVARCHAR(MAX) = '';

-- Add triggers
SELECT @TriggerSQL = @TriggerSQL + 
    CHAR(13) + CHAR(10) + CHAR(13) + CHAR(10) +
    ISNULL(sm.definition, 
        'CREATE TRIGGER ' + t.name + ' ON ' + @TableName + CHAR(13) + CHAR(10) +
        CASE WHEN t.is_instead_of_trigger = 1 THEN 'INSTEAD OF ' ELSE 'AFTER ' END +
        LTRIM(RTRIM(
            CASE WHEN OBJECTPROPERTY(t.object_id, 'ExecIsInsertTrigger') = 1 THEN 'INSERT ' ELSE '' END +
            CASE WHEN OBJECTPROPERTY(t.object_id, 'ExecIsUpdateTrigger') = 1 THEN 'UPDATE ' ELSE '' END +
            CASE WHEN OBJECTPROPERTY(t.object_id, 'ExecIsDeleteTrigger') = 1 THEN 'DELETE ' ELSE '' END
        )) + CHAR(13) + CHAR(10) +
        'AS' + CHAR(13) + CHAR(10) +
        'BEGIN' + CHAR(13) + CHAR(10) +
        '    -- Trigger definition not available' + CHAR(13) + CHAR(10) +
        'END;'
    ) + CHAR(13) + CHAR(10) + 'GO'
FROM sys.triggers t
LEFT JOIN sys.sql_modules sm ON t.object_id = sm.object_id
WHERE t.parent_id = OBJECT_ID(@TableName)
    AND t.is_ms_shipped = 0  -- Exclude system triggers
    AND t.parent_class_desc = 'OBJECT_OR_COLUMN'  -- Table triggers only
ORDER BY t.name;  -- Alphabetical order

-- SKIP THIS
-- Combine CREATE TABLE, indexes, and triggers
-- SET @CreateTableSQL = @CreateTableSQL + @TriggerSQL;


PRINT @CreateTableSQL;
PRINT CHAR(13) + CHAR(10) + '-- Table: ' + @TableName + ' created successfully. ' + CAST(GETUTCDATE() AS VARCHAR);
