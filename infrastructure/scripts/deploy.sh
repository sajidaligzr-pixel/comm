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

echo "==> Verifying the advertised Android build is actually servable"
# Found live (2026-08-29): app-version.json got committed/deployed pointing at an
# APK that hadn't been scp'd to public/downloads/ yet, so an already-installed app
# saw "update available," tried to download it, got a 404, and showed the user a
# generic "no internet connection"-looking failure — for a MANDATORY update, which
# meant the app was fully blocked until the file actually showed up. That was a
# manual-release ordering mistake, not something this script could have caused on
# its own, but this check makes the same mistake impossible to ship regardless of
# what order the two steps (upload APK, deploy the version bump) happen in: a
# commit that advertises a build with no matching file on disk now fails the
# deploy outright, before PM2 ever reloads onto it, rather than going live broken.
if [ -f apps/web/public/app-version.json ]; then
  apk_path=$(node -e "
    const info = require('./apps/web/public/app-version.json');
    const apkUrl = info.apkUrl || '';
    // A full external URL (http...) isn't something this script can check locally
    // — only the repo-relative '/downloads/...' convention every release so far
    // has used is verifiable here.
    console.log(apkUrl.startsWith('/') ? apkUrl : '');
  ")
  if [ -n "$apk_path" ] && [ ! -f "apps/web/public${apk_path}" ]; then
    echo "==> ABORT: app-version.json advertises '${apk_path}' but that file doesn't"
    echo "    exist at apps/web/public${apk_path}. Upload the APK to that path first,"
    echo "    THEN deploy the commit that bumps app-version.json — never the other"
    echo "    way around. Refusing to deploy a version bump with nothing behind it."
    exit 1
  fi
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
#
# --force is load-bearing, found live: this script reuses the same persistent
# checkout (and the same .turbo/ cache) on every deploy, unlike CI's throwaway
# runner — turbo's incremental cache saw `git reset --hard` land genuinely new
# source and still replayed a stale cached build ("cache hit... 36ms >>> FULL
# TURBO"), so PM2 kept serving old code while every fix looked like it silently
# "didn't work." A production deploy should never be faster because it skipped
# actually building the thing it's about to serve — --force costs a few real
# seconds of compile time and removes that whole failure mode.
npm run build -- --force

echo "==> Running database migrations"
npm run db:migrate:deploy

echo "==> Starting/reloading PM2 processes"
# startOrReload: starts both processes fresh on the very first deploy (nothing running
# under these names yet), zero-downtime-reloads them on every deploy after.
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save

echo "==> Deploy complete: $(git rev-parse --short HEAD)"
