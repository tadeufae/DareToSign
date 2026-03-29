#!/bin/zsh

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)

cd "$ROOT_DIR"

branch_name="$(git branch --show-current)"

if [[ -z "$branch_name" ]]; then
  echo "No current Git branch found." >&2
  exit 1
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "Git remote 'origin' is not configured." >&2
  exit 1
fi

echo "Running checks before push..."
zsh scripts/test.sh
echo

echo "Pushing branch '$branch_name' to origin..."

if git rev-parse --abbrev-ref --symbolic-full-name "@{upstream}" >/dev/null 2>&1; then
  git push origin "$branch_name"
else
  git push -u origin "$branch_name"
fi

echo
echo "Deploy complete."
