# Node.js Lambda API Design Guide
## MSSQL RDS Architecture

**Version**: 5.0
**Stack**: Node.js 24.x, AWS Lambda, MSSQL RDS
**Last Updated**: February 2026

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Project Structure](#project-structure)
3. [Database Access Pattern](#database-access-pattern)
4. [Handler Pattern](#handler-pattern)
5. [Main Lambda Router](#main-lambda-router)
6. [Bitmask Update Pattern](#bitmask-update-pattern)
7. [Error Handling](#error-handling)
8. [Environment Configuration](#environment-configuration)
9. [Lambda Layers](#lambda-layers)
10. [Deployment Process](#deployment-process)
11. [Testing](#testing)
12. [Security Considerations](#security-considerations)
13. [Common Issues and Solutions](#common-issues-and-solutions)

---

## Architecture Overview

### Key Principles

1. **One handler per database table** - Each table gets its own handler file and endpoint
2. **Stored procedures only** - No direct table access; database user in lambda has EXECUTE-only permissions
3. **Stateless Lambda functions** - Connection pooling managed carefully for Lambda lifecycle
4. **Bitmask-controlled updates** - Supports both auto-calculated and explicit field updates
5. **Soft deletes preferred** - Use `is_active` flag where applicable, hard deletes for testing cleanup only

### Request Flow

```
Frontend (S3/CloudFront)
    → Lambda Function URL (HTTPS)
        → Main Router (lambda-function.js)
            → Handler (handlers/{table}.js)
                → Stored Procedure (via mssql layer)
                    → RDS MSSQL Database
                        ← Response
                    ← Result
                ← Formatted Response
            ← JSON Response
        ← HTTP Response (200/400/404/500)
    ← Display/Update UI
```

---

## Project Structure

```
project-root/
│
├── lambda-function.js           # Main router and entry point
├── package.json                 # Dependencies (minimal - layer provides mssql)
│
├── handlers/                    # One handler per table
│   ├── auth.js                  # POST /api/auth/google (Google OAuth → JWT)
│   ├── customer.js
│   ├── invoice.js
│   └── ...
│
├── utils/                       # Shared utilities
│   ├── auth.js                  # Checks tokens and includes bypass for dev
│   ├── db-connection.js         # Connection pooling logic
│   ├── response-formatter.js    # Standard response formatting
│   ├── bitmask-utils.js         # Bitmask calculation and validation
│   └── s3.js                    # S3 file operations (if needed)
│
├── API_DESIGN_GUIDE.md          # This file (or in parent repos/ folder)
├── API_TEST_GUIDE.md            # Standard testing procedure
├── sp_guide.md                  # SQL Stored Procedure Style Guide
├── tables_guide.md              # SQL Tables Style Guide
│
└── rds-config.json              # RDS configuration (if needed)
```

### File Naming Conventions

- **Handlers**: `{table-name}.js` (lowercase, hyphenated if multi-word)
- **Routes**: `/api/{table-name}` or `/api/{table-name}/{id}`
- **Stored Procedures**: `sx_{action}_{table}` (e.g., `sx_get_customer`, `sx_upsert_customer`)

### Field Naming Convention

**snake_case in SQL, camelCase in JavaScript** — but the API response currently returns raw DB column names (snake_case) because there is no conversion layer.

| Context | Convention | Example |
|---------|-----------|---------|
| Database columns | snake_case | `is_active`, `machine_name`, `revoked_at` |
| Stored procedure params | PascalCase with prefix | `@p_IsActive`, `@p_MachineName` |
| Handler FIELDS maps (input) | camelCase | `isActive`, `machineName`, `revokedAt` |
| Request bodies (POST/PUT) | camelCase | `{ "isActive": false, "machineName": "..." }` |
| Response bodies (GET/LIST) | **snake_case** | `{ "is_active": true, "machine_name": "..." }` |

**Why the asymmetry**: Handlers destructure request bodies into camelCase and map them to PascalCase stored procedure parameters. But `GET`/`LIST` responses return `result.recordset` directly from the `mssql` driver, which preserves the DB column names as-is (snake_case). No snake→camel conversion is applied on output.

**Front-end consumers must use snake_case** when reading API response fields (e.g., `record.is_active`, `record.customer_id`).

---

## Database Access Pattern

### Connection Management

Lambda functions are stateless but can reuse connections across invocations within the same container. Use a singleton connection pool pattern.

### SSL/TLS Certificate Validation

Node.js does not use the OS trust store — it bundles Mozilla's CA list, which does not include AWS RDS CA certificates. Without additional configuration, `trustServerCertificate: false` fails with `"unable to verify the first certificate"`.

Starting with Node.js 20, the Lambda runtime includes Amazon CA certificates at `/var/runtime/ca-cert.pem`. Set the `NODE_EXTRA_CA_CERTS` environment variable on the Lambda function to add these to the Node.js trust store:

```
NODE_EXTRA_CA_CERTS=/var/runtime/ca-cert.pem
```

With this environment variable set, the mssql driver can validate the RDS server certificate without any code changes or bundled cert files. The `server` value **must** be the RDS endpoint hostname (not an IP address) — the certificate CN is the endpoint hostname.

**utils/db-connection.js**

```javascript
const sql = require('mssql');

const config = {
    server: process.env.DB_SERVER,
    database: process.env.DB_DATABASE,
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT) || 1433,
    options: {
        encrypt: true,
        trustServerCertificate: false,
        enableArithAbort: true
    },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 }
};

let pool = null;

async function getPool() {
    if (!pool) pool = await sql.connect(config);
    return pool;
}

async function executeStoredProc(procName, params = {}) {
    const pool = await getPool();
    const request = pool.request();
    for (const [name, value] of Object.entries(params)) {
        request.input(name, value);
    }
    const result = await request.execute(procName);
    return result.recordset || [];
}

async function executeStoredProcWithOutput(procName, inputParams = {}, outputParams = {}) {
    const pool = await getPool();
    const request = pool.request();
    for (const [name, value] of Object.entries(inputParams)) {
        request.input(name, value);
    }
    for (const [name, type] of Object.entries(outputParams)) {
        request.output(name, type);
    }
    const result = await request.execute(procName);
    return { recordset: result.recordset || [], output: result.output };
}

module.exports = { getPool, executeStoredProc, executeStoredProcWithOutput, sql };
```

### Stored Procedure Patterns

All database operations must use stored procedures. The database user should have EXECUTE permission only.

**Required Stored Procedures per Table**:

- `sx_get_{table}` - Retrieve single record by ID (PK, UUID)
- `sx_list_{table}` - Retrieve multiple records (with filtering)
- `sx_upsert_{table}` - Insert new or Update existing record (with bitmask)
- `sx_delete_{table}` - Delete, soft delete (set `is_active = 0`) or an error message

See `sp_guide.md` for stored procedure style guide.

---

## Handler Pattern

Each handler file implements CRUD operations for a single table. Handlers are responsible for:

1. Validating request data
2. Calling appropriate stored procedures
3. Formatting responses
4. Handling errors

**handlers/customer.js** (Complete Example)

```javascript
const db = require('../utils/db-connection');
const { successResponse, errorResponse } = require('../utils/response-formatter');
const { calculateBitmask } = require('../utils/bitmask-utils');

// Field definitions for bitmask calculation
const FIELDS = {
    city_state_zip_id: 1, // Bit 0: 2^0 = 1
    customer_name: 2,     // Bit 1: 2^1 = 2
    email: 4,             // Bit 2: 2^2 = 4
    phone: 8,             // Bit 3: 2^3 = 8
    address: 16           // Bit 4: 2^4 = 16
};

async function create(body) {
    try {
        if (!body.customer_name) {
            return errorResponse('customer_name is required', 400);
        }

        const params = {
            customer_name: body.customer_name,
            email: body.email || null,
            phone: body.phone || null,
            address: body.address || null
        };

        const result = await db.executeStoredProc('sx_upsert_customer', params);

        if (result.recordset && result.recordset.length > 0) {
            return successResponse(result.recordset[0], 201);
        }

        return errorResponse('Failed to create customer', 500);
    } catch (error) {
        console.error('Error in customer.create:', error);
        return errorResponse(error.message, 500);
    }
}

async function get(id, queryParams = {}) {
    try {
        const params = {
            customer_id: id,
            includeInactive: queryParams.includeInactive === 'true'
        };

        const result = await db.executeStoredProc('sx_get_customer', params);

        if (result.recordset && result.recordset.length > 0) {
            return successResponse(result.recordset[0]);
        }

        return errorResponse('Customer not found', 404);
    } catch (error) {
        console.error('Error in customer.get:', error);
        return errorResponse(error.message, 500);
    }
}

async function list(queryParams = {}) {
    try {
        const params = {
            includeInactive: queryParams.includeInactive === 'true',
            limit: parseInt(queryParams.limit) || 100,
            offset: parseInt(queryParams.offset) || 0
        };

        const result = await db.executeStoredProc('sx_list_customer', params);

        return successResponse({
            customers: result.recordset || [],
            count: result.recordset.length
        });
    } catch (error) {
        console.error('Error in customer.list:', error);
        return errorResponse(error.message, 500);
    }
}

async function update(id, body) {
    try {
        const params = { customer_id: id };

        if (body.updateFields === undefined) {
            body.updateFields = calculateBitmask(body, FIELDS);
        }

        for (const [field, bit] of Object.entries(FIELDS)) {
            if (body[field] !== undefined) {
                params[field] = body[field];
            }
        }

        params.updateFields = body.updateFields;

        const result = await db.executeStoredProc('sx_upsert_customer', params);

        if (result.recordset && result.recordset.length > 0) {
            return successResponse(result.recordset[0]);
        }

        return errorResponse('Customer not found or update failed', 404);
    } catch (error) {
        console.error('Error in customer.update:', error);
        return errorResponse(error.message, 500);
    }
}

async function remove(id) {
    try {
        const result = await db.executeStoredProc('sx_delete_customer', { customer_id: id });

        if (result.rowsAffected[0] > 0) {
            return successResponse({ message: 'Customer deactivated successfully' });
        }

        return errorResponse('Customer not found', 404);
    } catch (error) {
        console.error('Error in customer.remove:', error);
        return errorResponse(error.message, 500);
    }
}

module.exports = { create, get, list, update, remove };
```

---

## Main Lambda Router

The main entry point routes requests to appropriate handlers based on HTTP method and path. Routes use regex matching for flexibility with sub-resources and named parameters.

**lambda-function.js**

```javascript
const { successResponse, errorResponse } = require('./utils/response-formatter');
const { requireAuth } = require('./utils/auth');
const customer = require('./handlers/customer');
// ... import other handlers

exports.handler = async (event) => {
    console.log('Received event:', JSON.stringify(event, null, 2));

    // Handle CORS preflight
    if (event.requestContext?.http?.method === 'OPTIONS') {
        return {
            statusCode: 200,
            headers: {
                'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*',
                'Access-Control-Allow-Headers': 'Content-Type,Authorization',
                'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
            },
            body: ''
        };
    }

    const method = event.requestContext?.http?.method || event.httpMethod;
    const path = event.rawPath || event.path || '';
    const headers = event.headers || {};
    const queryParams = event.queryStringParameters || {};

    // Parse body (handle base64 encoding)
    let body = {};
    if (event.body) {
        try {
            body = JSON.parse(event.isBase64Encoded
                ? Buffer.from(event.body, 'base64').toString()
                : event.body);
        } catch (e) {}
    }

    try {
        // === PUBLIC ROUTES (no auth required) ===

        if (path === '/' || path === '') {
            return successResponse({ message: 'API OK', version: '1.0.0' });
        }

        if (path === '/health') {
            return successResponse({ status: 'healthy' });
        }

        // Auth endpoints: /api/auth/{action}
        const authMatch = path.match(/^\/api\/auth\/([\w-]+)$/);
        if (authMatch) {
            return handleAuth(method, authMatch[1], body, headers);
        }

        // === PROTECTED ROUTES (auth required) ===
        const authError = requireAuth(headers);
        if (authError) return authError;

        // Customers: /api/customers, /api/customers/:id
        const customerMatch = path.match(/^\/api\/customers(?:\/([a-f0-9-]+))?$/i);
        if (customerMatch) {
            const id = customerMatch[1] || null;
            switch (method) {
                case 'GET':
                    return id
                        ? await customer.get(id, queryParams)
                        : await customer.list(queryParams);
                case 'POST':
                    if (id) return errorResponse('POST does not accept ID in path', 400);
                    return await customer.create(body);
                case 'PUT':
                    if (!id) return errorResponse('PUT requires ID in path', 400);
                    return await customer.update(id, body);
                case 'DELETE':
                    if (!id) return errorResponse('DELETE requires ID in path', 400);
                    return await customer.remove(id);
                default:
                    return errorResponse(`Method not allowed: ${method}`, 405);
            }
        }

        // ... add other routes

        return errorResponse('Route not found', 404);

    } catch (error) {
        console.error('Handler error:', error);
        return errorResponse(error.message, 500);
    }
};
```

---

## Bitmask Update Pattern

### Purpose

Bitmask updates allow precise control over which fields are modified during an UPDATE operation. This prevents unintended field overwrites and supports partial updates.

### How Bitmasks Work

Each updateable field is assigned a bit position (power of 2):

```
Field           Bit Position    Decimal Value
-----------     ------------    -------------
field_1         0               1   (2^0)
field_2         1               2   (2^1)
field_3         2               4   (2^2)
field_4         3               8   (2^3)
field_5         4               16  (2^4)
...
```

To update multiple fields, sum their decimal values:
- Update field_1 and field_3: `1 + 4 = 5`
- Update field_2, field_4, and field_5: `2 + 8 + 16 = 26`

### Two Supported Patterns

#### 1. Auto-Calculated Bitmask (Recommended)

When `updateFields` is not provided, automatically calculate based on which fields have values:

```javascript
// Request (no updateFields specified)
PUT /api/customer/123
{
    "customer_name": "New Name",
    "email": "new@email.com"
}

// Auto-calculates: updateFields = 2 + 4 = 6
// Only updates customer_name and email
```

#### 2. Explicit Bitmask

When `updateFields` is provided, only update fields specified in the bitmask, regardless of which field values are provided:

(This is useful for updating nullable values to null. Pass a null as the parameter, and then specify that the field is updated via bitmask.)

```javascript
// Request (explicit updateFields)
PUT /api/customer/123
{
    "customer_name": "New Name",
    "email": "new@email.com",
    "phone": "555-1234",
    "updateFields": 2  // Only bit 1 set, customer_name
}

// Only updates customer_name
// email and phone values are ignored
```

### Bitmask Utility Functions

**utils/bitmask-utils.js**

```javascript
function calculateBitmask(data, fieldMap) {
    let bitmask = 0;
    for (const [fieldName, bitValue] of Object.entries(fieldMap)) {
        if (data[fieldName] !== undefined && data[fieldName] !== null) {
            bitmask |= bitValue;
        }
    }
    return bitmask;
}

function getFieldsFromBitmask(bitmask, fieldMap) {
    const fieldsToUpdate = [];
    for (const [fieldName, bitValue] of Object.entries(fieldMap)) {
        if (bitmask & bitValue) {
            fieldsToUpdate.push(fieldName);
        }
    }
    return fieldsToUpdate;
}

function isFieldIncluded(bitmask, fieldBit) {
    return (bitmask & fieldBit) !== 0;
}

module.exports = { calculateBitmask, getFieldsFromBitmask, isFieldIncluded };
```

### Testing Bitmask Updates

See `API_TEST_GUIDE.md` for comprehensive testing steps:

- **Step 3-4**: Auto-calculated bitmask update (no updateFields provided)
- **Step 5-6**: Explicit selective update (updateFields targets one field)
- **Step 7-8**: Multiple field bitmask (updateFields targets multiple fields)

**Key Validation**: Only fields specified in the bitmask should change, regardless of which field values are provided in the request body.

---

## Error Handling

### Standard Response Format

**utils/response-formatter.js**

```javascript
function successResponse(data, statusCode = 200) {
    return {
        statusCode,
        body: { success: true, data }
    };
}

function errorResponse(message, statusCode = 500, details = null) {
    const response = {
        statusCode,
        body: { success: false, error: message }
    };
    if (details && process.env.NODE_ENV !== 'production') {
        response.body.details = details;
    }
    return response;
}

function notFoundResponse(resourceName = 'Resource') {
    return errorResponse(`${resourceName} not found`, 404);
}

module.exports = { successResponse, errorResponse, notFoundResponse };
```

### Error Categories

| Status Code | Meaning | When to Use |
|-------------|---------|-------------|
| 200 | OK | Successful GET, PUT, DELETE |
| 201 | Created | Successful POST (resource created) |
| 400 | Bad Request | Invalid request data, missing required fields |
| 404 | Not Found | Resource doesn't exist or is inactive |
| 405 | Method Not Allowed | Unsupported HTTP method |
| 500 | Internal Server Error | Database errors, unhandled exceptions |

### Try-Catch Pattern

Always wrap handler logic in try-catch blocks:

```javascript
async function handlerFunction(params) {
    try {
        const result = await db.executeStoredProc(...);
        return successResponse(result);
    } catch (error) {
        console.error('Error in handlerFunction:', error);
        return errorResponse(error.message, 500);
    }
}
```

---

## Environment Configuration

### Required Environment Variables

Set these in Lambda function configuration:

```bash
# Database connection
DB_SERVER=your-rds-endpoint.region.rds.amazonaws.com
DB_DATABASE=your_database_name
DB_USERNAME=lambda_user
DB_PASSWORD=your_secure_password
DB_PORT=1433

# SSL/TLS certificate validation (required for Node.js 20+)
NODE_EXTRA_CA_CERTS=/var/runtime/ca-cert.pem

# Environment identifier (dev, test, or prod)
# CRITICAL: Auth bypass codes (e.g. "Bearer Development") check this variable.
# Never rely on function names to determine environment — always use ENV.
ENV=dev

# JWT authentication (if applicable)
JWT_SECRET=random-secure-string
JWT_EXPIRY=24h  # optional, defaults to 24h

# Google OAuth (if using Google sign-in)
GOOGLE_CLIENT_ID=xxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxx

# CORS
ALLOWED_ORIGIN=*  # restrict to specific domain in production
```

### Security Best Practices

1. **Never commit passwords** - Use environment variables or AWS Secrets Manager
2. **Least privilege** - Database user should only have EXECUTE permissions
3. **Encrypted connections** - Set `NODE_EXTRA_CA_CERTS` and use `trustServerCertificate: false` to validate the RDS server certificate
4. **Secrets rotation** - Implement password rotation for production

---

## Lambda Layers

**Dependencies go in Lambda Layers, NOT in the deployment zip.**

### Why Layers?

- `node_modules` can be huge (mssql alone is ~15MB with Azure deps)
- Dependencies rarely change; code changes frequently
- Deploying just code = 5-50KB vs 15MB+ with deps
- Faster deployments, lower transfer costs

### Existing Layers (us-east-1, account 478351749133)

| Layer                | Version | Description                              | Runtimes   |
|----------------------|---------|------------------------------------------|------------|
| `mssql-layer`        | 2       | SQL Server connectivity (mssql, tedious) | nodejs24.x |
| `jsonwebtoken-layer` | 1       | JWT auth (jsonwebtoken)                  | nodejs24.x |

### Creating a New Layer

```bash
# 1. Create layer directory structure
mkdir -p /tmp/my-layer/nodejs
cd /tmp/my-layer/nodejs

# 2. Initialize and install ONLY the packages needed
npm init -y
npm install <package-name>

# 3. Zip the layer (must contain nodejs/node_modules/)
cd /tmp/my-layer
zip -r /tmp/my-layer.zip nodejs

# 4. Publish to AWS
aws lambda publish-layer-version \
  --layer-name my-layer \
  --description "Description of layer" \
  --zip-file fileb:///tmp/my-layer.zip \
  --compatible-runtimes nodejs24.x \
  --region us-east-1
```

### Attaching Layers to a Function

```bash
aws lambda update-function-configuration \
  --function-name my-function \
  --layers arn:aws:lambda:us-east-1:478351749133:layer:mssql-layer:2 \
           arn:aws:lambda:us-east-1:478351749133:layer:jsonwebtoken-layer:1 \
  --region us-east-1
```

---

## Deployment Process

### Prerequisites

1. **RDS Configuration**: RDS endpoint and credentials available
2. **MSSQL Layer**: Lambda layer with mssql package
3. **Database Setup**: Tables, stored procedures, and SQL user created

### Deploying Code Only

```bash
# From the lambda/ directory
zip -r /tmp/lambda-code.zip . -x "node_modules/*" -x "*.git*" -x "package-lock.json" -x "*.md"

# Deploy (typically ~5-50KB)
aws lambda update-function-code \
  --function-name my-function \
  --zip-file fileb:///tmp/lambda-code.zip \
  --region us-east-1
```

### Quick Reference Commands

```bash
# Deploy code only
cd lambda
zip -r /tmp/code.zip . -x "node_modules/*"
aws lambda update-function-code --function-name my-func --zip-file fileb:///tmp/code.zip

# View function config
aws lambda get-function-configuration --function-name my-func

# Update environment variables
aws lambda update-function-configuration --function-name my-func \
  --environment "Variables={KEY1=val1,KEY2=val2}"

# Attach layers
aws lambda update-function-configuration --function-name my-func \
  --layers arn:aws:lambda:us-east-1:478351749133:layer:mssql-layer:2

# Test function URL
curl https://xxxxxxx.lambda-url.us-east-1.on.aws/
```

### Making a Function URL Public (Auth Type NONE)

The AWS CLI's `add-permission` command only adds **one** of the two required statements. You must run both commands or the URL will return `403 Forbidden`:

```bash
# Statement 1: allow invocation via the URL
aws lambda add-permission \
  --function-name my-func \
  --statement-id FunctionURLAllowPublicAccess \
  --action lambda:InvokeFunctionUrl \
  --principal "*" \
  --function-url-auth-type NONE \
  --region us-east-1

# Statement 2: allow the function itself to execute when called via URL
aws lambda add-permission \
  --function-name my-func \
  --statement-id FunctionURLInvokePublicAccess \
  --action lambda:InvokeFunction \
  --principal "*" \
  --invoked-via-function-url \
  --region us-east-1
```

The AWS Console and SAM add both automatically. The CLI does not.

### Function URL CORS — Do NOT Enable

When creating a Lambda Function URL, **do not configure CORS on the Function URL itself** (pass `--cors '{}'` or omit it entirely). Our Lambda code already sets `Access-Control-Allow-Origin` and other CORS headers in `response-formatter.js` and handles `OPTIONS` preflight in `lambda-function.js`.

If the Function URL also has CORS enabled, AWS adds its own `Access-Control-Allow-Origin` header **in addition to** the one from our Lambda response. Browsers reject responses with duplicate `Access-Control-Allow-Origin` values, causing all cross-origin requests to fail with:

> *The 'Access-Control-Allow-Origin' header contains multiple values, but only one is allowed.*

```bash
# CORRECT: no CORS on Function URL (Lambda handles it)
aws lambda create-function-url-config \
  --function-name my-func \
  --auth-type NONE

# WRONG: this causes duplicate CORS headers
aws lambda create-function-url-config \
  --function-name my-func \
  --auth-type NONE \
  --cors '{"AllowOrigins":["*"],"AllowMethods":["*"],"AllowHeaders":["*"]}'

# FIX: if CORS was already enabled, remove it
aws lambda update-function-url-config \
  --function-name my-func \
  --auth-type NONE \
  --cors '{}'
```

### Deployment Checklist

- [ ] RDS database is accessible (test connection)
- [ ] All stored procedures are created
- [ ] SQL user has EXECUTE-only permissions
- [ ] Lambda layers attached (mssql-layer, jsonwebtoken-layer)
- [ ] All handler files are in handlers/ directory
- [ ] lambda-function.js routes all resources correctly
- [ ] Environment variables are set (DB_SERVER, DB_DATABASE, etc.)
- [ ] Health endpoint returns 200 OK
- [ ] If Function URL is public (auth type NONE): both resource policy statements added (InvokeFunctionUrl + InvokeFunction)

---

## Testing

Testing is performed **concurrently with development**. For each table/handler:

1. Write the handler code
2. Create or verify stored procedures exist
3. Immediately test using the standard procedure in API_TEST_GUIDE.md
4. Fix any issues before moving to next table

**See `API_TEST_GUIDE.md` for the complete 15-step CRUD testing procedure**, including:

- CRUD operations (POST, GET, PUT, DELETE)
- Bitmask update testing (auto-calculated and explicit)
- Soft delete and hard delete cleanup
- Validation points and cleanup requirements

### Connecting to RDS from CLI (sqlcmd)

```bash
sqlcmd \
  -S my-sqlserver-db.xxxxx.us-east-1.rds.amazonaws.com \
  -U admin \
  -P mypassword \
  -d my_database \
  -C \
  -Q "SELECT 1"
```

**Important**: Use `-P password` with a space, not `-P "password"` or `-P 'password'`. The password should follow directly after `-P` with just a space separator.

---

## Security Considerations

### Database Security

1. **Principle of Least Privilege**
   - Lambda database user: EXECUTE-only permissions
   - No SELECT, INSERT, UPDATE, DELETE on tables
   - All operations via stored procedures

```sql
-- Create limited user
CREATE LOGIN lambda_user_{environment} WITH PASSWORD = '{SecurePassword}';
CREATE USER lambda_user_{environment} FOR LOGIN lambda_user_{environment};

-- Grant execute only
GRANT EXECUTE TO lambda_user_{environment};

-- Verify permissions
SELECT * FROM sys.database_permissions
WHERE grantee_principal_id = USER_ID('lambda_user_{environment}');
```

2. **Encrypted Connections**
   - Always use SSL/TLS
   - Validate RDS CA certificate via `NODE_EXTRA_CA_CERTS`

3. **SQL Injection Prevention**
   - Use parameterized stored procedures only
   - Never concatenate SQL strings
   - Validate input data types

### Lambda Security

1. **IAM Roles**
   - Separate execution role per Lambda function
   - Minimum required policies:
     - `AWSLambdaBasicExecutionRole` (CloudWatch logs)

2. **Environment Variables**
   - Encrypt sensitive values at rest
   - AWS Secrets Manager for production
   - Rotate credentials regularly

### API Security

1. **CORS Configuration**
   - Development: `ALLOWED_ORIGIN=*`
   - Production: Restrict to specific domain

2. **Authentication**
   - Google OAuth → HMAC-SHA256 JWT (24h expiry)
   - Dev bypass: `Bearer Development` token accepted when `ENV=dev`

3. **Rate Limiting**
   - Use AWS WAF for DDoS protection if needed

---

## Common Issues and Solutions

### Issue: "Cannot find module 'mssql'"

**Cause**: MSSQL layer not attached or incorrect layer ARN

**Solution**:
```bash
aws lambda get-function-configuration --function-name my-func --query 'Layers'
aws lambda update-function-configuration --function-name my-func \
  --layers arn:aws:lambda:us-east-1:478351749133:layer:mssql-layer:2
```

### Issue: "Connection timeout" or "Cannot connect to database"

**Cause**: VPC/security group misconfiguration

**Solution**:
1. Verify RDS security group allows inbound on port 1433
2. Check Lambda is in same VPC as RDS (if RDS is private)
3. Verify subnets have route to RDS

### Issue: "Login failed for user"

**Cause**: User doesn't exist or wrong password

**Solution**:
```sql
SELECT name FROM sys.database_principals WHERE name = 'lambda_user_{environment}';
ALTER LOGIN lambda_user_{environment} WITH PASSWORD = 'NewSecurePassword';
```

Then update the Lambda environment variable.

### Issue: "Could not find stored procedure"

**Cause**: Stored procedure not created or wrong schema

**Solution**:
```sql
SELECT name FROM sys.procedures ORDER BY name;
```

### Issue: Bitmask updates not working correctly

**Cause**: Stored procedure not checking bitmask properly

**Solution**: Verify the CASE WHEN pattern in the stored procedure:
```sql
UPDATE table_name
SET
    field1 = CASE WHEN @updateFields & 1 = 1 THEN @field1 ELSE field1 END,
    field2 = CASE WHEN @updateFields & 2 = 2 THEN @field2 ELSE field2 END,
    ...
```

---

## Appendix

### Field Bitmask Reference Table

```
Bit Position  | Decimal Value | Binary      | Typical Usage
------------- | ------------- | ----------- | -------------
0             | 1             | 00000001    | First field
1             | 2             | 00000010    | Second field
2             | 4             | 00000100    | Third field
3             | 8             | 00001000    | Fourth field
4             | 16            | 00010000    | Fifth field
5             | 32            | 00100000    | Sixth field
6             | 64            | 01000000    | Seventh field
7             | 128           | 10000000    | Eighth field

Combinations:
bits 0+1      | 3             | 00000011    | First two fields
bits 0+2      | 5             | 00000101    | First and third
bits 0+1+2    | 7             | 00000111    | First three fields
```

### HTTP Status Code Quick Reference

```
2xx - Success
200 - OK (GET, PUT, DELETE succeeded)
201 - Created (POST succeeded)

4xx - Client Error
400 - Bad Request (invalid data)
404 - Not Found (resource doesn't exist)
405 - Method Not Allowed (wrong HTTP verb)

5xx - Server Error
500 - Internal Server Error (database/code error)
```

---

**Document Version**: 5.0
**Last Updated**: February 28, 2026
**Maintained By**: Jeremy Mitts / Davis Nexus, LLC
