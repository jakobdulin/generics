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
    PRINT 'Table ' + @TableName + ' does not exist. So I doubt it has any triggers.';
    RETURN;
END

-- Start building the CREATE TABLE statement
SET @CreateTableSQL = '';

DECLARE @TriggerSQL NVARCHAR(MAX) = '';

SELECT  @TriggerSQL = @TriggerSQL + 'DROP TRIGGER IF EXISTS [' + SCHEMA_NAME(t.schema_id) + '].[' + tr.name + '];' + CHAR(13)
FROM sys.triggers tr
INNER JOIN sys.tables t ON tr.parent_id = t.object_id
WHERE t.name = @TableName;

IF @TriggerSQL <> ''
  SELECT  @TriggerSQL = @TriggerSQL + 'GO' + CHAR(13) + CHAR(13)

-- Add triggers
SELECT @TriggerSQL = @TriggerSQL + 
    CHAR(13) + CHAR(13) +
    ISNULL(sm.definition, 
        'CREATE TRIGGER ' + t.name + ' ON ' + @TableName + CHAR(13) + CHAR(10) +
        CASE WHEN t.is_instead_of_trigger = 1 THEN 'INSTEAD OF ' ELSE 'AFTER ' END +
        LTRIM(RTRIM(
            CASE WHEN OBJECTPROPERTY(t.object_id, 'ExecIsInsertTrigger') = 1 THEN 'INSERT ' ELSE '' END +
            CASE WHEN OBJECTPROPERTY(t.object_id, 'ExecIsUpdateTrigger') = 1 THEN 'UPDATE ' ELSE '' END +
            CASE WHEN OBJECTPROPERTY(t.object_id, 'ExecIsDeleteTrigger') = 1 THEN 'DELETE ' ELSE '' END
        )) + CHAR(13) +
        'AS' + CHAR(13) +
        'BEGIN' + CHAR(13) +
        '    -- Trigger definition not available' + CHAR(13) +
        'END;'
    ) + CHAR(13) + 'GO'
FROM sys.triggers t
LEFT JOIN sys.sql_modules sm ON t.object_id = sm.object_id
WHERE t.parent_id = OBJECT_ID(@TableName)
    AND t.is_ms_shipped = 0  -- Exclude system triggers
    AND t.parent_class_desc = 'OBJECT_OR_COLUMN'  -- Table triggers only
ORDER BY t.name;  -- Alphabetical order


-- Combine CREATE TABLE, indexes, and triggers
SET @CreateTableSQL = @CreateTableSQL + @TriggerSQL;


PRINT @CreateTableSQL;
PRINT CHAR(13) + CHAR(10) + '-- Triggers for Table: ' + @TableName + ' created successfully. ' + CAST(GETUTCDATE() AS VARCHAR);
