#!/usr/bin/env bash
set -euo pipefail

# infrastructure/scripts/backup-db.sh — daily Postgres backup.
#
# docs/11-deployment-architecture.md originally assumed a managed Postgres provider
# ("automated encrypted backups via the managed provider, tested restores on a
# schedule"). Running Postgres on the same Droplet as the app instead (a deliberate
# cost/simplicity call, not what that doc's default topology assumed) means that
# safety net doesn't exist unless something stands in for it — this is that something,
# not an optional extra. Meant to run daily via cron; see the deployment runbook for
# the crontab line.
#
# Dumps, compresses, and uploads to the same DigitalOcean Space already provisioned
# for media attachments (a separate `db-backups/` prefix, not mixed in with attachment
# objects), then deletes local copies older than 2 days — remote retention is enforced
# by a lifecycle rule set once on the Space itself (dashboard, see the runbook), not by
# this script, so a bug here can't silently delete the only remaining backup.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# DATABASE_URL, BACKUP_BUCKET, SPACES_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
# — gitignored, never committed, never shared with apps/web/.env even though some
# values overlap (this script has no other reason to read that file, and shouldn't
# need to parse Next.js's env-loading conventions to get a DB connection string).
# shellcheck disable=SC1091
source "${REPO_ROOT}/.backup-env"

BACKUP_DIR="${REPO_ROOT}/.backups"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILENAME="comm-db-${TIMESTAMP}.sql.gz"

mkdir -p "$BACKUP_DIR"
pg_dump "$DATABASE_URL" | gzip > "${BACKUP_DIR}/${FILENAME}"

aws s3 cp "${BACKUP_DIR}/${FILENAME}" "s3://${BACKUP_BUCKET}/db-backups/${FILENAME}" \
  --endpoint-url "https://${SPACES_REGION}.digitaloceanspaces.com"

# Local copies only need to survive until the next successful upload confirms this
# one made it out — keeping 2 days' worth is just headroom for a failed run to be
# investigated, not the actual retention policy.
find "$BACKUP_DIR" -name 'comm-db-*.sql.gz' -mtime +2 -delete

echo "==> Backup complete: ${FILENAME}"
