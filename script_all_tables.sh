#!/usr/bin/env bash
#=============================================================================
# Script: script_all_tables.sh
# Purpose: Export all user table DDL from the database into TABLES/ folder
# Usage:   bash script_all_tables.sh -s SERVER -d DATABASE -u USER [-p PASSWORD | -k SECRET_ID] [-o SQL_DIR]
#=============================================================================
set -euo pipefail

SQLCMD="/opt/mssql-tools18/bin/sqlcmd"
SERVER=""
DATABASE=""
USERNAME=""
PASSWORD=""
SECRET_ID=""
SQL_DIR=""

while [[ $# -gt 0 ]]; do
  case $1 in
    -s|--server)    SERVER="$2";    shift 2 ;;
    -d|--database)  DATABASE="$2";  shift 2 ;;
    -u|--user)      USERNAME="$2";  shift 2 ;;
    -p|--password)  PASSWORD="$2";  shift 2 ;;
    -k|--secret-id) SECRET_ID="$2"; shift 2 ;;
    -o|--sql-dir)   SQL_DIR="$2";   shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$SERVER" || -z "$DATABASE" || -z "$USERNAME" ]]; then
  echo "Usage: bash script_all_tables.sh -s SERVER -d DATABASE -u USER [-p PASSWORD | -k SECRET_ID] [-o SQL_DIR]" >&2
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

# Get all user table names
echo "Getting list of tables..."
tables=$("$SQLCMD" -S "$SERVER" -d "$DATABASE" -U "$USERNAME" -P "$PASSWORD" -C \
  -Q "SET NOCOUNT ON; SELECT name FROM sys.tables ORDER BY name;" \
  -h -1 -W -m 1 | tr -d '\r' | sed '/^$/d')

count=$(echo "$tables" | wc -l)
echo "Found $count tables:"
echo "$tables" | while read -r t; do echo "  - $t"; done

# Create output directory
mkdir -p TABLES
rm -f TABLES/*.sql

# Export each table
echo "$tables" | while read -r table; do
  table=$(echo "$table" | xargs)
  [ -z "$table" ] && continue
  echo "Exporting table $table"
  "$SQLCMD" -S "$SERVER" -d "$DATABASE" -U "$USERNAME" -P "$PASSWORD" -C \
    -i Script_Create_Table.sql -h -1 -W -m 1 \
    -v TableName="$table" -o "TABLES/${table}.sql"
  echo "  -> TABLES/${table}.sql created"
done

echo "All table exports completed!"
