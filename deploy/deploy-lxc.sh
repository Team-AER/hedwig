#!/usr/bin/env bash
# Deploy the current commit to a Proxmox LXC running Docker.
#   deploy/deploy-lxc.sh [proxmox-host] [ctid]        (defaults: root@10.0.0.5 164)
# The LXC keeps /opt/hedwig as a plain source tree (no git) plus its private .env.
# First run creates .env with fresh secrets inside the container; they never leave it.
set -euo pipefail
HOST="${1:-root@10.0.0.5}"
CTID="${2:-164}"
APP_URL="${APP_URL:-https://hedwig.brainfc.uk}"
cd "$(git rev-parse --show-toplevel)"
SHA="$(git rev-parse --short HEAD)"
TARBALL="/tmp/hedwig-${SHA}.tar.gz"
git archive --format=tar.gz -o "$TARBALL" HEAD
# Streamed straight into the container: nothing is staged on the Proxmox host.
ssh "$HOST" "pct exec $CTID -- sh -c 'umask 077; cat > /tmp/hedwig.tar.gz'" < "$TARBALL"
rm -f "$TARBALL"
ssh "$HOST" "pct exec $CTID -- bash -s" <<REMOTE
set -euo pipefail
export LC_ALL=C
mkdir -p /opt/hedwig
cd /opt/hedwig
# Keep .env and certs; replace everything else with the new tree.
find . -mindepth 1 -maxdepth 1 ! -name .env ! -name certs -exec rm -rf {} +
tar -xzf /tmp/hedwig.tar.gz -C /opt/hedwig && rm -f /tmp/hedwig.tar.gz
if [ ! -f .env ]; then
  cp .env.hedwig.example .env
  sed -i "s|^APP_URL=.*|APP_URL=${APP_URL}|" .env
  sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=\$(openssl rand -hex 32)|" .env
  sed -i "s|^DB_PASSWORD=.*|DB_PASSWORD=\$(openssl rand -hex 24)|" .env
  sed -i "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=\$(openssl rand -hex 32)|" .env
  chmod 600 .env
  echo "created /opt/hedwig/.env with fresh secrets"
fi
grep -q '^GIT_SHA=' .env && sed -i "s|^GIT_SHA=.*|GIT_SHA=${SHA}|" .env || echo "GIT_SHA=${SHA}" >> .env
docker compose -f docker-compose.hedwig.yml up -d --build --remove-orphans
docker compose -f docker-compose.hedwig.yml ps --format 'table {{.Service}}\t{{.Status}}'
REMOTE
echo "deployed ${SHA} to CT ${CTID}"
