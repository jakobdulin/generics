# API Object Testing Procedure

## Standard CRUD Testing Steps

### 1. POST (Create)
Create new record with all required fields
- **Expected**: Success response with new record ID and complete record data

### 2. GET (Retrieve)
Retrieve the created record by ID
- **Expected**: Success response with all field values matching creation data

### 3. PUT (Auto-calculated Bitmask Update)
Update multiple fields without explicit bitmask
- **Expected**: Success response, all provided fields should be updated
- API should auto-calculate bitmask based on which fields are provided

### 4. GET (Verify Auto-update)
Verify auto-calculated bitmask update worked
- **Expected**: All updated fields should show new values

### 5. PUT (Explicit Bitmask Selective Update)
Provide multiple field values but only update specific fields via explicit bitmask
- Provide values for multiple fields but set updateFields to target only one field (e.g., bit 1)
- **Expected**: Only the field specified in bitmask should change, other fields stay unchanged despite values being provided

### 6. GET (Verify Selective Update)
Verify explicit bitmask selective update worked
- **Expected**: Only the bitmask-specified field changed, others unchanged

### 7. PUT (Multiple Field Bitmask)
Test updating multiple specific fields via bitmask combination
- Provide values for all fields but set updateFields to target multiple specific fields (e.g., bits 4+8=12)
- **Expected**: Only the fields specified in bitmask combination should change

### 8. GET (Verify Multiple Field Update)
Verify multiple field bitmask update worked
- **Expected**: Only the bitmask-specified fields changed, others unchanged

## Soft Delete Testing Steps

### 9. DELETE (Soft Delete)
Deactivate record (sets is_active=0)
- **Expected**: Success response indicating record was deactivated
- **Note**: For tables without is_active field, this becomes hard delete

### 10. GET (Verify Soft Delete)
Try to retrieve deactivated record
- **Expected**: 404 error - record not found or inactive

### 11. GET with includeInactive
Retrieve deactivated record with includeInactive=true
- **Expected**: Success response with is_active=false
- **Note**: Skip this step for tables without is_active field (hard delete only)

## Hard Delete Cleanup Steps

### 12. Disable Delete Trigger
Use sqlcmd to disable database delete trigger
- **Command**: `ALTER TABLE [table_name] DISABLE TRIGGER [trigger_name]`
- **Expected**: Trigger disabled successfully

### 13. Hard Delete Record
Use sqlcmd to physically remove test record from database
- **Command**: `DELETE FROM [table_name] WHERE [primary_key] = '[test_id]'`
- **Expected**: Test record deleted successfully

### 14. Re-enable Delete Trigger
Use sqlcmd to re-enable database delete trigger
- **Command**: `ALTER TABLE [table_name] ENABLE TRIGGER [trigger_name]`
- **Expected**: Trigger re-enabled successfully

### 15. Final Verification
Test GET with includeInactive to confirm hard delete
- **Expected**: 404 error - record completely removed from database

## Key Validation Points

### Bitmask Functionality
- Only fields specified in bitmask are updated, regardless of other field values provided
- Support both auto-calculated bitmasks (when updateFields not provided)
- Support explicit bitmask control (when updateFields parameter provided)

### Business Rules
- Validate any special business logic (e.g., cannot delete closed periods)
- Test edge cases and constraint validations

### Soft Delete
- Proper deactivation with is_active=0 where applicable
- Records accessible only with includeInactive=true flag when deactivated

### Hard Delete
- Complete removal with proper trigger manipulation for cleanup
- No test data left behind after testing

### Cleanup Requirements
- All test records must be properly cleaned up
- Database triggers must be restored to original state
- No orphaned test data should remain

## Bitmask Pattern Requirements

The API must support both patterns:
1. **Auto-calculated**: When no updateFields provided, calculate bitmask from provided field values
2. **Explicit**: When updateFields provided, only update fields specified in bitmask regardless of other field values

**Core Rule**: Only validate and update fields specified in the bitmask. Ignore field values for fields not included in bitmask.

**Auth Token Bypass in Dev** - Use "Bearer Development" to bypass authorization for testing in the development environment.
