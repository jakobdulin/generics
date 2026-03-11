#!/usr/bin/env bash
#=============================================================================
# Script: deploy_views.sh
# Purpose: Deploy view SQL files from VIEWS/ folder
# Usage:   bash deploy_views.sh -s SERVER -d DATABASE -u USER [-p PASSWORD | -k SECRET_ID] [-o SQL_DIR] [-f FILE ...]
#
# If -f is provided (one or more times), only those files are deployed.
# If a VIEWS/deploy_order.txt file exists, views are deployed in that order.
# Otherwise all VIEWS/*.sql files are deployed alphabetically.
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
  echo "Usage: bash deploy_views.sh -s SERVER -d DATABASE -u USER [-p PASSWORD | -k SECRET_ID] [-o SQL_DIR] [-f FILE ...]" >&2
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
  "$SQLCMD" -S "$SERVER" -d "$DATABASE" -U "$USERNAME" -P "$PASSWORD" -C -i "$file"
  if [ $? -ne 0 ]; then
    echo "ERROR: Failed to deploy $file" >&2
    exit 1
  fi
}

echo "Deploying views to $DATABASE..."

if [[ ${#FILES[@]} -gt 0 ]]; then
  for f in "${FILES[@]}"; do
    if [ -f "VIEWS/$f" ]; then
      run_sql "VIEWS/$f"
    elif [ -f "$f" ]; then
      run_sql "$f"
    else
      echo "ERROR: File not found: $f" >&2
      exit 1
    fi
  done
else
  # Deploy views — use VIEWS/deploy_order.txt if it exists, otherwise alphabetical
  if [ -f "VIEWS/deploy_order.txt" ]; then
    echo "Using VIEWS/deploy_order.txt for dependency ordering..."
    while IFS= read -r file; do
      file=$(echo "$file" | xargs)
      [[ -z "$file" || "$file" == \#* ]] && continue
      if [ -f "VIEWS/$file" ]; then
        run_sql "VIEWS/$file"
      else
        echo "WARNING: VIEWS/$file not found, skipping" >&2
      fi
    done < VIEWS/deploy_order.txt
  else
    echo "No VIEWS/deploy_order.txt found, deploying VIEWS/*.sql alphabetically..."
    for f in VIEWS/*.sql; do
      run_sql "$f"
    done
  fi
fi

echo "All views deployed successfully!"
