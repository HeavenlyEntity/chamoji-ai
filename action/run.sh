#!/usr/bin/env bash
# The chamoji GitHub Action; action.yml runs this. Everything arrives as
# environment variables, never as ${{ }} expressions pasted into the script.
#
#   CHAMOJI_MODE      auto (default), notes, comment, release or card
#   CHAMOJI_CLI       command to run chamoji; default: npx @chamoji/cli@$CHAMOJI_VERSION
#   CHAMOJI_VERSION   chamoji version for npx; default: latest
#   CHAMOJI_AI        true to pass --ai (needs TYPESAFE_API_KEY)
#   CHAMOJI_RELEASE_VERSION  release mode: the version to release; default: from the commits
#   CHAMOJI_UNIT      release mode: only release this unit (a repo with release units)
#   CHAMOJI_COMMENT_AUTHOR   comment mode: login that owns the preview comment; default: github-actions[bot]
#   CHAMOJI_CARD_URL     card mode: the renderer; default: https://chamoji.dev/api/card
#   CHAMOJI_CARD_BRANCH  card mode: the branch that holds only card.png; default: chamoji-card
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

# What chamoji.config.json says about releases: "none" (no release section, or
# a file that can't be read; the CLI reports a broken file itself), "single"
# (shape single) or "units" (any other shape).
release_config() {
	node -e '
		try {
			const release = JSON.parse(require("fs").readFileSync("chamoji.config.json", "utf8")).release;
			if (typeof release !== "object" || release === null) process.stdout.write("none");
			else process.stdout.write(release.shape === "single" ? "single" : "units");
		} catch {
			process.stdout.write("none");
		}
	'
}
config_release=$(release_config)
units=false
[ "$config_release" = units ] && units=true

# Release settings came with chamoji 0.13.0; an older CLI would ignore them.
if [ "$config_release" != none ]; then
	probe_error="$work/chamoji-version.err"
	cli_version=$("${cli[@]}" --version --no-update-check 2>"$probe_error" | head -n 1 || true)
	if [ -z "$cli_version" ]; then
		fail "couldn't run chamoji to check its version: $(head -c 300 "$probe_error" | tr '\n' ' ')"
	fi
	if ! node -e '
		const parse = text => (/^v?(\d+)\.(\d+)\.(\d+)/.exec(text) ?? []).slice(1).map(Number);
		const [have, need] = [parse(process.argv[1]), [0, 13, 0]];
		if (have.length !== 3) process.exit(1);
		for (let i = 0; i < 3; i++) if (have[i] !== need[i]) process.exit(have[i] > need[i] ? 0 : 1);
	' "$cli_version"; then
		fail "this repo's release settings need chamoji 0.13.0 or newer; set chamoji-version"
	fi
fi

if [ "$mode" = auto ]; then
	case "${GITHUB_EVENT_NAME:-}:${GITHUB_REF:-}" in
		push:refs/tags/*) mode=notes ;;
		pull_request:* | pull_request_target:*) mode=comment ;;
		*) fail "can't pick a mode for the ${GITHUB_EVENT_NAME:-unknown} event; set mode to notes, comment, release or card" ;;
	esac
fi

case "$mode" in
notes)
	tag=${CHAMOJI_TAG:-${GITHUB_REF#refs/tags/}}
	notes="$work/chamoji-notes.md"
	prerelease=
	if [ "$units" = true ]; then
		# The unit that owns the tag writes its own section. A prerelease has a
		# suffix right after a x.y.z, so a hyphen in a name (web-v1.0.0) doesn't count.
		chamoji changelog --for-tag "$tag" | strip_title >"$notes"
		if printf '%s' "$tag" | grep -Eq '[0-9]+\.[0-9]+\.[0-9]+-'; then prerelease=--prerelease; fi
	else
		if ! printf '%s' "$tag" | grep -Eq "$semver"; then
			echo "chamoji: $tag isn't a whole-repo version tag; leaving its release alone"
			exit 0
		fi
		previous=$(newest_tag "$tag^")
		if [ -n "$previous" ]; then
			chamoji changelog --to "$tag" --from "$previous" | strip_title >"$notes"
		else
			chamoji changelog --to "$tag" | strip_title >"$notes"
		fi
		case "$tag" in *-*) prerelease=--prerelease ;; esac
	fi
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

	body="$work/chamoji-comment.md"
	if [ "$units" = true ]; then
		# A repo with release units previews what this PR adds to each unit's next
		# release. The CLI plans from the checkout, so it runs in a detached
		# worktree at the PR's head (the default checkout may be the base, as under
		# pull_request_target), and the lines are cut down to the PR's own commits.
		# The PR's files are untrusted (under pull_request_target this job holds
		# secrets and a write token), so the barrier is that no PR-controlled code
		# runs: the CLI is resolved to absolute paths from the trusted workspace
		# before the PR's worktree exists, and it may only be node running a built
		# CLI file or chamoji itself, with no option words. A package manager, a
		# shell wrapper or a loader such as tsx could read the PR's .npmrc,
		# scripts, node_modules or other files relative to the working directory.
		# The environment allowlist below is defense in depth, not the barrier.
		unit_cli_help='unset cli or point it at a built CLI (for example node packages/cli/dist/cli.js)'
		unit_cli_rule='unit-mode PR previews run only node with a built CLI file, or chamoji itself; unset cli or use node packages/cli/dist/cli.js'
		trusted=()
		if [ -n "${CHAMOJI_CLI:-}" ]; then
			case "${cli[0]##*/}" in
				chamoji) ;;
				node) [ "${#cli[@]}" -gt 1 ] || fail "$unit_cli_rule" ;;
				*) fail "$unit_cli_rule" ;;
			esac
			resolved=$(command -v -- "${cli[0]}") || fail "unit-mode PR previews need the cli's command to exist: ${cli[0]}"
			case "$resolved" in /*) ;; *) fail "unit-mode PR previews need an absolute command, but ${cli[0]} resolves to $resolved" ;; esac
			trusted=("$resolved")
			for word in "${cli[@]:1}"; do
				case "$word" in
					-*) fail "unit-mode PR previews can't take the option $word in cli, which could load files from the PR; $unit_cli_help" ;;
					/*) [ -f "$word" ] || fail "unit-mode PR previews need $word to be a file"; trusted+=("$word") ;;
					*) [ -f "$PWD/$word" ] || fail "unit-mode PR previews need $word to be a file in the workspace, not in the PR; $unit_cli_help"; trusted+=("$PWD/$word") ;;
				esac
			done
		else
			prefix_dir="$work/chamoji-cli"
			npm install --prefix "$prefix_dir" --no-save --ignore-scripts --no-audit --no-fund "@chamoji/cli@${CHAMOJI_VERSION:-latest}" >&2 || fail "couldn't install @chamoji/cli@${CHAMOJI_VERSION:-latest} to preview the PR"
			trusted=("$prefix_dir/node_modules/.bin/chamoji")
		fi

		# Calls in the worktree get a short allowlist instead of the job's
		# environment, and a PATH without relative or empty entries. Neither
		# next-version (fetch is off) nor changelog --unit touches the network.
		env_bin=$(command -v env)
		case "$env_bin" in /*) ;; *) fail "couldn't find an absolute env command" ;; esac
		safe_path=
		IFS=: read -r -a path_words <<<"${PATH:-}"
		for word in ${path_words[@]+"${path_words[@]}"}; do
			case "$word" in /*) safe_path=${safe_path:+$safe_path:}$word ;; esac
		done
		allowed=("PATH=$safe_path" GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0)
		for name in HOME LANG LC_ALL TMPDIR TZ CI; do
			if [ -n "${!name+x}" ]; then allowed+=("$name=${!name}"); fi
		done
		in_worktree() {
			(cd "$wt" && "$env_bin" -i "${allowed[@]}" "${trusted[@]}" "$@" --no-update-check)
		}

		wt="$work/chamoji-head"
		cleanup_worktree() {
			git worktree remove --force "$wt" >/dev/null 2>&1 || true
			git worktree prune >/dev/null 2>&1 || true
		}
		trap cleanup_worktree EXIT
		cleanup_worktree
		# The PR's .gitattributes must not run a smudge filter (git-lfs would read
		# the PR's .lfsconfig).
		GIT_LFS_SKIP_SMUDGE=1 git -c filter.lfs.smudge= -c filter.lfs.process= -c filter.lfs.required=false worktree add --detach --quiet "$wt" "$head" || fail "couldn't check out $head to preview the PR"

		# next-version exits 3 when no unit releases, still printing every unit.
		set +e
		versions=$(in_worktree next-version --json)
		status=$?
		set -e
		{ [ "$status" -eq 0 ] || [ "$status" -eq 3 ]; } || fail "next-version failed with exit code $status"

		# Each unit's unreleased lines, from its own changelog, in a file per unit.
		rm -f "$work"/chamoji-unit-*.md
		index=0
		while IFS= read -r name; do
			set +e
			in_worktree changelog --unit "$name" >"$work/chamoji-unit-$index.md"
			status=$?
			set -e
			[ "$status" -eq 0 ] || fail "changelog --unit $name failed with exit code $status"
			index=$((index + 1))
		done < <(printf '%s' "$versions" | node -e 'let s = ""; process.stdin.on("data", d => (s += d)).on("end", () => process.stdout.write(JSON.parse(s).units.map(u => u.unit).join("\n") + "\n"))')

		commits=$(git rev-list --no-merges "$base..$head")
		CHAMOJI_VERSIONS=$versions CHAMOJI_WORK=$work CHAMOJI_MARKER=$marker CHAMOJI_PR_COMMITS=$commits node -e '
			const fs = require("fs");
			const {units} = JSON.parse(process.env.CHAMOJI_VERSIONS);
			const commits = process.env.CHAMOJI_PR_COMMITS.split("\n").filter(Boolean);
			const inPr = text => {
				const hash = /\(([0-9a-f]{7,40})\)/.exec(text)?.[1];
				return hash !== undefined && commits.some(full => full.startsWith(hash));
			};
			const out = [process.env.CHAMOJI_MARKER, "### Changelog preview", ""];
			const heads = [];
			const sections = [];
			units.forEach((unit, index) => {
				// Only the Unreleased part, and in it only the lines this PR added.
				const text = fs.readFileSync(`${process.env.CHAMOJI_WORK}/chamoji-unit-${index}.md`, "utf8");
				const unreleased = /^## Unreleased\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text)?.[1] ?? "";
				const kept = [];
				let heading;
				let own = 0;
				let shared = 0;
				for (const line of unreleased.split("\n")) {
					if (/^### /.test(line)) heading = line.replace(/^### /, "##### ");
					else if (/^- /.test(line) && inPr(line)) {
						if (heading !== undefined) kept.push("", heading, "");
						heading = undefined;
						kept.push(line);
						if (line.includes("(via ")) shared++;
						else own++;
					}
				}
				if (own + shared === 0) return;
				const versioned = unit.version !== null;
				if (own > 0) heads.push(versioned ? `- ${unit.unit} → ${unit.version}` : `- ${unit.unit}: no release yet`);
				else heads.push(versioned ? `- ${unit.unit} → ${unit.version} (rides along with its next release)` : `- ${unit.unit}: rides along`);
				sections.push("", `#### ${unit.unit}${versioned ? ` ${unit.version}` : ""}`, ...kept);
			});
			if (heads.length === 0) {
				out.push("This PR adds nothing to any unit’s release notes.", "", "_No commits in this PR add changelog lines._");
			} else {
				out.push("After merging, the next releases would be:", "", ...heads, ...sections);
			}
			out.push("", "<sub>From [chamoji](https://github.com/HeavenlyEntity/chamoji-ai), updated on every push.</sub>");
			process.stdout.write(out.join("\n") + "\n");
		' >"$body"
		cleanup_worktree
		trap - EXIT
	else
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
	fi
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
	unit_args=()
	[ -z "${CHAMOJI_UNIT:-}" ] || unit_args=(--unit "$CHAMOJI_UNIT")
	set +e
	if [ -n "${CHAMOJI_RELEASE_VERSION:-}" ]; then
		result=$(chamoji release "$CHAMOJI_RELEASE_VERSION" ${unit_args[@]+"${unit_args[@]}"} --push --json)
	else
		result=$(chamoji release ${unit_args[@]+"${unit_args[@]}"} --push --json)
	fi
	status=$?
	set -e
	if [ "$status" -eq 3 ]; then
		echo 'chamoji: nothing to release since the last tag' | tee -a "$summary"
		exit 0
	fi

	[ "$status" -eq 0 ] || fail "chamoji release failed with exit code $status"
	version=$(printf '%s' "$result" | node -e 'let s = ""; process.stdin.on("data", d => (s += d)).on("end", () => { const j = JSON.parse(s); process.stdout.write(j.units ? j.units.map(u => u.tag).join(", ") : j.tag) })')
	printf '%s' "$result" | node -e 'let s = ""; process.stdin.on("data", d => (s += d)).on("end", () => { const j = JSON.parse(s); process.stdout.write((j.units ? j.units.map(u => `## ${u.tag}\n\n${u.notes.replace(/^## .*\n+/, "")}`).join("\n\n") : j.notes) + "\n") })' >>"$summary"
	echo "version=$version" >>"$output"
	;;

card)
	# Saves the repo's card image alone on its own branch, so a README can link to
	# it. It force-pushes, but only over the branch it inspected (one that doesn't
	# exist yet or holds exactly card.png), which a lease enforces at push time.
	# It never changes the checkout: no git config, no worktree, no --depth.
	# Nothing here asks Jev, so it calls the CLI directly.
	branch=${CHAMOJI_CARD_BRANCH:-chamoji-card}
	repo=${GH_REPO:-${GITHUB_REPOSITORY:-}}
	[ -n "$repo" ] || fail 'card mode needs the repository as owner/name (GH_REPO or GITHUB_REPOSITORY)'
	git check-ref-format --branch "$branch" >/dev/null 2>&1 || fail "card-branch isn't a branch name: $branch"
	url=$("${cli[@]}" card --repo "$repo" --endpoint "${CHAMOJI_CARD_URL:-https://chamoji.dev/api/card}" --no-update-check) || fail "chamoji card failed with exit code $?"

	# A renderer that is down, refuses the card's details, or answers with
	# something that isn't a PNG leaves the branch as it was. None of these fail
	# the job: the card is decoration, and the next run tries again.
	card_warning() {
		echo "::warning::chamoji: $*"
		echo "chamoji: $*" >>"$summary"
	}
	# What the branch holds, for the warnings: true whether or not a card exists.
	card_state() {
		local found=0
		git ls-remote --exit-code origin "refs/heads/$branch" >/dev/null 2>&1 || found=$?
		case "$found" in
			0) echo "$branch keeps its last card" ;;
			2) echo "$branch has no card yet" ;;
			*) echo "$branch is unchanged" ;;
		esac
	}

	image="$work/chamoji-card.png"
	rm -f "$image"
	http=
	if ! http=$(curl --fail --silent --show-error --location --retry 2 --max-time 30 --write-out '%{http_code}' --output "$image" "$url"); then
		case "$http" in
			4??)
				tag=$(printf '%s' "$url" | sed -n 's/.*[?&]version=\([^&]*\).*/\1/p' | sed 's/%2B/+/g')
				what="repo $repo"
				[ -z "$tag" ] || what="release $tag"
				card_warning "the card renderer refused the card's details (HTTP $http, $what), so $(card_state); check the repo name and that the latest tag is semver such as v1.2.3, at most 64 characters"
				;;
			*) card_warning "the card renderer didn't answer, so $(card_state)" ;;
		esac
		exit 0
	fi
	if [ "$(head -c 8 "$image" | od -An -tx1 | tr -d ' \n')" != 89504e470d0a1a0a ]; then
		card_warning "the card renderer didn't send a PNG, so $(card_state)"
		exit 0
	fi

	current=
	tip=
	set +e
	git ls-remote --exit-code origin "refs/heads/$branch" >/dev/null 2>&1
	status=$?
	set -e
	case "$status" in
		0)
			git fetch --quiet --no-tags origin "+refs/heads/$branch:refs/chamoji/card" || fail "couldn't fetch $branch from origin"
			[ "$(git ls-tree -r --name-only refs/chamoji/card)" = card.png ] || fail "$branch holds more than card.png, so chamoji won't overwrite it; pick another card-branch"
			tip=$(git rev-parse refs/chamoji/card)
			current=$(git rev-parse refs/chamoji/card:card.png)
			;;
		2) ;;
		*) fail "couldn't read $branch from origin; the job needs contents: write" ;;
	esac

	blob=$(git hash-object -w --no-filters "$image")
	if [ "$blob" = "$current" ]; then
		echo "chamoji: the card on $branch is already up to date" | tee -a "$summary"
	else
		tree=$(printf '100644 blob %s\tcard.png\n' "$blob" | git mktree)
		commit=$(
			GIT_AUTHOR_NAME='github-actions[bot]' GIT_AUTHOR_EMAIL='41898282+github-actions[bot]@users.noreply.github.com' \
				GIT_COMMITTER_NAME='github-actions[bot]' GIT_COMMITTER_EMAIL='41898282+github-actions[bot]@users.noreply.github.com' \
				git commit-tree "$tree" -m '🍱 Update the chamoji card [skip ci]'
		)
		# The lease makes the push refuse if the branch moved since we looked at it.
		git push --quiet --force-with-lease="refs/heads/$branch:$tip" origin "$commit:refs/heads/$branch" || fail "couldn't push to $branch; it changed during this run, or the job needs contents: write"
	fi
	echo "card-url=https://raw.githubusercontent.com/$repo/$branch/card.png" >>"$output"
	;;

*)
	fail "unknown mode $mode (use auto, notes, comment, release or card)"
	;;
esac
