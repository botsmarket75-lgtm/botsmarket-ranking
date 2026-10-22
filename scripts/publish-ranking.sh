#!/usr/bin/env bash
set -euo pipefail

publication_date="${1:?Usage: publish-ranking.sh YYYYMMDD}"
node scripts/publication.cjs verify --date "$publication_date"
base_commit="$(git rev-parse HEAD)"
git config user.name "botsmarket-bot"
git config user.email "botsmarket-bot@users.noreply.github.com"
git add -- ranking.json prev_ranking.json "history/$publication_date.json"
if git diff --cached --quiet; then
  echo "No publication changes to commit."
  exit 0
fi
# Real commit errors must fail; do not mask them as 'No changes'.
git commit -m "Daily ranking update"

for attempt in 1 2 3; do
  if git push origin HEAD:refs/heads/main; then
    exit 0
  fi
  git fetch origin refs/heads/main:refs/remotes/origin/main
  # A lost response can hide a successful push. Do not publish a second commit.
  if git merge-base --is-ancestor HEAD origin/main; then
    exit 0
  fi
  if [[ "$(git rev-parse origin/main)" != "$base_commit" ]]; then
    echo "::error::main changed during publication. Leaving it intact; retry from the latest main."
    exit 1
  fi
  if [[ "$attempt" != 3 ]]; then sleep 5; fi
done
echo "::error::Publication push failed after three attempts."
exit 1
