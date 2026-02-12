#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# ClaudeBridge — Deploy Synapse to Railway
# =============================================================================
# Creates a Railway project with a Synapse service, configures it,
# and outputs the public URL for .env.
#
# Prerequisites:
#   - Railway CLI: npm i -g @railway/cli && railway login
#   - jq

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# --- Pre-flight ---
command -v railway >/dev/null 2>&1 || error "Railway CLI required. Install: npm i -g @railway/cli && railway login"
command -v jq      >/dev/null 2>&1 || error "jq is required."

# --- Generate registration secret ---
SYNAPSE_REGISTRATION_SECRET=$(openssl rand -base64 32)
info "Generated registration secret."

# --- Create Railway project ---
info "Creating Railway project 'ClaudeBridge'..."
echo ""
echo "The Railway CLI will open a browser to select a team/project."
echo "Choose 'Empty Project' when prompted."
echo ""

# Check if already linked
if railway status >/dev/null 2>&1; then
    warn "Already linked to a Railway project."
    read -p "Continue with the existing project? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        info "Run 'railway unlink' first, then re-run this script."
        exit 0
    fi
else
    railway init --name ClaudeBridge
fi

# --- Deploy Synapse from the synapse/ subdirectory ---
info "Deploying Synapse to Railway..."
info "Setting environment variables..."
railway variables set SYNAPSE_REGISTRATION_SECRET="$SYNAPSE_REGISTRATION_SECRET"

# Add a persistent volume for /data
info "NOTE: You need to manually add a volume in the Railway dashboard:"
info "  1. Go to your ClaudeBridge project on railway.app"
info "  2. Click the Synapse service"
info "  3. Settings → Volumes → Add Volume"
info "  4. Mount path: /data"
echo ""

# Deploy
info "Deploying Synapse container..."
cd "$PROJECT_DIR/synapse"
railway up --detach

# Wait for deployment
info "Waiting for deployment to go live..."
sleep 10

# Get the public domain
info ""
info "==========================================="
info "  Synapse deployed to Railway!"
info "==========================================="
echo ""
info "Next steps:"
info "  1. Add a volume mounted at /data in the Railway dashboard"
info "  2. Generate a public domain in Railway (Settings → Networking → Generate Domain)"
info "  3. Note the domain (e.g., claudebridge-synapse-production-xxxx.up.railway.app)"
info "  4. Run the setup script with the URL:"
info ""
info "     ./scripts/setup.sh https://your-railway-domain.up.railway.app"
echo ""
info "  Registration secret (save this):"
info "    $SYNAPSE_REGISTRATION_SECRET"
