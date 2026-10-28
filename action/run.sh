#!/usr/bin/env bash
# The chamoji GitHub Action; action.yml runs this. Everything arrives as
# environment variables, never as ${{ }} expressions pasted into the script.
#
#   CHAMOJI_MODE      auto (default), notes, comment or release
#   CHAMOJI_CLI       command to run chamoji; default: npx @chamoji/cli@$CHAMOJI_VERSION
#   CHAMOJI_VERSION   chamoji version for npx; default: latest
#   CHAMOJI_AI        true to pass --ai (needs TYPESAFE_API_KEY)
#   CHAMOJI_RELEASE_VERSION  release mode: the version to release; default: from the commits
#   CHAMOJI_COMMENT_AUTHOR   comment mode: login that owns the preview comment; default: github-actions[bot]
#   GH_TOKEN, GH_REPO and the usual GITHUB_* variables
#
# Kept to bash 3.2 so it also runs on macOS runners.
set -euo pipefail

mode=${CHAMOJI_MODE:-auto}
summary=${GITHUB_STEP_SUMMARY:-/dev/null}
output=${GITHUB_OUTPUT:-/dev/null}
work=${RUNNER_TEMP:-${TMPDIR:-/tmp}}
marker='<!-- chamoji-changelog -->'
semver='^v?[0-9]+\.[0-9]+\.[0-9]+'
read -r -a cli <<<"${CHAMOJI_CLI:-npx --yes @chamoji/cli@${CHAMOJI_VERSION:-latest}}"

fail() {
	echo "::error::chamoji: $*" >&2
	exit 1
}

chamoji() {
	if [ "${CHAMOJI_AI:-false}" = true ]; then
		"${cli[@]}" "$@" --ai --no-update-check
	else
		"${cli[@]}" "$@" --no-update-check
	fi
}

# The rendered changelog without its "# Changelog" title or leading blank lines.
strip_title() {
	sed '1{/^# Changelog$/d;}' | awk 'NF { started = 1 } started'
}

# A field from the webhook payload, read with node (set up by action.yml).
event() {
	node -e 'const e = require(process.env.GITHUB_EVENT_PATH); const v = process.argv[1].split(".").reduce((o, k) => o?.[k], e); process.stdout.write(v == null ? "" : String(v))' "$1"
}

newest_tag() {
	git tag --merged "$1" --sort=-v:refname 2>/dev/null | grep -E "$semver" | head -n 1 || true
}

bump_kind() {
	local from=${1#v} to=${2#v}
	if [ "${to%%.*}" != "${from%%.*}" ]; then
		echo major
	elif [ "$(echo "$to" | cut -d. -f2)" != "$(echo "$from" | cut -d. -f2)" ]; then
		echo minor
	else
		echo patch
	fi
}

if [ "$(git rev-parse --is-shallow-repository)" = true ]; then
	fail 'this is a shallow clone; check out with actions/checkout and fetch-depth: 0 so chamoji sees every commit and tag'
fi

if [ "$mode" = auto ]; then
	case "${GITHUB_EVENT_NAME:-}:${GITHUB_REF:-}" in
		push:refs/tags/*) mode=notes ;;
		pull_request:* | pull_request_target:*) mode=comment ;;
		*) fail "can't pick a mode for the ${GITHUB_EVENT_NAME:-unknown} event; set mode to notes, comment or release" ;;
	esac
fi

case "$mode" in
notes)
	tag=${CHAMOJI_TAG:-${GITHUB_REF#refs/tags/}}
	previous=$(newest_tag "$tag^")
	notes="$work/chamoji-notes.md"
	if [ -n "$previous" ]; then
		chamoji changelog --to "$tag" --from "$previous" | strip_title >"$notes"
	else
		chamoji changelog --to "$tag" | strip_title >"$notes"
	fi

	prerelease=
	case "$tag" in *-*) prerelease=--prerelease ;; esac
	if gh release view "$tag" >/dev/null 2>&1; then
		gh release edit "$tag" --notes-file "$notes"
	else
		gh release create "$tag" --title "$tag" --notes-file "$notes" $prerelease
	fi

	{
		echo "version=$tag"
		echo "notes-file=$notes"
	} >>"$output"
	cat "$notes" >>"$summary"
	;;

comment)
	pr=${CHAMOJI_PR:-$(event pull_request.number)}
	base=${CHAMOJI_BASE_SHA:-$(event pull_request.base.sha)}
	head=${CHAMOJI_HEAD_SHA:-$(event pull_request.head.sha)}
	repo=${GH_REPO:-${GITHUB_REPOSITORY:-}}
	[ -n "$pr" ] && [ -n "$base" ] && [ -n "$head" ] || fail 'comment mode needs a pull_request event'

	# Section headings drop a level so they sit under the comment's title.
	lines=$(chamoji changelog --since "$base" --to "$head" | strip_title | sed '1{/^## /d;}' | awk 'NF { started = 1 } started' | sed 's/^### /#### /')
	last=$(newest_tag "$head")
	set +e
	next=$(chamoji next-version --to "$head" 2>/dev/null)
	status=$?
	set -e
	prefix=v
	case "$last" in [0-9]*) prefix= ;; esac
	if [ -z "$last" ]; then
		headline='There are no release tags yet, so this is part of the first release.'
	elif [ "$status" -eq 3 ]; then
		headline='Nothing here needs a release on its own: only docs, tests, refactors or similar.'
	elif [ "$status" -eq 0 ]; then
		headline="Merging this makes the next release **${prefix}${next}** ($(bump_kind "$last" "$next"))."
	else
		fail "next-version failed with exit code $status"
	fi

	body="$work/chamoji-comment.md"
	{
		echo "$marker"
		echo '### Changelog preview'
		echo
		echo "$headline"
		echo
		if [ -n "$lines" ]; then echo "$lines"; else echo '_No commits in this PR add changelog lines._'; fi
		echo
		echo '<sub>From [chamoji](https://github.com/HeavenlyEntity/chamoji-ai), updated on every push.</sub>'
	} >"$body"
	cat "$body" >>"$summary"

	# Find our earlier comment: the marker, written by the account this token
	# acts as, so a comment that merely quotes the marker is never taken over.
	# Then update it or post a new one. A token that can't comment (fork PRs)
	# leaves the preview in the summary.
	author=${CHAMOJI_COMMENT_AUTHOR:-github-actions[bot]}
	case "$author" in *[!A-Za-z0-9\[\]-]*) fail "comment-author must be a GitHub login, not $author" ;; esac
	if existing=$(gh api "repos/$repo/issues/$pr/comments" --paginate --jq ".[] | select(.user.login == \"$author\" and (.body | contains(\"$marker\"))) | .id" 2>/dev/null); then
		id=$(echo "$existing" | head -n 1)
		if [ -n "$id" ]; then
			gh api -X PATCH "repos/$repo/issues/comments/$id" -F "body=@$body" >/dev/null 2>&1 && exit 0
		else
			gh api -X POST "repos/$repo/issues/$pr/comments" -F "body=@$body" >/dev/null 2>&1 && exit 0
		fi
	fi

	echo "::warning::chamoji: couldn't post the PR comment (a fork PR's token can't), so the preview is in the job summary"
	;;

release)
	git config user.name 'github-actions[bot]'
	git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
	set +e
	if [ -n "${CHAMOJI_RELEASE_VERSION:-}" ]; then
		result=$(chamoji release "$CHAMOJI_RELEASE_VERSION" --push --json)
	else
		result=$(chamoji release --push --json)
	fi
	status=$?
	set -e
	if [ "$status" -eq 3 ]; then
		echo 'chamoji: nothing to release since the last tag' | tee -a "$summary"
		exit 0
	fi

	[ "$status" -eq 0 ] || fail "chamoji release failed with exit code $status"
	version=$(printf '%s' "$result" | node -e 'let s = ""; process.stdin.on("data", d => (s += d)).on("end", () => process.stdout.write(JSON.parse(s).tag))')
	printf '%s' "$result" | node -e 'let s = ""; process.stdin.on("data", d => (s += d)).on("end", () => process.stdout.write(JSON.parse(s).notes + "\n"))' >>"$summary"
	echo "version=$version" >>"$output"
	;;

*)
	fail "unknown mode $mode (use auto, notes, comment or release)"
	;;
esac
