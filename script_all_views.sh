#!/usr/bin/env bash
#=============================================================================
# Script: script_all_views.sh
# Purpose: Export all view DDL into VIEWS/ folder using BCP, plus a
#          consolidated VIEWS/views.sql
# Usage:   bash script_all_views.sh -s SERVER -d DATABASE -u USER [-p PASSWORD | -k SECRET_ID] [-o SQL_DIR]
#=============================================================================
set -euo pipefail

SQLCMD="/opt/mssql-tools18/bin/sqlcmd"
BCP="/opt/mssql-tools18/bin/bcp"
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
  echo "Usage: bash script_all_views.sh -s SERVER -d DATABASE -u USER [-p PASSWORD | -k SECRET_ID] [-o SQL_DIR]" >&2
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

# Get all user view names
echo "Getting list of views..."
views=$("$SQLCMD" -S "$SERVER" -d "$DATABASE" -U "$USERNAME" -P "$PASSWORD" -C \
  -Q "SET NOCOUNT ON;
SELECT name FROM sys.views WHERE schema_id = 1 ORDER BY name;" \
  -h -1 -W -m 1 | tr -d '\r' | sed '/^$/d')

count=$(echo "$views" | wc -l)
echo "Found $count views:"
echo "$views" | while read -r v; do echo "  - $v"; done

mkdir -p VIEWS
rm -f VIEWS/*.sql

# Create temp export procedure once
"$SQLCMD" -S "$SERVER" -d "$DATABASE" -U "$USERNAME" -P "$PASSWORD" -C -Q "
CREATE OR ALTER PROCEDURE temp_export_view (@ViewName NVARCHAR(128))
AS
BEGIN
  SET NOCOUNT ON
  DECLARE @sql NVARCHAR(MAX)
  SET @sql = 'SELECT ''DROP VIEW IF EXISTS [dbo].[' + @ViewName + '];'' + CHAR(13) + CHAR(10)' + CHAR(13) + CHAR(10) +
    'UNION ALL' + CHAR(13) + CHAR(10) +
    'SELECT ''GO'' + CHAR(13) + CHAR(10)' +
    'UNION ALL' + CHAR(13) + CHAR(10) +
    'SELECT OBJECT_DEFINITION(v.object_id) + CHAR(13) + CHAR(10) + ''GO'' + CHAR(13) + CHAR(10)
     FROM sys.views v
     WHERE v.name =''' + @ViewName + '''' + CHAR(13) + CHAR(10) +
    'UNION ALL' + CHAR(13) + CHAR(10) +
    'SELECT CHAR(13) + CHAR(10)'
  EXEC sp_executesql @sql
END" > /dev/null

# Export each view (only 1 connection per view via bcp)
echo "$views" | while read -r view; do
  view=$(echo "$view" | xargs)
  [ -z "$view" ] && continue
  echo "Exporting view $view"
  "$BCP" "EXEC temp_export_view '$view'" queryout "VIEWS/${view}.sql" \
    -S "$SERVER" -d "$DATABASE" -U "$USERNAME" -P "$PASSWORD" -c -u
  echo "  -> VIEWS/${view}.sql created"
done

# Clean up
"$SQLCMD" -S "$SERVER" -d "$DATABASE" -U "$USERNAME" -P "$PASSWORD" -C \
  -Q "DROP PROCEDURE IF EXISTS temp_export_view" > /dev/null

# Create consolidated views.sql
echo "Creating consolidated views.sql file..."
: > VIEWS/views.sql
echo "$views" | while read -r view; do
  view=$(echo "$view" | xargs)
  [ -z "$view" ] && continue
  if [ -f "VIEWS/${view}.sql" ]; then
    cat "VIEWS/${view}.sql" >> VIEWS/views.sql
    printf '\r\n\r\n' >> VIEWS/views.sql
  fi
done

echo "All view exports completed!"
echo "Individual view files created in VIEWS/ directory"
echo "Consolidated file created as VIEWS/views.sql"
