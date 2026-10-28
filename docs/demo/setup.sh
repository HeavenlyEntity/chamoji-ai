#!/usr/bin/env bash
# Builds the throwaway repo the readme demo records (docs/demo/demo.tape):
# plain, unstructured commit messages since a v1.2.0 tag, with fixed dates.
# Also puts a `chamoji` on PATH that runs this checkout's build.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
repo=/tmp/chamoji-demo
bin=/tmp/chamoji-demo-bin

rm -rf "$repo" "$bin"
mkdir -p "$repo" "$bin"
printf '#!/usr/bin/env bash\nexec node %q "$@" --no-update-check\n' "$root/packages/cli/dist/cli.js" >"$bin/chamoji"
chmod +x "$bin/chamoji"

cd "$repo"
git init -q -b main
git config user.name 'Dev'
git config user.email 'dev@example.com'
day=0
commit() {
	day=$((day + 1))
	echo "$1" >>log.txt
	git add -A
	GIT_AUTHOR_DATE="2026-10-$(printf %02d "$day")T12:00:00Z" \
		GIT_COMMITTER_DATE="2026-10-$(printf %02d "$day")T12:00:00Z" \
		git commit -q -m "$1"
}

printf '{\n  "name": "widgets",\n  "version": "1.2.0"\n}\n' >package.json
commit 'Initial commit'
commit 'Add the user list'
git tag -a v1.2.0 -m v1.2.0
commit 'Add CSV export'
commit 'Bump vite from 5.1.0 to 5.2.0'
commit 'Fix crash when the list is empty'
commit 'Bump vitest from 1.3.0 to 1.4.0'
commit 'Fix typos in the readme'
commit 'Bump typescript from 5.3.3 to 5.4.2'
commit 'Remove the legacy importer'
commit 'Speed up table rendering'
