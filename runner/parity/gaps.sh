#!/usr/bin/env bash
# Checks a runner image against GitHub's Ubuntu 24.04 image: every tool and
# apt package its README names, at toolset.lock's runner-images commit. Prints
# a summary, also to the job's, and fails only on a regression: a tool missing
# that known-gaps.txt doesn't list. commands.txt says how to check each tool.
# Run: runner/parity/gaps.sh <image>
set -Eeuo pipefail
export LC_ALL=C # comm and sort agree on order

image=$1
dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
rev=$(sed -n 's/^revision=//p' "$dir/toolset.lock")
readme=$(curl -fsSL --retry 5 "https://raw.githubusercontent.com/actions/runner-images/$rev/images/ubuntu/Ubuntu2404-Readme.md")

# The README's names: each bullet's words before its version, each table's
# first column (a Java version is Java), and the apt table's packages.
# shellcheck disable=SC2016 # awk programs
names=$(awk -F'|' '
  function name(s,   n, i, w, out) {
    n = split(s, w, " ")
    for (i = 1; i <= n; i++) {
      if (w[i] ~ /^[0-9(]/ || w[i] == "-") break
      if (sub(/:$/, "", w[i])) { out = out (out ? " " : "") w[i]; break }
      out = out (out ? " " : "") w[i]
    }
    return out
  }
  /^## Installed Software/ { on = 1; next }
  !on { next }
  /^```/ { code = !code; next }
  code { next }
  /^### / { top = substr($0, 5) }
  /^#/ { sec = $0; sub(/^#+ /, "", sec); next }
  top == "Cached Tools" || sec ~ /^(PowerShell Modules|Environment variables)$/ { next }
  /^- / { print name(substr($0, 3)); next }
  /^\| / && !/^\| -/ {
    n = $2; gsub(/^ +| +$/, "", n)
    if (n ~ /^(Name|Version|Package Name)$/) next
    if (top == "Installed apt packages") print "apt:" n
    else print n ~ /^[0-9]/ ? sec : n
  }' <<<"$readme" | awk 'NF && !seen[$0]++')

# Each name with its check, from commands.txt.
checks=$(awk -v OFS='\t' '
  FNR == NR { if (!/^#/ && (i = index($0, "="))) map[substr($0, 1, i - 1)] = substr($0, i + 1); next }
  /^apt:/ { pkg = substr($0, 5); print $0, "apt " ($0 in map ? map[$0] : pkg); next }
  { print $0, $0 in map ? map[$0] : "?" }' "$dir/commands.txt" - <<<"$names")

# One container runs every check, as the image's runner user, with the
# checks after the script on its stdin.
# shellcheck disable=SC2016 # runs in the container
script='
  while IFS=$(printf "\t") read -r name check; do
    case $check in
      "?" | -) status=$check ;;
      "apt "*) dpkg-query -W -f="\${Status}" "${check#apt }" 2>/dev/null | grep -q " installed$" && status=ok || status=missing ;;
      *" "*) bash -c "$check" >/dev/null 2>&1 && status=ok || status=missing ;;
      *) command -v -- "$check" >/dev/null && status=ok \
        || { grep -q "^$check " /usr/share/backmesh/commands && status=first-use; } || status=missing ;;
    esac
    printf "%s\t%s\n" "$name" "$status"
  done'
results=$(docker run --rm -i --entrypoint bash "$image" --noprofile --norc -c "$script" <<<"$checks")

known=$(grep -v '^#' "$dir/known-gaps.txt" | sort || true)
list() { awk -F'\t' -v want="$1" '$2 == want { print $1 }' <<<"$results"; }
missing=$( (list missing && list first-use) | sort)
# comm's lines: $1 picks the column, as -12 (in both) or -23 (only missing).
both() { comm "$1" <(echo "$missing") <(echo "$known") | grep . || true; }
count() { grep -c . <<<"$1" || true; }
inline() { if [[ -n $1 ]]; then paste -sd, <<<"$1" | sed 's/,/, /g'; else echo none; fi; }
regressions=$(both -23)
summary=$(
  echo "### Runner image against GitHub's Ubuntu 24.04 image"
  echo
  echo "At actions/runner-images \`${rev:0:12}\`: $(count "$(list ok)") of $(count "$results") tools and packages present."
  echo
  echo "- **Missing, installs on first use** ($(count "$(list first-use)")): $(inline "$(list first-use)")"
  echo "- **Missing, not in Ubuntu's archive** ($(count "$(list missing)")): $(inline "$(list missing)")"
  echo "- **New gaps**, not in known-gaps.txt ($(count "$regressions")): $(inline "$regressions")"
  echo "- **Known gaps now present**, to drop from known-gaps.txt: $(inline "$(both -13)")"
  echo "- **Not checked**, not a command: $(inline "$(list -)")"
  echo "- **Unmapped**, to add to commands.txt: $(inline "$(list '?')")"
)
printf '%s\n' "$summary"
if [[ -n ${GITHUB_STEP_SUMMARY:-} ]]; then printf '%s\n' "$summary" >>"$GITHUB_STEP_SUMMARY"; fi
if [[ -n $regressions ]]; then
  echo "::error::Missing from the runner image and not in runner/parity/known-gaps.txt: $(inline "$regressions")"
  exit 1
fi
