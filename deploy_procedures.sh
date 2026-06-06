#!/usr/bin/env bash
#=============================================================================
# Script: deploy_procedures.sh
# Purpose: Deploy stored procedures from STORED_PROCEDURES/ folder
# Usage:   bash deploy_procedures.sh -s SERVER -d DATABASE -u USER [-p PASSWORD | -k SECRET_ID] [-o SQL_DIR] [-f FILE ...]
#
# If -f is provided (one or more times), only those files are deployed.
# Otherwise all STORED_PROCEDURES/*.sql files are deployed.
#=============================================================================
set -euo pipefail

SQLCMD="/opt/mssql-tools18/bin/sqlcmd"
SERVER=""
DATABASE=""
USERNAME=""
PASSWORD=""
SECRET_ID=""
SQL_DIR=""
FILES=()

while [[ $# -gt 0 ]]; do
  case $1 in
    -s|--server)    SERVER="$2";    shift 2 ;;
    -d|--database)  DATABASE="$2";  shift 2 ;;
    -u|--user)      USERNAME="$2";  shift 2 ;;
    -p|--password)  PASSWORD="$2";  shift 2 ;;
    -k|--secret-id) SECRET_ID="$2"; shift 2 ;;
    -o|--sql-dir)   SQL_DIR="$2";   shift 2 ;;
    -f|--file)      FILES+=("$2");  shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$SERVER" || -z "$DATABASE" || -z "$USERNAME" ]]; then
  echo "Usage: bash deploy_procedures.sh -s SERVER -d DATABASE -u USER [-p PASSWORD | -k SECRET_ID] [-o SQL_DIR] [-f FILE ...]" >&2
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
  echo "  Deploying $(basename "$file")..."
  "$SQLCMD" -S "$SERVER" -d "$DATABASE" -U "$USERNAME" -P "$PASSWORD" -C -I -i "$file"
  if [ $? -ne 0 ]; then
    echo "ERROR: Failed to deploy $(basename "$file")" >&2
  fi
}

echo "Deploying stored procedures to $DATABASE..."

if [[ ${#FILES[@]} -gt 0 ]]; then
  for f in "${FILES[@]}"; do
    if [ -f "STORED_PROCEDURES/$f" ]; then
      run_sql "STORED_PROCEDURES/$f"
    elif [ -f "$f" ]; then
      run_sql "$f"
    else
      echo "ERROR: File not found: $f" >&2
      exit 1
    fi
  done
else
  files=(STORED_PROCEDURES/*.sql)
  echo "Found ${#files[@]} procedure files"
  for file in "${files[@]}"; do
    run_sql "$file"
  done
fi

echo "All stored procedures deployed successfully!"
