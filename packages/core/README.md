# @chamoji/core

The engine behind [`@chamoji/cli`](https://www.npmjs.com/package/@chamoji/cli). It reads git history, parses gitmoji and Conventional Commits messages, groups commits into changelog sections, suggests the next semver version, and renders Markdown, HTML or JSON. It has no UI and makes no network calls. Needs Node.js 22+ and git.

```js
import {buildChangelog, loadConfig, render} from '@chamoji/core';

const cwd = process.cwd();
const changelog = await buildChangelog({cwd, config: await loadConfig(cwd)});
console.log(render(changelog, 'markdown'));
```

Lower-level pieces are exported too: `parseCommit`, `findGitmoji`, `groupCommits`, `bumpFor`, `nextVersion`, `readCommits`, `listReleaseTags`, `renderMarkdown`, `renderHtml` and `renderJson`.

MIT licensed.
