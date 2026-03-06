# CI/CD Pipeline

## Branch Strategy

```
dev  →  test  →  main
 ↓        ↓        ↓
dev     test     prod    (AWS environment)
```

- **dev**: Active development. Push triggers lint + deploy + auto-PR to test.
- **test**: User acceptance. Merge PR triggers deploy only (no lint — code already linted on dev).
- **main**: Production. Merge triggers deploy only (no lint).

## Pipeline Flow (on push to dev)

1. **Lint** — ESLint v9 flat config runs against `lambda/` source
2. **Deploy Lambda** — Zips `lambda/` (excluding node_modules, tests, docs) and deploys via `aws lambda update-function-code`
3. **Deploy UI** (melia-smsmfa only) — Copies `index.html` to S3, invalidates CloudFront
4. **Integration Tests** — *commented out, ready to enable when tests are written*
5. **Promote** — Auto-creates PR from dev → test

On push to **test** or **main**: deploy only (no lint, no auto-PR). Lint is skipped because no code changes between branches — it already passed on dev.

## AWS Authentication

GitHub Actions authenticates to AWS via **OIDC federation** (no stored AWS keys).

- **OIDC Provider**: `token.actions.githubusercontent.com` (created in account 478351749133)
- **IAM Role**: `github-actions-deploy` (`arn:aws:iam::478351749133:role/github-actions-deploy`)
- **Trust Policy**: Allows any `jerm014/*` repo to assume the role
- **Permissions**: `lambda:UpdateFunctionCode`, `lambda:GetFunction`, `lambda:GetFunctionConfiguration`, S3 put/get on `*-melia-*` buckets, CloudFront invalidation

## GitHub Configuration

### Repository Secret (set on all repos)

| Secret | Value |
|--------|-------|
| `AWS_ROLE_ARN` | `arn:aws:iam::478351749133:role/github-actions-deploy` |

### Repository Settings

- **Actions permissions**: Read and write (allows auto-PR creation)
- **Workflow permissions**: `can_approve_pull_request_reviews: true`

## Repos and Lambda Names

| GitHub Repo | Local Folder | Lambda Function Pattern | Lambda Source | Has UI |
|-------------|-------------|------------------------|---------------|--------|
| jerm014/accounting | accounting2 | `accounting-{env}` | `lambda/` | Yes (accounting-frontend/) |
| jerm014/melia-smsmfa | melia-smsmfa | `melia-smsmfa-{env}` | `lambda/` | Yes (index.html → S3) |
| jerm014/melia-schwab | melia-schwab | `melia-schwab-{env}` | `lambda/` | No |
| jerm014/melia-tracking | melia-tracking | `melia-tracking-{env}` | `lambda/` | No |
| jerm014/melia-amereq | melia-amereq | `melia-amereq-{env}` | `lambda/` | No |
| jerm014/speed-dating | speed-dating | `speed-dating-{env}` | `lambda/` | Yes (www-app/) |
| jerm014/melia-database | melia-database | *none (SQL only)* | — | No |
| jerm014/magnolia | magnolia | *TBD* | — | No |

## Standard Project Layout

```
project/
├── .github/workflows/ci-cd.yml   # CI/CD pipeline
├── .gitignore                     # Excludes sensitive files
├── lambda/                        # Lambda source (deployed)
│   ├── lambda-function.js         # Main handler + router
│   ├── handlers/                  # Route handlers
│   ├── utils/                     # Shared utilities
│   ├── eslint.config.js           # ESLint v9 flat config
│   └── package.json               # Dependencies + eslint devDep
├── SQL/                           # Database objects
│   ├── TABLES/
│   ├── STORED_PROCEDURES/
│   ├── TYPES/
│   ├── VIEWS/
│   └── INDEXES/
├── TEST/                          # Integration tests
├── deploy.sh                      # Manual deploy script
└── index.html                     # UI (if applicable)
```

## ESLint Configuration

All projects use ESLint v9 flat config (`eslint.config.js`).

- **melia-smsmfa**: ESM (`sourceType: "module"`) with explicit Node.js globals
- **All others**: CommonJS (`sourceType: "commonjs"`) using `globals.node`
- **Rules**: `no-undef` (error), `no-unused-vars` (warn, ignore `_` prefix), `semi` (warn), `eqeqeq` (warn)

## Lambda Layers (shared, us-east-1)

| Layer | Version | Description |
|-------|---------|-------------|
| `mssql-layer` | 2 | SQL Server connectivity (mssql, tedious) |
| `jsonwebtoken-layer` | 1 | JWT auth (jsonwebtoken) |

Runtime: `nodejs24.x`

## Files Excluded from Git (.gitignore)

All repos share the same `.gitignore`:
- `node_modules/`, `*.zip`, `dist/`, `build/`, `coverage/`
- `project.md`, `CLAUDE.md`, `credentials.md`, `DATABASE_CONNECTION.md`, `stripe-keys.md`
- `.env`, `.env.local`
- `.idea/`, `*.swp`, `*.swo`, `.DS_Store`, `Thumbs.db`, `nul`

## Shared Guide Files (repos/ parent folder)

These files live above the git repos at `repos/` level for Claude context:
- `API_DESIGN_GUIDE.md` — Lambda API development patterns
- `API_TEST_GUIDE.md` — 15-step CRUD integration test procedure
- `sp_guide.md` — Stored procedure naming and patterns
- `tables_guide.md` — Table design, triggers, naming conventions
- `SQL_guide.md` — SQL folder structure and file naming
- `views_guide.md` — View naming, indexed vs regular views
- `DATABASE_CONNECTION.md` — RDS admin connection details
- `ci-cd.md` — This file

## Enabling Integration Tests

To uncomment the test job in a workflow:

1. Write tests in `TEST/` directory following `API_TEST_GUIDE.md`
2. Add these GitHub secrets to the repo:
   - `DEV_API_URL` — Lambda Function URL for dev environment
   - `DEV_DB_SERVER` — RDS hostname
   - `DEV_DB_DATABASE` — Database name (e.g., `accounting_dev`)
   - `DEV_DB_USERNAME` — EXECUTE-only database user
   - `DEV_DB_PASSWORD` — Database user password
3. Uncomment the `test:` job in `.github/workflows/ci-cd.yml`
4. Tests use `Bearer Development` auth bypass in dev environment

## Manual Deployment

Each project with a `deploy.sh` can be deployed manually:

```bash
./deploy.sh dev        # Deploy Lambda to dev
./deploy.sh dev --ui   # Deploy Lambda + UI to dev
./deploy.sh prod       # Deploy Lambda to production
```
