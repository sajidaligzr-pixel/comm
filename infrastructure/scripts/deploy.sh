#!/usr/bin/env bash
set -euo pipefail

# infrastructure/scripts/deploy.sh — the deploy mechanism docs/11-deployment-architecture.md
# describes: pulls the latest commit, installs, builds, runs migrations, and reloads
# the PM2 processes. Runs ON the app server (invoked over SSH by
# .github/workflows/deploy.yml on every push to main) inside an already-existing git
# clone of this repo — it never builds or ships a container image, consistent with
# that doc's "no containers, anywhere" constraint.
#
# One-time prerequisites this script assumes are already true (see the deploy
# checklist for the full list): this repo is already cloned on the server, Node
# (matching .nvmrc) and PM2 are already installed globally, `pm2 startup` has been run
# once so PM2 survives a reboot, and real apps/web/.env + apps/worker/.env files
# already exist with production secrets — this script never creates, reads, or
# modifies either.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

echo "==> Fetching origin/main"
git fetch origin main
before="$(git rev-parse HEAD)"
git reset --hard origin/main
after="$(git rev-parse HEAD)"

if [ "$before" = "$after" ]; then
  echo "==> Already up to date at $(git rev-parse --short HEAD) — redeploying anyway"
else
  echo "==> Updated $(git rev-parse --short "$before") -> $(git rev-parse --short "$after")"
fi

echo "==> Installing dependencies"
# Deliberately plain `npm ci`, no NODE_ENV=production set for this step. tsx, turbo,
# and typescript are all devDependencies — apps/web and apps/worker's own "start"
# scripts run source directly via tsx rather than a separately compiled dist/ (see
# docs/11) — so an environment that causes npm to skip devDependencies here would
# silently break both `npm run build` below AND the running app itself the next time
# PM2 restarts either process ("tsx: command not found").
npm ci

echo "==> Generating Prisma client"
# Not part of turbo's build pipeline (packages/database has no "build" script — see
# turbo.json), and the generated client is gitignored, so this has to run explicitly
# on every fresh install, not just once.
npm run db:generate

echo "==> Building"
# Deliberately no typecheck/lint/test step here — .github/workflows/deploy.yml already
# ran the full gate (against an ephemeral, disposable test database) before this script
# was ever invoked. Running the test suite again here would run it against this
# server's real apps/web/.env — i.e. the actual production Postgres — which is exactly
# the kind of thing the integration tests' real-row-creating design is fine with in a
# throwaway CI database and not fine with here.
npm run build

echo "==> Running database migrations"
npm run db:migrate:deploy

echo "==> Starting/reloading PM2 processes"
# startOrReload: starts both processes fresh on the very first deploy (nothing running
# under these names yet), zero-downtime-reloads them on every deploy after.
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save

echo "==> Deploy complete: $(git rev-parse --short HEAD)"
