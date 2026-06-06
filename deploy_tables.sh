#!/usr/bin/env bash
#=============================================================================
# Script: deploy_tables.sh
# Purpose: Deploy table SQL files from TABLES/ folder
# Usage:   bash deploy_tables.sh -s SERVER -d DATABASE -u USER [-p PASSWORD | -k SECRET_ID] [-o SQL_DIR] [-t TABLES_JSON] [-f FILE ...]
#
# If -f is provided (one or more times), only those files are deployed.
# If -t is provided, deploy order is read from the tables.json array order.
# Otherwise all TABLES/*.sql files are deployed alphabetically.
#=============================================================================
set -euo pipefail

SQLCMD="/opt/mssql-tools18/bin/sqlcmd"
SERVER=""
DATABASE=""
USERNAME=""
PASSWORD=""
SECRET_ID=""
SQL_DIR=""
TABLES_JSON=""
FILES=()

while [[ $# -gt 0 ]]; do
  case $1 in
    -s|--server)      SERVER="$2";      shift 2 ;;
    -d|--database)    DATABASE="$2";    shift 2 ;;
    -u|--user)        USERNAME="$2";    shift 2 ;;
    -p|--password)    PASSWORD="$2";    shift 2 ;;
    -k|--secret-id)   SECRET_ID="$2";   shift 2 ;;
    -o|--sql-dir)     SQL_DIR="$2";     shift 2 ;;
    -t|--tables-json) TABLES_JSON="$2"; shift 2 ;;
    -f|--file)        FILES+=("$2");    shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$SERVER" || -z "$DATABASE" || -z "$USERNAME" ]]; then
  echo "Usage: bash deploy_tables.sh -s SERVER -d DATABASE -u USER [-p PASSWORD | -k SECRET_ID] [-o SQL_DIR] [-t TABLES_JSON] [-f FILE ...]" >&2
  exit 1
fi

if [[ -z "$PASSWORD" && -z "$SECRET_ID" ]]; then
  echo "Either -p PASSWORD or -k SECRET_ID is required" >&2
  exit 1
fi

if [[ -z "$PASSWORD" ]]; then
  PASSWORD=$(aws secretsmanager get-secret-value --secret-id "$SECRET_ID" --query SecretString --output text --region us-east-1)
fi

if [[ -n "$SQL_DIR" ]]; then
  cd "$SQL_DIR"
else
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  cd "$SCRIPT_DIR"
fi

run_sql() {
  local file="$1"
  echo "  Deploying $file..."
  "$SQLCMD" -S "$SERVER" -d "$DATABASE" -U "$USERNAME" -P "$PASSWORD" -C -I -i "$file"
  if [ $? -ne 0 ]; then
    echo "ERROR: Failed to deploy $file" >&2
    exit 1
  fi
}

echo "Deploying tables to $DATABASE..."

if [[ ${#FILES[@]} -gt 0 ]]; then
  for f in "${FILES[@]}"; do
    if [ -f "TABLES/$f" ]; then
      run_sql "TABLES/$f"
    elif [ -f "$f" ]; then
      run_sql "$f"
    else
      echo "ERROR: File not found: $f" >&2
      exit 1
    fi
  done
else
  # Deploy TYPES first if the folder exists
  if [ -d "TYPES" ] && ls TYPES/*.sql 1>/dev/null 2>&1; then
    echo "Deploying User-Defined Types..."
    for f in TYPES/*.sql; do
      run_sql "$f"
    done
  fi

  # Deploy tables — use tables.json order if provided, otherwise alphabetical
  if [[ -n "$TABLES_JSON" ]]; then
    echo "Using $TABLES_JSON for dependency ordering..."
    for table in $(jq -r '.[].name' "$TABLES_JSON"); do
      if [ -f "TABLES/${table}.sql" ]; then
        run_sql "TABLES/${table}.sql"
      else
        echo "WARNING: TABLES/${table}.sql not found, skipping" >&2
      fi
    done
  else
    echo "No tables.json specified, deploying TABLES/*.sql alphabetically..."
    for f in TABLES/*.sql; do
      run_sql "$f"
    done
  fi
fi

# Deploy history tables if TABLES_HISTORY/ exists and has .sql files
if [ -d "TABLES_HISTORY" ] && ls TABLES_HISTORY/*.sql 1>/dev/null 2>&1; then
  # Run schema creation first if it exists
  if [ -f "TABLES_HISTORY/_create_schema.sql" ]; then
    echo "Creating history schema..."
    run_sql "TABLES_HISTORY/_create_schema.sql"
  fi

  echo "Deploying history tables..."
  if [[ -n "$TABLES_JSON" ]]; then
    for table in $(jq -r '.[] | select(.hasHistory) | .name' "$TABLES_JSON"); do
      if [ -f "TABLES_HISTORY/${table}.sql" ]; then
        run_sql "TABLES_HISTORY/${table}.sql"
      else
        echo "WARNING: TABLES_HISTORY/${table}.sql not found, skipping" >&2
      fi
    done
  else
    for f in TABLES_HISTORY/*.sql; do
      [ "$(basename "$f")" = "_create_schema.sql" ] && continue
      run_sql "$f"
    done
  fi
fi

echo "All tables deployed successfully!"
