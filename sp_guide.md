\# Stored Procedure Development Guidelines



\## 1. Naming Convention



\### Base Format

`sx\_\[action]\_\[table]\_\[modifier(s)]`



\### Action Prefixes

\- \*\*sx\_get\_\*\* - SELECT operations (single record or filtered sets)

\- \*\*sx\_list\_\*\* - SELECT operations (multiple records, typically with paging)

\- \*\*sx\_upsert\_\*\* - INSERT or UPDATE operations (required for all data modifications)

\- \*\*sx\_delete\_\*\* - DELETE operations (soft delete via flags)

\- \*\*sx\_validate\_\*\* - Validation operations

\- \*\*sx\_calculate\_\*\* - Calculation operations

\- \*\*sx\_process\_\*\* - Complex business logic operations

\- \*\*sx\_report\_\*\* - Reporting operations

\- \*\*sx\_reconcile\_\*\* - Reconciliation operations



\### Table Names

\- Use singular table name exactly as defined in schema

\- For operations spanning multiple tables, use primary table name



\### Modifiers (Optional)

\- \*\*\_by\_\[field]\*\* - Operations filtered by specific field

\- \*\*\_active\*\* - Operations limited to active records

\- \*\*\_summary\*\* - Aggregated/summarized data

\- \*\*\_detail\*\* - Detailed information including related tables

\- \*\*\_paged\*\* - Paginated results

\- \*\*\_batch\*\* - Batch operations

\- \*\*\_range\*\* - Date or number range operations

\- \*\*\_with\_\[entity]\*\* - Operations that include related entities (e.g., `\_with\_multi\_line`, `\_with\_detail`)



\### Examples

```sql

sx\_get\_Account\_by\_AccountNumber

sx\_list\_Invoice\_by\_Entity\_active\_paged

sx\_upsert\_TransactionHeader\_with\_detail

sx\_upsert\_CustomerBalance\_summary

sx\_calculate\_CustomerAging\_range

sx\_process\_Invoice\_post\_batch

sx\_report\_TrialBalance\_by\_period

sx\_reconcile\_CustomerSubsidiaryLedger\_summary

sx\_upsert\_journal\_entry\_with\_lines

sx\_upsert\_customer

sx\_delete\_account\_type

```



\## 2. Parameter Naming Convention



\### Input Parameters

\- \*\*@p\_\[FieldName]\*\* - Single field parameters

\- \*\*@p\_\[TableName]RecordId\*\* - Primary key parameters

\- \*\*@p\_StartDate\*\* / \*\*@p\_EndDate\*\* - Date range parameters

\- \*\*@p\_PageNumber\*\* / \*\*@p\_PageSize\*\* - Paging parameters

\- \*\*@p\_SortBy\*\* / \*\*@p\_SortDirection\*\* - Sorting parameters

\- \*\*@p\_FilterBy\*\* - Generic filter parameters

\- \*\*@p\_IncludeInactive\*\* - Boolean flags

\- \*\*@p\_UpdateFields\*\* - Bitmask parameters for selective updates



\### Output Parameters

\- \*\*@o\_RecordCount\*\* - Number of records affected/returned

\- \*\*@o\_ErrorMessage\*\* - Error message text

\- \*\*@o\_IsSuccess\*\* - Success/failure indicator

\- \*\*@o\_NewRecordId\*\* - Newly created record ID



\### Table-Valued Parameters

\- \*\*@p\_\[EntityName]\*\* - Collection of entities (e.g., `@p\_JournalLine`)

\- Use descriptive table type names ending in "TableType"



\### Examples

```sql

sx\_get\_Account\_by\_AccountNumber(

&nbsp;   @p\_AccountNumber NVARCHAR(20),

&nbsp;   @p\_IncludeInactive BIT = 0

)



sx\_upsert\_Invoice\_by\_Entity\_active\_paged(

&nbsp;   @p\_EntityRecordId UNIQUEIDENTIFIER,

&nbsp;   @p\_StartDate DATE = NULL,

&nbsp;   @p\_EndDate DATE = NULL,

&nbsp;   @p\_PageNumber INT = 1,

&nbsp;   @p\_PageSize INT = 50,

&nbsp;   @p\_SortBy NVARCHAR(50) = 'InvoiceDate',

&nbsp;   @p\_SortDirection NVARCHAR(4) = 'DESC',

&nbsp;   @o\_RecordCount INT OUTPUT

)



sx\_upsert\_customer(

&nbsp;   @p\_CustomerId UNIQUEIDENTIFIER = NULL,

&nbsp;   @p\_CompanyName NVARCHAR(255) = NULL,

&nbsp;   @p\_UpdateFields INT,

&nbsp;   @o\_IsSuccess BIT OUTPUT,

&nbsp;   @o\_ErrorMessage NVARCHAR(255) OUTPUT

)

```



\## 3. Standard Structure Template



\### Required Elements

1\. \*\*Header Comment Block\*\*

2\. \*\*Parameter Validation\*\*

3\. \*\*Error Handling\*\*

4\. \*\*Transaction Management\*\*

5\. \*\*Consistent Return Values\*\*

6\. \*\*Logging/Auditing\*\*



\### Template Structure

```sql

/\*

=============================================================================

Procedure: sx\_\[action]\_\[table]\_\[modifier]

Purpose: \[Brief description of what the procedure does]

Author: \[Developer Name]

Created: \[Date]

Modified: \[Date] - \[Modification description]



Parameters:

&nbsp;   @p\_Parameter1 - Description

&nbsp;   @p\_Parameter2 - Description

&nbsp;   @o\_OutputParam - Description



Returns:

&nbsp;   Result set or success/error indicator



Business Rules:

&nbsp;   - \[List key business rules enforced]

&nbsp;   - \[Any special conditions or requirements]



Example Usage:

&nbsp;   EXEC sx\_\[action]\_\[table]\_\[modifier] 

&nbsp;       @p\_Parameter1 = 'Value1',

&nbsp;       @p\_Parameter2 = 'Value2'

=============================================================================

\*/

```



\## 4. Standard Practices



\### Error Handling

\- Use TRY/CATCH blocks for all procedures

\- Return standardized error codes

\- Log errors to audit table

\- Rollback transactions on error

\- Return meaningful error messages



\### Transaction Management

\- Use explicit transactions for data modifications

\- Set appropriate isolation levels

\- Handle deadlocks gracefully

\- Keep transactions as short as possible



\### Performance Guidelines

\- Always specify column names in SELECT statements

\- Use appropriate indexes (document index requirements)

\- Avoid SELECT \* in production procedures

\- Use SET NOCOUNT ON

\- Consider query execution plans



\### Security

\- **No dynamic SQL** — never use `EXEC()`, `sp_executesql`, or string-built queries. Use static SQL with `CASE` expressions for conditional logic (e.g., dynamic sort columns). Dynamic SQL breaks ownership chaining and requires direct table permissions.

\- Validate all input parameters

\- Implement appropriate permission checks

\- Log security-relevant operations



\## 5. Return Value Standards



\### Success Indicators

\- \*\*0\*\* - Success

\- \*\*1\*\* - Warning (operation completed with warnings)

\- \*\*-1\*\* - Error (operation failed)



\### Result Sets

\- Always return consistent column names

\- Include metadata columns (Created, Modified) when relevant

\- Use consistent data types

\- Document expected result set structure



\### Paging Standards

\- Use OFFSET/FETCH for pagination

\- Always include total record count

\- Provide consistent paging parameters

\- Handle edge cases (invalid page numbers)



\## 6. CRUD Operation Patterns



\### Upsert Operations (sx\_upsert\_\*)

\- \*\*Primary data modification pattern\*\* - handles both insert and update scenarios

\- Support both insert and selective update scenarios

\- Use bitmask parameters for selective field updates

\- For inserts: ignore bitmask, validate required fields only

\- For updates: respect bitmask, update only specified fields

\- Always return complete current record state

\- Validate all required fields for new records

\- Check for duplicate violations

\- Generate new UNIQUEIDENTIFIER for primary keys on inserts

\- Return the record ID via output parameter

\- Return success/error status



\### Read Operations (sx\_get\_\*, sx\_list\_\*)

\- Support filtering by common fields

\- Include paging for list operations

\- Support sorting options

\- Handle inactive records appropriately



\### Delete Operations (sx\_delete\_\*)

\- \*\*Always perform soft deletes\*\* by setting is\_active = 0

\- Validate no dependent records exist

\- Check referential integrity before deletion

\- Physical deletes are prevented by database triggers



\## 7. Advanced Patterns



\### Table-Valued Parameters

For procedures handling multiple related records:



```sql

-- Create custom table type

CREATE TYPE JournalEntryLineTableType AS TABLE (

&nbsp;   account\_id UNIQUEIDENTIFIER NOT NULL,

&nbsp;   debit\_amount DECIMAL(19,2) NULL,

&nbsp;   credit\_amount DECIMAL(19,2) NULL,

&nbsp;   description NVARCHAR(255) NULL

);



-- Use in procedure

CREATE PROCEDURE sx\_upsert\_journal\_entry\_with\_multi\_line

&nbsp;   @p\_JournalLine JournalEntryLineTableType READONLY

```



\### Bitmask Field Updates

For selective field updates in upsert operations:



```sql

-- Field bitmask values

-- company\_name = 1, contact\_name = 2, email = 4, phone = 8, etc.



-- Update logic using bitwise operations

UPDATE customer 

SET 

&nbsp;   company\_name = CASE 

&nbsp;       WHEN (@p\_UpdateFields \& 1) = 1 THEN @p\_CompanyName

&nbsp;       ELSE company\_name 

&nbsp;   END,

&nbsp;   contact\_name = CASE 

&nbsp;       WHEN (@p\_UpdateFields \& 2) = 2 THEN @p\_ContactName

&nbsp;       ELSE contact\_name 

&nbsp;   END

WHERE customer\_id = @p\_CustomerId;

```



\### Complex Business Logic Validation

For multi-table operations requiring validation:



```sql

-- Validate journal entry is balanced

DECLARE @TotalDebits DECIMAL(19,2) = (SELECT SUM(ISNULL(debit\_amount, 0)) FROM @p\_JournalLines);

DECLARE @TotalCredits DECIMAL(19,2) = (SELECT SUM(ISNULL(credit\_amount, 0)) FROM @p\_JournalLines);



IF @TotalDebits != @TotalCredits

BEGIN

&nbsp;   SET @o\_ErrorMessage = 'Journal entry is not balanced';

&nbsp;   RETURN -1;

END

```



\## 8. Documentation Requirements



\### Inline Comments

\- Document complex business logic

\- Explain non-obvious calculations

\- Note any workarounds or special handling

\- Reference related procedures or dependencies



\### Change Management

\- Update modification history in header

\- Document breaking changes

\- Maintain backward compatibility when possible

\- Version control integration



\## 9. Testing Standards



\### Unit Testing

\- Test all parameter combinations

\- Test boundary conditions

\- Test error scenarios

\- Verify transaction rollback behavior



\### Integration Testing

\- Test with related procedures

\- Verify data consistency

\- Test concurrent access scenarios

\- Performance testing under load



\## 10. Business Logic Categories



\### CRUD Operations

\- Standard create, read, update, delete patterns

\- Consistent parameter validation

\- Standardized error handling

\- Audit trail maintenance



\### Accounting-Specific Operations

\- \*\*Posting\*\*: Journal entry creation and posting

\- \*\*Reconciliation\*\*: Balance verification procedures

\- \*\*Reporting\*\*: Financial statement generation

\- \*\*Period Close\*\*: Month/year-end processing

\- \*\*Budgeting\*\*: Budget creation and comparison



\### Validation Procedures

\- \*\*sx\_validate\_TransactionHeader\_balanced\*\* - Ensure debits equal credits

\- \*\*sx\_validate\_Account\_usage\*\* - Check if account can be modified

\- \*\*sx\_validate\_Period\_open\*\* - Verify period is open for transactions



\## 11. Performance Considerations



\### Indexing Strategy

\- Document required indexes for each procedure

\- Consider covering indexes for frequently used procedures

\- Monitor query execution plans

\- Regular index maintenance procedures



\### Caching Strategy

\- Cache reference data appropriately

\- Prefer Common Table Expressions (CTEs) over table variables as they generally provide better performance

\- Table variables may be used for simplicity when the performance cost has been evaluated and found to be negligible

\- Consider result set caching for reports

\- Monitor memory usage patterns



\## 12. Deployment and Versioning



\### Version Control

\- Include procedure version in header comments

\- Tag major changes with version numbers

\- Maintain deployment scripts

\- Document dependencies between procedures



\### Deployment Process

\- Test in development environment first

\- Validate against production data volumes

\- Plan rollback procedures

\- Schedule during maintenance windows



\## 13. Special Accounting Considerations



\### Double-Entry Enforcement

\- Procedures for financial transactions must insert both sides of the transaction as a single SQL transaction that either completely succeeds or fails

\- Automatic reversal procedures for corrections

\- Audit trail preservation for all financial transactions

\- Balance validation for all journal entries



\### Period Controls

\- Validate transactions against open periods

\- Prevent modifications to closed periods

\- Handle period-end adjustments appropriately



\### Regulatory Compliance

\- Maintain complete audit trails

\- Ensure data immutability where required

\- Support regulatory reporting requirements

\- Document compliance controls



\### Soft Delete Requirements

\- All tables use is\_active flags for logical deletion

\- Physical deletes are prevented by database triggers

\- Delete procedures must validate referential integrity

\- Preserve audit trails by preventing deletion of records with financial history



\## 14. Data Integrity Patterns



\### Referential Integrity Validation

```sql

-- Validate foreign key relationships

IF NOT EXISTS (SELECT 1 FROM account WHERE account\_id = @p\_AccountId AND is\_active = 1)

BEGIN

&nbsp;   SET @o\_ErrorMessage = 'Invalid or inactive account specified';

&nbsp;   RETURN -1;

END

```



\### Hierarchical Data Validation

```sql

-- Prevent circular references in parent-child relationships

-- Check for active child records before deletion

IF EXISTS (SELECT 1 FROM account WHERE parent\_account\_id = @p\_AccountId AND is\_active = 1)

BEGIN

&nbsp;   SET @o\_ErrorMessage = 'Cannot delete account that has active child accounts';

&nbsp;   RETURN -1;

END

```



\### Audit Trail Preservation

```sql

-- Check for transaction history before allowing deletion

IF EXISTS (SELECT 1 FROM journal\_entry\_line WHERE account\_id = @p\_AccountId)

BEGIN

&nbsp;   SET @o\_ErrorMessage = 'Cannot delete account that has journal entry transactions';

&nbsp;   RETURN -1;

END

```

