# Database Table Design Guide

## Overview

This guide documents the standardized approach to table design, naming conventions, data types, and trigger implementation used in the all Davis developed databases.

## Table Structure Standards

### Primary Keys
- **Type**: `uniqueidentifier`
- **Naming**: `{table_name}_id`
- **Default**: Use `newsequentialid()` (or `newid()` for security-sensitive IDs like tokens)
- **Constraint**: Named default with `ROWGUIDCOL ... PRIMARY KEY NOT NULL`

**Examples:**
```sql
account_id uniqueidentifier ROWGUIDCOL CONSTRAINT df__account__account_id__newsequentialid DEFAULT (newsequentialid()) PRIMARY KEY NOT NULL

customer_id uniqueidentifier ROWGUIDCOL CONSTRAINT df__customer__customer_id__newsequentialid DEFAULT (newsequentialid()) PRIMARY KEY NOT NULL
```

### Audit Fields (Required on All Tables)
Every table must include these two audit fields, and they are always the last two fields in every table:

```sql
modified datetime2(7) CONSTRAINT df__{table_name}__modified__getutcdate DEFAULT (getutcdate()) NOT NULL,
created datetime2(7) CONSTRAINT df__{table_name}__created__getutcdate DEFAULT (getutcdate()) NOT NULL
```

Tables which need to be able to hide records during the normal course of use may have an is_active bit(1) field to simulate deletion.
The is_active field, when used, will always be just before the modified field.

```sql
is_active bit CONSTRAINT df__{table_name}__is_active__1 DEFAULT ((1)) NOT NULL,
```

- **is_active**: Soft delete flag, defaults to true (1)
- **modified**: Auto-updated by triggers, UTC timezone
- **created**: Set once on insert, UTC timezone

### Foreign Keys
- **Type**: `uniqueidentifier`
- **Naming**: `{referenced_table}_id`
- **Constraint**: Always include explicit FOREIGN KEY constraints

**Example:**
```sql
customer_id uniqueidentifier NOT NULL,
FOREIGN KEY (customer_id) REFERENCES customer(customer_id)
```

### Data Types Standards

| Data Type | Use Case | Example |
|-----------|----------|---------|
| `uniqueidentifier` | Primary keys, foreign keys | `account_id`, `customer_id` |
| `nvarchar(50)` | Short text (names) | `first_name`, `account_name` |
| `nvarchar(100)` | Medium text (descriptions) | `account_description` |
| `nvarchar(255)` | Long text | `journal_entry_description` |
| `nvarchar(4000)` | Large text | `notes`, `project_description` |
| `varchar(50)` | ASCII-only text | `phone`, `email` |
| `varchar(255)` | ASCII-only long text | `email` |
| `smallint` | Small numbers | `account_number` |
| `money` | Currency amounts | `budget_amount` |
| `bit` | Boolean values | `is_active` |
| `date` | Date only | `hire_date`, `invoice_date` |
| `datetime2(7)` | Precise timestamps | `created`, `modified` |

### Default Values
- **Text fields**: Use `DEFAULT ('')` for required text fields that may be empty
- **Boolean fields**: Use `DEFAULT ((1))` for is_active
- **Timestamps**: Use `DEFAULT (getutcdate())` for audit fields
- **Nullable fields**: Don't specify defaults for optional fields

### Indexing Standards

#### Required Indexes
- **Primary Key**: Automatically clustered
- **Foreign Keys**: Create non-clustered indexes
- **Frequently Searched Fields**: Add non-clustered indexes

**Example:**
```sql
CREATE NONCLUSTERED INDEX ix_customer_customer_long_name ON customer (customer_long_name);
CREATE NONCLUSTERED INDEX ix_invoice_customer_id ON invoice (customer_id);
CREATE NONCLUSTERED INDEX ix_invoice_invoice_date ON invoice (invoice_date);
```

#### Index Naming Convention
`IX_{table_name}_{column_name(s)}`

## Trigger Implementation

### Required Triggers
Every table must implement two triggers for data integrity:

#### 1. Delete Prevention Trigger
Prevents hard deletes and enforces soft delete pattern.

**Template:**
```sql
CREATE TRIGGER [dbo].[TR_{table_name}_delete] ON [dbo].{table_name}
FOR DELETE
AS
BEGIN
    SET NOCOUNT ON;
    
    RAISERROR('Cannot delete {table_name} records. Use is_active = 0 to deactivate records.', 16, 1);
    ROLLBACK TRANSACTION;
END
```

#### 2. Update Audit Trigger
Prevents modification of audit fields and auto-updates modified timestamp.

**Template:**
```sql
CREATE TRIGGER [dbo].[TR_{table_name}_update] ON [dbo].{table_name}
FOR UPDATE
AS
BEGIN
    SET NOCOUNT ON;
    
    -- Prevent updates to created field
    IF UPDATE(created)
    BEGIN
        RAISERROR('Cannot update created field', 16, 1);
        ROLLBACK TRANSACTION;
        RETURN;
    END
    
    -- Prevent manual updates to modified field
    IF UPDATE(modified)
    BEGIN
        RAISERROR('Cannot manually update modified field', 16, 1);
        ROLLBACK TRANSACTION;
        RETURN;
    END
    
    -- Update modified timestamp
    UPDATE {table_name} 
    SET modified = GETUTCDATE()
    WHERE {table_name}_id IN (SELECT {table_name}_id FROM inserted);
END
```

### Trigger Naming Conventions
- **Delete Prevention**: `TR_{table_name}_delete`
- **Update Audit**: `TR_{table_name}_update`

## Table Categories and Patterns

### Master Data Tables
Tables for reference data that rarely changes.

**Characteristics:**
- Include `is_active` for soft deletes
- Focused on lookup functionality
- Examples: `account_type`, `project_type`, `project_status`

**Example:**
```sql
CREATE TABLE account_type (
    account_type_id uniqueidentifier ROWGUIDCOL CONSTRAINT df__account_type__account_type_id__newsequentialid DEFAULT (newsequentialid()) PRIMARY KEY NOT NULL,
    account_type_name nvarchar(50) NOT NULL,
    normal_balance nvarchar(10) NOT NULL,
    is_active bit CONSTRAINT df__account_type__is_active__1 DEFAULT ((1)) NOT NULL,
    modified datetime2(7) CONSTRAINT df__account_type__modified__getutcdate DEFAULT (getutcdate()) NOT NULL,
    created datetime2(7) CONSTRAINT df__account_type__created__getutcdate DEFAULT (getutcdate()) NOT NULL
);
```

## Naming Conventions

### Do not use reserved SQL keywords or words that have other uses within SQL. For example:
- Do not use:  name, description, user, type, state
- Instead use: {table}_name, {table}_description, person, {table}_type, project_state, state_name

### Table Names
- Singular nouns: `customer`, `invoice`, `account`
- Lowercase with underscores: `account_type`, `city_state_zip`
- Descriptive and business-focused

### Column Names
- Lowercase with underscores: `customer_id`, `account_name`
- Include table prefix for IDs: `customer_id`, `account_type_id`
- Descriptive names: `billing_address_line_1`, `invoice_date`

### Constraint Names
- Foreign Keys: Use default naming
- Indexes: `ix_{table}_{columns}`
- Triggers: `TR_{table}_{delete|insert|update}` or `TR_{table}_{delete|insert|update}_{purpose}`
- Default Constraints: `df__{table}__{column}__{value}` (see below)

### Default Constraint Naming

All DEFAULT constraints must be explicitly named using the pattern:

```
df__{table_name}__{column_name}__{default_value}
```

Where `{default_value}` is a simplified, lowercase description of the default:

| Default Expression | Suffix |
|-------------------|--------|
| `newsequentialid()` | `newsequentialid` |
| `newid()` | `newid` |
| `getutcdate()` | `getutcdate` |
| `((1))` | `1` |
| `((0))` | `0` |
| `('')` | `empty` |
| `((360))` | `360` |
| `('F')` | `f` |
| `'*'` | (leave blank) |

**Examples:**
```sql
-- Primary key with newsequentialid
customer_id uniqueidentifier ROWGUIDCOL CONSTRAINT df__customer__customer_id__newsequentialid DEFAULT (newsequentialid()) PRIMARY KEY NOT NULL,

-- Boolean with default 1
is_active bit CONSTRAINT df__customer__is_active__1 DEFAULT ((1)) NOT NULL,

-- Timestamp with getutcdate
modified datetime2(7) CONSTRAINT df__customer__modified__getutcdate DEFAULT (getutcdate()) NOT NULL,

-- Empty string default
customer_phone varchar(20) CONSTRAINT df__customer__customer_phone__empty DEFAULT ('') NOT NULL,

-- Numeric default
date_duration_seconds smallint CONSTRAINT df__event__date_duration_seconds__360 DEFAULT ((360)) NOT NULL,

-- Character default
rotation_group char(1) CONSTRAINT df__event__rotation_group__f DEFAULT ('F') NOT NULL,
```

**Why explicit naming?**
- SQL Server auto-generates constraint names like `DF__customer__is_act__7A672E12` which are non-deterministic
- Explicit names allow scripts to be re-run without errors about duplicate constraint names
- Makes constraint management (dropping, altering) predictable across environments

## Common Patterns

### Address Handling
Use separate city_state_zip table for normalization:
```sql
billing_city_state_zip_id uniqueidentifier NOT NULL,
shipping_city_state_zip_id uniqueidentifier NOT NULL,
billing_address_line_1 varchar(100) DEFAULT ('') NOT NULL,
billing_address_line_2 varchar(100) DEFAULT ('') NOT NULL,
```

city_state_zip table should exist in any database that requires it and follows this format exactly:

```sql
CREATE TABLE [dbo].[city_state_zip](
	[city_state_zip_id] [uniqueidentifier] ROWGUIDCOL  NOT NULL,
	[city_name] [varchar](50) NOT NULL,
	[state_name] [varchar](50) NOT NULL,
	[state_code] [char](2) NOT NULL,
	[zip] [char](5) NOT NULL,
	[is_active] [bit] NOT NULL,
	[modified] [datetime2](7) NOT NULL,
	[created] [datetime2](7) NOT NULL,
 CONSTRAINT [PK_city_state_zip] PRIMARY KEY CLUSTERED 
(
	[city_state_zip_id] ASC
) WITH (
    PAD_INDEX = OFF,
    STATISTICS_NORECOMPUTE = OFF,
    IGNORE_DUP_KEY = OFF,
    ALLOW_ROW_LOCKS = ON,
    ALLOW_PAGE_LOCKS = ON,
    OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY],
CONSTRAINT [UQ_city_state_zip_id] UNIQUE NONCLUSTERED 
(
  [city_state_zip_id] ASC
) WITH (
    PAD_INDEX = OFF,
    STATISTICS_NORECOMPUTE = OFF,
    IGNORE_DUP_KEY = OFF,
    ALLOW_ROW_LOCKS = ON,
    ALLOW_PAGE_LOCKS = ON,
    OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO

CREATE NONCLUSTERED INDEX [IX_city_state_zip__state_code] ON [dbo].[city_state_zip]
(
	[state_code] ASC,
	[city_state_zip_id] ASC,
	[city_name] ASC,
	[state_name] ASC,
	[zip] ASC
) WITH (
    PAD_INDEX = OFF,
    STATISTICS_NORECOMPUTE = OFF,
    SORT_IN_TEMPDB = OFF,
    DROP_EXISTING = OFF,
    ONLINE = OFF,
    ALLOW_ROW_LOCKS = ON,
    ALLOW_PAGE_LOCKS = ON,
    OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO

CREATE NONCLUSTERED INDEX [IX_city_state_zip__zip] ON [dbo].[city_state_zip]
(
	[zip] ASC,
	[city_state_zip_id] ASC,
	[city_name] ASC,
	[state_name] ASC,
	[state_code] ASC
) WITH (
    PAD_INDEX = OFF,
    STATISTICS_NORECOMPUTE = OFF,
    SORT_IN_TEMPDB = OFF,
    DROP_EXISTING = OFF,
    ONLINE = OFF,
    ALLOW_ROW_LOCKS = ON,
    ALLOW_PAGE_LOCKS = ON,
    OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO

CREATE NONCLUSTERED INDEX [IX_city_state_zip_lookup] ON [dbo].[city_state_zip]
(
	[city_state_zip_id] ASC
)
INCLUDE([city_name],[state_name],[state_code],[zip]) WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO

ALTER TABLE [dbo].[city_state_zip] ADD  CONSTRAINT [DF__city_state_zip__city_state_zip_id__newid]  DEFAULT (newid()) FOR [city_state_zip_id]
GO

ALTER TABLE [dbo].[city_state_zip] ADD  CONSTRAINT
    [DF__city_state_zip__state_code___1]
        DEFAULT ((1)) FOR [state_code]
GO

ALTER TABLE [dbo].[city_state_zip] ADD  CONSTRAINT
    [DF__city_state_zip__is_active__1]
        DEFAULT ((1)) FOR [is_active]
GO

ALTER TABLE [dbo].[city_state_zip] ADD  CONSTRAINT 
    [DF__city_state_zip__modified__getutcdate]  
        DEFAULT (getutcdate()) FOR [modified]
GO

ALTER TABLE [dbo].[city_state_zip] ADD  CONSTRAINT
    [DF__city_state_zip__created__getutcdate]
        DEFAULT (getutcdate()) FOR [created]
GO

CREATE TRIGGER [dbo].[TR_city_state_zip_delete] ON [dbo].[city_state_zip]
INSTEAD OF DELETE
AS
BEGIN
    SET NOCOUNT ON;
    
    RAISERROR('Delete operations are not allowed on city_state_zip table. Use is_active = 0 to deactivate records.', 16, 1);
    
    SET NOCOUNT OFF;
END;
GO

ALTER TABLE [dbo].[city_state_zip] ENABLE TRIGGER [TR_city_state_zip_delete]
GO

CREATE TRIGGER [dbo].[TR_city_state_zip_update] ON [dbo].[city_state_zip]
FOR UPDATE
AS
BEGIN
    SET NOCOUNT ON;
    
    IF UPDATE(created) OR UPDATE(modified)
    BEGIN
        RAISERROR('Cannot update created or modified columns directly', 16, 1);
        ROLLBACK;
        RETURN;
    END
    
    UPDATE city_state_zip 
    SET modified = GETUTCDATE()
    FROM city_state_zip t
    INNER JOIN inserted i ON t.city_state_zip_id = i.city_state_zip_id;
    
    SET NOCOUNT OFF;
END;
GO

ALTER TABLE [dbo].[city_state_zip] ENABLE TRIGGER [TR_city_state_zip_update]
GO
```

(there is standard code we use to populate the city_state_zip table from USPS)


### Money and Currency
Always use `money` data type for currency:
```sql
budget_amount money NULL,
```

### Hierarchical Data
Self-referencing foreign keys for tree structures:
```sql
parent_account_id uniqueidentifier NULL,
FOREIGN KEY (parent_account_id) REFERENCES account(account_id)
```

### Optional vs Required Fields
- Use `NOT NULL` with defaults for required fields that may be empty
- Use `NULL` for truly optional fields
- Use `DEFAULT ('')` for required text fields that may be blank

## Data Integrity Rules

### Soft Delete Policy
- **Never** allow hard deletes on master data
- Use `is_active = 0` to deactivate records
- Implement delete prevention triggers on all tables

### Audit Trail Requirements
- All tables must track `created` and `modified` timestamps
- Timestamps must be UTC (`getutcdate()`)
- Prevent manual modification of audit fields via triggers

### Referential Integrity
- Always define explicit foreign key constraints
- Nothing cascades
- Index all foreign key columns for performance

## Performance Considerations

### Primary Key Strategy
- Use newsequentialid() with ROWGUIDCOL or newid() with ROWGUIDCOL for all
  primary keys.
- Use newid() when IDs may be exposed externally and predictability is a
  security concern (e.g., tokens, session IDs). Otherwise, use
  newsequentialid().
- Do not use natural keys as primary keys. Only use the ROWGUIDCOL.

### Indexing Strategy
- Index all foreign keys
- Index frequently searched columns (names, dates)
- Consider composite indexes for common query patterns

### Data Types
- Use appropriate precision for datetime2 (7 for audit fields)
- Use varchar for ASCII-only data, nvarchar for Unicode
- Use smallest appropriate data type (smallint vs int vs bigint)

## Examples and Templates

### Data Table Template

```sql
CREATE TABLE {table_name} (
    -- Primary Key is always first:
    {table_name}_id uniqueidentifier ROWGUIDCOL CONSTRAINT df__{table_name}__{table_name}_id__newsequentialid DEFAULT (newsequentialid()) PRIMARY KEY NOT NULL,
    -- Foreign Keys are next, in alphabetical order:
    {table_name}_name nvarchar(50) NOT NULL,
    -- business-specific fields follow:
    -- ...
    -- is_active if the table supports soft delete:
    is_active bit CONSTRAINT df__{table_name}__is_active__1 DEFAULT ((1)) NOT NULL,
    -- modified and created are always the last two fields:
    modified datetime2(7) CONSTRAINT df__{table_name}__modified__getutcdate DEFAULT (getutcdate()) NOT NULL,
    created datetime2(7) CONSTRAINT df__{table_name}__created__getutcdate DEFAULT (getutcdate()) NOT NULL
);
```

For some tables, we might track modified_by and created_by which are foreign keys to `[dbo].[person].[person_id]`. These are always with modified and created.

```sql
    modified_by uniqueidentifier NOT NULL, FOREIGN KEY (modified_by) REFERENCES person(person_id),
    created_by uniqueidentifier NOT NULL, FOREIGN KEY (created_by) REFERENCES person(person_id),
    modified datetime2(7) CONSTRAINT df__{table_name}__modified__getutcdate DEFAULT (getutcdate()) NOT NULL,
    created datetime2(7) CONSTRAINT df__{table_name}__created__getutcdate DEFAULT (getutcdate()) NOT NULL
```

Prevent deleting rows:

```sql
-- Delete prevention trigger
CREATE TRIGGER TR_{table_name}_delete ON dbo.{table_name}
INSTEAD OF DELETE
AS
BEGIN
    SET NOCOUNT ON;
    
    RAISERROR('Delete operations are not allowed on {table_name} table', 16, 1);
    
    SET NOCOUNT OFF;
END;

-- Update audit trigger
CREATE TRIGGER TR_{table_name}_update ON dbo.{table_name}
FOR UPDATE
AS
BEGIN
    SET NOCOUNT ON;
    
    IF UPDATE(created) OR UPDATE(modified) -- OR UPDATE(created_by) OR UPDATE(modified_by) 
    BEGIN
        RAISERROR('Cannot update audit columns directly', 16, 1);
        ROLLBACK;
        RETURN;
    END
    
    UPDATE {table_name} 
    SET modified = GETUTCDATE()
    FROM {table_name} t
    INNER JOIN inserted i ON t.{table_name}_id = i.{table_name}_id;
    
    SET NOCOUNT OFF;
END;

-- Indexes
CREATE NONCLUSTERED INDEX ix_{table_name}_{parent_table}_id ON {table_name} ({parent_table}_id);

```

This guide ensures consistency, maintainability, and performance across all Davis developed database tables.
