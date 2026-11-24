#!/usr/bin/env bash
# Snapshots each named repository's star counts and traffic into the current
# directory, the traffic branch's checkout: traffic.yml runs it daily, as
# GitHub keeps traffic for 14 days only. It keeps counts only: no logins or
# anything else about a person, as the branch is public.
#
#   scripts/traffic.sh backmesh/backmesh backmesh/cache
#
# <repo>/stars.json has, for each day someone starred, the stars added that
# day and the total since, from today's stargazers: a star later removed no
# longer counts. views.json and clones.json keep every day ever seen, today's
# count replacing the last run's. The top referrers and paths are GitHub's
# totals over the last 14 days, so each run keeps its own
# <repo>/{referrers,paths}/<date>.json. The traffic API needs TRAFFIC_TOKEN, a
# token with Administration read; without it, only the stars are kept. With
# CLOUDFLARE_ANALYTICS_TOKEN and CLOUDFLARE_ACCOUNT_ID, go-links.json keeps
# the clicks a day on each of backmesh.com's /go/ links (website/worker.js).
# Analytics Engine keeps 3 months; each run reads the last 30 days.
set -euo pipefail

day=$(date -u +%F)
# Merges a list of days into a file of them, by `key`, the new one winning.
merge() {
  local file=$1 key=$2 new
  new=$(cat)
  jq -n --argjson new "$new" --slurpfile old <(cat "$file" 2>/dev/null || echo '[]') \
    "\$old[0] + \$new | group_by($key) | map(.[-1])" >"$file.tmp"
  mv "$file.tmp" "$file"
}

for repo in "$@"; do
  dir=${repo#*/}
  mkdir -p "$dir"
  gh api --paginate -H 'Accept: application/vnd.github.star+json' \
    "repos/$repo/stargazers?per_page=100" --jq '[.[].starred_at[:10]]' |
    jq -s 'add // [] | group_by(.) | reduce .[] as $d ([];
      . + [{day: $d[0], added: ($d | length), total: ((.[-1].total // 0) + ($d | length))}])' >"$dir/stars.json"
  [[ -n ${TRAFFIC_TOKEN:-} ]] || continue
  for kind in views clones; do
    GH_TOKEN=$TRAFFIC_TOKEN gh api "repos/$repo/traffic/$kind" --jq ".$kind" |
      merge "$dir/$kind.json" .timestamp
  done
  for kind in referrers paths; do
    mkdir -p "$dir/$kind"
    GH_TOKEN=$TRAFFIC_TOKEN gh api "repos/$repo/traffic/popular/$kind" | jq . >"$dir/$kind/$day.json"
  done
done
[[ -n ${TRAFFIC_TOKEN:-} ]] || echo "::notice::No TRAFFIC_TOKEN: kept the stars only."

if [[ -z ${CLOUDFLARE_ANALYTICS_TOKEN:-} || -z ${CLOUDFLARE_ACCOUNT_ID:-} ]]; then
  echo "::notice::No Cloudflare token: kept no /go/ link clicks."
elif clicks=$(curl -fsS "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/analytics_engine/sql" \
  -H "Authorization: Bearer $CLOUDFLARE_ANALYTICS_TOKEN" \
  --data "SELECT toDate(timestamp) AS day, blob1 AS channel, SUM(_sample_interval) AS clicks
    FROM go_clicks WHERE timestamp > NOW() - INTERVAL '30' DAY
    GROUP BY day, channel FORMAT JSON" |
  jq '[.data[] | {day, channel, clicks: (.clicks | tonumber)}]'); then
  merge go-links.json '[.day, .channel]' <<<"$clicks"
else
  echo "::warning::Couldn't read the /go/ link clicks from Analytics Engine."
fi
