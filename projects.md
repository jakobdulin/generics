# Project Architecture

## Three-Layer Stack

```
React SPA  →  AWS Lambda (Function URL)  →  SQL Server (RDS)
   UI              API (no gateway)            Database
```

- **Database**: SQL Server on AWS RDS. All data access through stored procedures — no inline SQL, no dynamic SQL, no ORM.
- **API**: Node.js Lambda functions exposed via Function URLs (no API Gateway). Each Lambda handles routing internally. Deployed as zip via CI/CD or `deploy.sh`.
- **UI**: React single-page app served from S3 + CloudFront. Calls Lambda Function URLs directly.

## Folder Structure

```
project/
├── .github/workflows/ci-cd.yml   # CI/CD pipeline
├── .gitignore
├── lambda/                        # Lambda source (deployed as zip)
│   ├── lambda-function.js         # Main handler + router
│   ├── handlers/                  # Route handlers
│   ├── utils/                     # Shared utilities (db connection, auth)
│   ├── eslint.config.js           # ESLint v9 flat config
│   └── package.json               # Dependencies + devDeps
├── SQL/                           # Database objects
│   ├── TABLES/                    # One .sql file per table
│   ├── STORED_PROCEDURES/         # One .sql file per procedure
│   ├── TYPES/                     # User-defined types
│   ├── VIEWS/                     # Views
│   ├── INDEXES/                   # Index definitions
│   ├── TABLES/TRIGGERS/           # One .sql file per table's triggers
│   ├── script_all_*.sh            # Export DDL from database
│   └── deploy_*.sh                # Deploy SQL to database
├── TEST/                          # Integration tests
├── deploy.sh                      # Manual Lambda deploy script
└── index.html / www-app/          # UI (if applicable)
```

## Database Credentials

### Admin Password (for SQL scripting/deploy tools)

Stored in AWS Secrets Manager as `rds-admin-password`. Shell scripts retrieve it at runtime:

```bash
PASSWORD=$(aws secretsmanager get-secret-value \
  --secret-id rds-admin-password \
  --query SecretString --output text \
  --region us-east-1)
```

No database passwords are stored in environment variables, files, or source code.

### Lambda Database Passwords (for API runtime)

Each Lambda environment (dev/test/prod) has its own limited database user. Passwords are stored in Secrets Manager and retrieved in Node.js at cold start using the AWS SDK:

```javascript
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");

const client = new SecretsManagerClient({ region: "us-east-1" });

let cachedPassword;
async function getDbPassword() {
  if (cachedPassword) return cachedPassword;
  const resp = await client.send(
    new GetSecretValueCommand({ SecretId: "project-name-db-password" })
  );
  cachedPassword = resp.SecretString;
  return cachedPassword;
}
```

Secret naming convention: `{project}-{env}-db-password` (e.g., `melia-schwab-dev-db-password`).

The Lambda execution role must include `secretsmanager:GetSecretValue` permission for the relevant secrets.

## Stored Procedure Conventions

- Naming: `sx_{action}_{table}[_{modifier}]`
- Actions: `get`, `list`, `upsert`, `delete`, `process`, `report`, `calculate`, `find`
- Every table has get/list/upsert/delete procedures
- Procedures handle all validation and business logic
- Lambda handlers are thin wrappers that call procedures and return JSON

See `sp_guide.md` for full details.

## Lambda Layers (shared, us-east-1)

| Layer | Description |
|-------|-------------|
| `mssql-layer` | SQL Server connectivity (mssql, tedious) |
| `jsonwebtoken-layer` | JWT authentication |

Runtime: `nodejs24.x`

## CI/CD Pipeline

```
dev  →  test  →  main
 ↓        ↓        ↓
dev     test     prod    (AWS environment)
```

- On push to **dev**: lint → deploy Lambda → deploy UI → auto-PR to test
- On push to **test** or **main**: deploy only (lint skipped — code already linted on dev)

AWS authentication via OIDC federation (no stored AWS keys).

See `ci-cd.md` for full details.

## SQL Scripting & Deploy Tools

All scripts live in `SQL/` and pull the admin password from Secrets Manager.

| Script | Purpose |
|--------|---------|
| `script_all_tables.sh` | Export table DDL to TABLES/ |
| `script_all_procedures.sh` | Export stored procedure DDL to STORED_PROCEDURES/ |
| `script_all_triggers.sh` | Export trigger DDL to TABLES/TRIGGERS/ |
| `script_all_views.sh` | Export view DDL to VIEWS/ |
| `deploy_tables.sh` | Deploy types + tables in dependency order |
| `deploy_procedures.sh` | Deploy all stored procedures |
| `deploy_triggers.sh` | Deploy all triggers |

Usage: `bash SQL/script_all_tables.sh [database_name]`

Tools: `/opt/mssql-tools18/bin/sqlcmd` and `/opt/mssql-tools18/bin/bcp`

## Guide Files

These files live at the `repos/` level (above individual project folders) and provide shared standards across all projects.

| File | Description |
|------|-------------|
| `projects.md` | This file — architecture overview, folder structure, credential management |
| `ci-cd.md` | CI/CD pipeline details: branch strategy, GitHub Actions workflows, AWS OIDC setup, repo/Lambda mapping, enabling integration tests |
| `API_DESIGN_GUIDE.md` | Lambda API development patterns: handler structure, routing, request/response format, error handling, authentication |
| `API_TEST_GUIDE.md` | 15-step CRUD integration test procedure for Lambda APIs |
| `sp_guide.md` | Stored procedure naming, patterns, bitmask updates, soft deletes, error handling |
| `tables_guide.md` | Table design: naming conventions, required columns, default constraints, foreign keys, `newsequentialid()` usage |
| `SQL_guide.md` | SQL folder structure, file naming, execution order, references to other SQL guides |
| `views_guide.md` | View naming (`vx_` prefix), indexed vs regular views, SCHEMABINDING rules |
| `DATABASE_CONNECTION.md` | RDS admin connection details (server, port, credentials) |
