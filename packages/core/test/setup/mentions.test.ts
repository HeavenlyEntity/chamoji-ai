import {afterEach, expect, test} from 'vitest';
import {detectMentions} from '../../src/setup/mentions.js';
import {readWorkspace} from '../../src/index.js';
import {createRepo, type FixtureRepo} from '../helpers/fixture-repo.js';

let current: FixtureRepo | undefined;
afterEach(async () => {
	await current?.cleanup();
	current = undefined;
});

async function repoWith(files: Record<string, string>) {
	current = await createRepo([{commit: '🎉 Start', files}]);
	return current.dir;
}

const manifest = (name: string, extra: object = {}) =>
	JSON.stringify({name, version: '1.0.0', ...extra});

test('owner/repo@v<version> in tracked Markdown is offered', async () => {
	const dir = await repoWith({
		'package.json': manifest('tool', {private: true}),
		'readme.md': 'Use `uses: acme/tool@v1.2.0` in your workflow.\n',
		'docs/a.mdx': 'Pin acme/tool@v1.0.0 for now.\n',
		'docs/b.md': 'Nothing pinned here.\n',
		// Another repo's pin, and a longer name, are not this repo's.
		'docs/c.md': 'other/tool@v1.0.0 and not-acme/tool@v1.0.0\n',
		'CHANGELOG.md': 'acme/tool@v0.1.0\n',
	});
	expect(await detectMentions(dir, 'acme/tool', [])).toEqual([
		{pattern: 'acme/tool@v{version}', files: ['docs/a.mdx', 'readme.md']},
	]);
});

test('<package name>@<version> is offered for a public package', async () => {
	const dir = await repoWith({
		'package.json': manifest('root', {private: true}),
		'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
		'packages/ui/package.json': manifest('@acme/ui'),
		'packages/internal/package.json': manifest('@acme/internal', {
			private: true,
		}),
		'README.md': 'npm i @acme/ui@1.0.0\n\nnpm i @acme/internal@1.0.0\n',
	});
	const packages = await readWorkspace(dir);
	expect(await detectMentions(dir, null, packages)).toEqual([
		{pattern: '@acme/ui@{version}', files: ['README.md'], unit: 'ui'},
	]);
});

test('nothing is offered when no Markdown mentions a version', async () => {
	const dir = await repoWith({
		'package.json': manifest('tool'),
		'readme.md': 'A tool. See acme/tool for more.\n',
		'src/index.ts': 'export const pin = "acme/tool@v1.0.0";\n',
	});
	expect(
		await detectMentions(dir, 'acme/tool', [
			{
				name: 'tool',
				path: '',
				version: '1.0.0',
				private: false,
				runtimeDeps: [],
				ranges: {},
			},
		]),
	).toEqual([]);
	expect(await detectMentions(dir, null, [])).toEqual([]);
});

test('a file with glob characters in its name is matched literally', async () => {
	const dir = await repoWith({
		'package.json': manifest('tool'),
		'docs/[id].md': 'acme/tool@v1.0.0\n',
	});
	expect(await detectMentions(dir, 'acme/tool', [])).toEqual([
		{pattern: 'acme/tool@v{version}', files: [String.raw`docs/\[id\].md`]},
	]);
});
