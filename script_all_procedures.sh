#!/usr/bin/env bash
#=============================================================================
# Script: script_all_procedures.sh
# Purpose: Export all stored procedure DDL from the database into
#          STORED_PROCEDURES/ folder using BCP
# Usage:   bash script_all_procedures.sh -s SERVER -d DATABASE -u USER [-p PASSWORD | -k SECRET_ID] [-o SQL_DIR]
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
  echo "Usage: bash script_all_procedures.sh -s SERVER -d DATABASE -u USER [-p PASSWORD | -k SECRET_ID] [-o SQL_DIR]" >&2
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

# Get all user procedure names (excluding system diagram procs)
echo "Getting list of stored procedures..."
procs=$("$SQLCMD" -S "$SERVER" -d "$DATABASE" -U "$USERNAME" -P "$PASSWORD" -C \
  -Q "SET NOCOUNT ON;
SELECT name FROM sys.procedures
WHERE name NOT IN (
  'sp_alterdiagram','sp_creatediagram','sp_dropdiagram',
  'sp_helpdiagramdefinition','sp_helpdiagrams',
  'sp_renamediagram','sp_upgraddiagrams',
  'temp_export_procedure')
ORDER BY name;" \
  -h -1 -W -m 1 | tr -d '\r' | sed '/^$/d')

count=$(echo "$procs" | wc -l)
echo "Found $count procedures:"
echo "$procs" | while read -r p; do echo "  - $p"; done

mkdir -p STORED_PROCEDURES

# Create temp export procedure once
"$SQLCMD" -S "$SERVER" -d "$DATABASE" -U "$USERNAME" -P "$PASSWORD" -C -Q "
CREATE OR ALTER PROCEDURE temp_export_procedure (@ProcedureName NVARCHAR(128))
AS
BEGIN
  SET NOCOUNT ON
  DECLARE @sql NVARCHAR(MAX)
  SET @sql = 'SELECT ''DROP PROCEDURE IF EXISTS [dbo].[' + @ProcedureName + '];'' + CHAR(13) + CHAR(10)' + CHAR(13) + CHAR(10) +
    'UNION ALL' + CHAR(13) + CHAR(10) +
    'SELECT ''GO'' + CHAR(13) + CHAR(10)' +
    'UNION ALL' + CHAR(13) + CHAR(10) +
    'SELECT OBJECT_DEFINITION(p.object_id) + CHAR(13) + CHAR(10) + ''GO'' + CHAR(13) + CHAR(10)
     FROM sys.procedures p
     WHERE p.name =''' + @ProcedureName + '''' + CHAR(13) + CHAR(10) +
    'UNION ALL' + CHAR(13) + CHAR(10) +
    'SELECT CHAR(13) + CHAR(10)'
  EXEC sp_executesql @sql
END" > /dev/null

# Export each procedure (only 1 connection per proc via bcp)
echo "$procs" | while read -r proc; do
  proc=$(echo "$proc" | xargs)
  [ -z "$proc" ] && continue
  echo "Exporting procedure $proc"
  "$BCP" "EXEC temp_export_procedure '$proc'" queryout "STORED_PROCEDURES/${proc}.sql" \
    -S "$SERVER" -d "$DATABASE" -U "$USERNAME" -P "$PASSWORD" -c -u
  echo "  -> STORED_PROCEDURES/${proc}.sql created"
done

# Clean up
"$SQLCMD" -S "$SERVER" -d "$DATABASE" -U "$USERNAME" -P "$PASSWORD" -C \
  -Q "DROP PROCEDURE IF EXISTS temp_export_procedure" > /dev/null

echo "All procedure exports completed!"
