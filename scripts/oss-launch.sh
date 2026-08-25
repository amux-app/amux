#!/usr/bin/env bash
# scripts/oss-launch.sh
#
# Phased OSS launch helper for MuxBase.
# Run each phase explicitly. Phases are idempotent where safe; destructive ones
# require explicit confirmation.
#
# Prereqs you've already done:
#   - muxbase-app GitHub org created
#   - muxbase-app/muxbase repo created (private, empty)
#   - muxbase-app/homebrew-muxbase repo created (empty)
#   - HOMEBREW_TAP_TOKEN secret added on muxbase-app/muxbase
#   - 8 Apple signing/notarization secrets set on muxbase-app/muxbase
#   - gh CLI authenticated to github.com:
#       gh auth login --hostname github.com --web
#   - Run this script from the real muxbase git checkout (with a .git directory).
#
# Phases:
#   check               Verify gh auth + repo existence + secrets present
#   init-tap            Bootstrap muxbase-app/homebrew-muxbase with Casks/.gitkeep + README
#   verify-clean        Validate working tree is clean (tracked + untracked)
#   push-main           Repoint origin and prompt for the final git push
#   dry-run             Push v<version> tag, then dispatch publish.yml once
#   dry-run-cleanup     Full rollback: delete the GitHub release + remote tag + local tag

set -euo pipefail

PHASE="${1:-help}"
REPO_OWNER="muxbase-app"
MAIN_REPO="${REPO_OWNER}/muxbase"
TAP_REPO="${REPO_OWNER}/homebrew-muxbase"
TAP_DIR="${MUXBASE_TAP_DIR:-$HOME/projects/homebrew-muxbase}"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
ok()  { printf 'OK:    %s\n' "$*"; }
note(){ printf 'NOTE:  %s\n' "$*"; }

require_gh_github_com() {
  command -v gh >/dev/null || die "gh CLI not installed"
  gh auth status --hostname github.com >/dev/null 2>&1 \
    || die "gh not authenticated to github.com. Run: gh auth login --hostname github.com --web"
}

require_in_repo() {
  git rev-parse --show-toplevel >/dev/null 2>&1 \
    || die "Not inside a git repo. Run this from your real muxbase checkout (the one with .git/)."
}

current_version() {
  node -e 'console.log(JSON.parse(require("fs").readFileSync("package.json","utf8")).version)'
}

case "$PHASE" in

  check)
    echo "=== Checking prerequisites ==="
    require_gh_github_com
    ok "gh authenticated to github.com"

    gh repo view "$MAIN_REPO" --json name >/dev/null \
      || die "$MAIN_REPO not reachable - create it (private is fine) and grant your account access"
    ok "$MAIN_REPO exists"

    gh repo view "$TAP_REPO" --json name >/dev/null \
      || die "$TAP_REPO not reachable - create it (public, empty) before running init-tap"
    ok "$TAP_REPO exists"

    echo
    echo "Checking secrets on $MAIN_REPO..."
    SECRETS=$(gh secret list --repo "$MAIN_REPO" --json name --jq '.[].name')
    REQUIRED=(
      HOMEBREW_TAP_TOKEN
      APPLE_ID
      APPLE_TEAM_ID
      APPLE_SIGN_IDENTITY
      APPLE_CERTIFICATE_BASE64
      APPLE_CERTIFICATE_PASSWORD
      APPLE_KEYCHAIN_PASSWORD
      APPLE_APP_SPECIFIC_PASSWORD
      APPLE_NOTARY_PROFILE
    )
    missing=0
    for s in "${REQUIRED[@]}"; do
      if printf '%s\n' "$SECRETS" | grep -qx "$s"; then ok "secret $s set"
      else echo "MISSING: $s"; missing=$((missing+1))
      fi
    done
    [ "$missing" -eq 0 ] || die "$missing required secret(s) missing - add them via repo Settings > Secrets and variables > Actions"
    echo
    ok "All prerequisites green. Next: ./scripts/oss-launch.sh init-tap"
    ;;

  init-tap)
    require_gh_github_com
    echo "=== Initializing $TAP_REPO at $TAP_DIR ==="

    if [ -d "$TAP_DIR" ]; then
      [ -d "$TAP_DIR/.git" ] || die "$TAP_DIR exists but is not a git repo. Remove it and retry."
      remote=$(git -C "$TAP_DIR" remote get-url origin 2>/dev/null || true)
      case "$remote" in
        *"$TAP_REPO"*) ok "Existing tap clone matches $TAP_REPO" ;;
        *)             die "$TAP_DIR has wrong remote ($remote). Remove it and retry." ;;
      esac
      git -C "$TAP_DIR" fetch origin
    else
      mkdir -p "$(dirname "$TAP_DIR")"
      git clone "https://github.com/$TAP_REPO.git" "$TAP_DIR"
    fi

    cd "$TAP_DIR"
    git checkout main 2>/dev/null || git checkout -b main

    mkdir -p Casks
    [ -f Casks/.gitkeep ] || touch Casks/.gitkeep

    if [ ! -f README.md ]; then
      cat > README.md <<'EOF'
# homebrew-muxbase

Official Homebrew tap for [MuxBase](https://github.com/muxbase-app/muxbase).

## Install

```bash
brew tap muxbase-app/muxbase
brew install tmux && brew install --cask muxbase
```

MuxBase requires tmux 3.7b or newer. The explicit `brew install tmux` step installs
or upgrades tmux before the Cask; the Cask also refuses to install against an
older linked tmux. After upgrading tmux, save and close active tmux sessions and
restart tmux completely.

The `Casks/muxbase.rb` file is generated and pushed by the release pipeline of
[muxbase-app/muxbase](https://github.com/muxbase-app/muxbase) on every tagged release.
Do not edit by hand.
EOF
    fi

    if [ -z "$(git status --porcelain)" ]; then
      ok "Tap already initialized - nothing to commit"
    else
      git add Casks/.gitkeep README.md
      author_name=$(git config user.name || echo muxbase-bot)
      author_email=$(git config user.email || echo bot@muxbase.dev)
      git -c user.name="$author_name" -c user.email="$author_email" \
          commit -m "chore: initialize tap"
      git push -u origin main || die "Push to $TAP_REPO failed. Check HOMEBREW_TAP_TOKEN scope and tap-repo write access for your account."
      ok "Tap initialized and pushed"
    fi

    git fetch origin main
    local_sha=$(git rev-parse HEAD)
    remote_sha=$(git rev-parse origin/main 2>/dev/null || echo MISSING)
    [ "$local_sha" = "$remote_sha" ] \
      || die "Local HEAD ($local_sha) does not match origin/main ($remote_sha). Resolve manually."
    ok "Local and remote in sync"
    ;;

  verify-clean)
    require_in_repo
    cd "$(git rev-parse --show-toplevel)"
    tracked=$(git status --porcelain)
    untracked=$(git ls-files --others --exclude-standard)
    if [ -n "$tracked" ] || [ -n "$untracked" ]; then
      [ -n "$tracked" ]   && { echo "TRACKED changes:";   printf '  %s\n' "$tracked";   }
      [ -n "$untracked" ] && { echo "UNTRACKED files:";   printf '  %s\n' "$untracked"; }
      die "Working tree not clean - commit, stash, or remove the listed files."
    fi
    ok "Working tree clean (tracked and untracked)"
    ;;

  push-main)
    require_in_repo
    cd "$(git rev-parse --show-toplevel)"
    "$0" verify-clean

    desired="https://github.com/$MAIN_REPO.git"
    current=$(git remote get-url origin 2>/dev/null || echo "")
    if [ "$current" != "$desired" ]; then
      echo "Updating origin: $current -> $desired"
      git remote set-url origin "$desired"
    fi
    git remote -v
    echo
    git status -sb
    echo
    note "Review the branch above. To push, run:"
    note "  git push -u origin HEAD"
    note ""
    note "If on a feature branch, open a PR on github.com after pushing."
    note "If on main, this is the final push. Make sure you want this exact state to be public."
    ;;

  dry-run)
    require_gh_github_com
    require_in_repo
    cd "$(git rev-parse --show-toplevel)"

    "$0" verify-clean

    version=$(current_version)
    tag="v$version"
    note "Dry run pushes tag $tag, then dispatches publish.yml ONCE with that tag."
    note "If the run is green you keep the release as your real v$version."
    note "If it fails, run 'dry-run-cleanup' to delete the release AND the tag,"
    note "then fix forward and rerun this phase."

    if gh release view "$tag" --repo "$MAIN_REPO" >/dev/null 2>&1; then
      die "Release $tag already exists on $MAIN_REPO. Run 'dry-run-cleanup' first or bump the version."
    fi
    if git rev-parse "$tag" >/dev/null 2>&1; then
      die "Tag $tag already exists locally. Run 'git tag -d $tag' first."
    fi
    if git ls-remote --tags origin "refs/tags/$tag" 2>/dev/null | grep -q "$tag"; then
      die "Tag $tag already exists on origin. Run 'git push --delete origin $tag' first."
    fi

    git tag -a "$tag" -m "Release $tag"
    git push origin "$tag" || { git tag -d "$tag"; die "Failed to push $tag to origin."; }
    git ls-remote --tags origin "refs/tags/$tag" | grep -q "$tag" \
      || die "Tag $tag is not on remote after push - aborting."
    ok "Tag $tag pushed"

    gh workflow run publish.yml --repo "$MAIN_REPO" -f tag="$tag" \
      || {
        git push --delete origin "$tag" 2>/dev/null || true
        git tag -d "$tag" 2>/dev/null || true
        die "Failed to dispatch publish.yml. Tag rollback attempted."
      }
    ok "publish.yml dispatched for $tag"

    sleep 5
    run_id=$(gh run list --repo "$MAIN_REPO" --workflow publish.yml --limit 1 --json databaseId --jq '.[0].databaseId // ""')
    if [ -n "$run_id" ]; then
      gh run watch "$run_id" --repo "$MAIN_REPO" --exit-status || true
    else
      note "No publish.yml run found yet. Check GitHub Actions manually."
    fi

    echo
    note "When the run is green, verify:"
    note "  gh release view $tag --repo $MAIN_REPO"
    note "  gh api /repos/$TAP_REPO/contents/Casks/muxbase.rb --jq '.content' | base64 -d | head"
    note "  brew tap muxbase-app/muxbase && brew install tmux && brew install --cask muxbase"
    ;;

  dry-run-cleanup)
    require_gh_github_com
    require_in_repo
    cd "$(git rev-parse --show-toplevel)"
    version=$(current_version)
    tag="v$version"
    note "Deleting GitHub release $tag, remote tag, and local tag (full rollback)."

    gh release delete "$tag" --repo "$MAIN_REPO" --yes 2>/dev/null \
      && ok "Deleted release $tag" \
      || note "No release named $tag"

    git push --delete origin "$tag" 2>/dev/null \
      && ok "Deleted remote tag $tag" \
      || note "No remote tag $tag"

    git tag -d "$tag" 2>/dev/null \
      && ok "Deleted local tag $tag" \
      || note "No local tag $tag"

    brew uninstall --cask muxbase 2>/dev/null || true
    brew untap "$REPO_OWNER/muxbase" 2>/dev/null || true
    ok "Cleanup done - rerun 'dry-run' when ready"
    ;;

  help|*)
    cat <<EOF
Usage: $0 <phase>

Run from your real muxbase git checkout. Phases (run in this order):

  check               Verify gh auth, repos exist, all secrets configured
  init-tap            Clone $TAP_REPO, push Casks/.gitkeep + README on first commit
  verify-clean        Confirm working tree clean (tracked AND untracked)
  push-main           Re-point origin to $MAIN_REPO and prompt to push current branch
  dry-run             Push v<version> tag, dispatch publish.yml once, and (if green)
                      the resulting GitHub release IS your real v<version>
  dry-run-cleanup     Full rollback: delete the GitHub release + remote tag + local tag

After dry-run succeeds, release-please drives all subsequent versions via
merge -> release PR -> tag. Do not tag manually after the first release.

Environment variables:
  MUXBASE_TAP_DIR  Override clone path for $TAP_REPO (default: \$HOME/projects/homebrew-muxbase)
EOF
    ;;
esac
