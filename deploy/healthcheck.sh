#!/usr/bin/env bash
# TaskForge uptime probe. Runs from cron every 5 minutes on the VPS and pings
# the public API through the Cloudflare tunnel, so it covers the Node process,
# cloudflared, Postgres (Supabase pooler) and Redis in one check — /health
# answers 503 when either dependency is down.
#
# Alerts go to Telegram, reusing the FlipRadar alerts bot already on this box.
# Only state *transitions* alert (up→down, down→up), so a long outage is one
# message, not one every five minutes.
#
# Install:  cp deploy/healthcheck.sh ~/bin/taskforge-healthcheck.sh && chmod +x ~/bin/taskforge-healthcheck.sh
#           crontab: */5 * * * * /home/ubuntu/bin/taskforge-healthcheck.sh >> /home/ubuntu/.pm2/logs/taskforge-healthcheck.log 2>&1
set -u

URL="${TASKFORGE_HEALTH_URL:-https://taskforge-api.sigmahousingllc.com/api/v1/health}"
STATE_FILE="${TASKFORGE_HEALTH_STATE:-/home/ubuntu/.taskforge-health.state}"
TELEGRAM_ENV="${TELEGRAM_ENV_FILE:-/home/ubuntu/flipradar/scraper/.env}"

# Pull just the two Telegram vars out of the scraper env; never source the whole file.
TELEGRAM_BOT_TOKEN="$(grep -m1 '^TELEGRAM_BOT_TOKEN=' "$TELEGRAM_ENV" 2>/dev/null | cut -d= -f2- | tr -d '"')"
TELEGRAM_CHAT_ID="$(grep -m1 '^TELEGRAM_CHAT_ID=' "$TELEGRAM_ENV" 2>/dev/null | cut -d= -f2- | tr -d '"')"

notify() {
  local text="$1"
  if [[ -z "$TELEGRAM_BOT_TOKEN" || -z "$TELEGRAM_CHAT_ID" ]]; then
    echo "$(date -u +%FT%TZ) NOTIFY (no telegram creds): $text"
    return
  fi
  curl -sS -m 10 -o /dev/null "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=${text}" || echo "$(date -u +%FT%TZ) telegram send failed"
}

# Two tries 15s apart before declaring down, so a single pooler blip doesn't page.
probe() {
  curl -sS -m 10 -o /tmp/taskforge-health.body -w '%{http_code}' "$URL" 2>/dev/null || echo "000"
}
code="$(probe)"
if [[ "$code" != "200" ]]; then
  sleep 15
  code="$(probe)"
fi

prev="$(cat "$STATE_FILE" 2>/dev/null || echo up)"
body="$(head -c 300 /tmp/taskforge-health.body 2>/dev/null | tr -d '\n')"

if [[ "$code" == "200" ]]; then
  if [[ "$prev" != "up" ]]; then
    notify "✅ TaskForge API recovered (HTTP 200) at $(date -u +%FT%TZ)"
    echo "$(date -u +%FT%TZ) recovered"
  fi
  echo up > "$STATE_FILE"
else
  if [[ "$prev" != "down" ]]; then
    notify "🔴 TaskForge API DOWN — HTTP ${code} from ${URL} at $(date -u +%FT%TZ)
${body:-<no body>}
Check: ssh VPS → pm2 logs taskforge-api"
    echo "$(date -u +%FT%TZ) DOWN http=$code body=$body"
  fi
  echo down > "$STATE_FILE"
fi
