import {execFile} from 'node:child_process';
import {
	createRepo,
	type FixtureRepo,
	type RepoStep,
} from '../../../core/test/helpers/fixture-repo.js';

const json = (value: unknown) => `${JSON.stringify(value, null, '\t')}\n`;

/** chamoji-ai's own shape: two packages under packages/ that ship in lockstep. */
const LOCKSTEP: RepoStep[] = [
	{
		commit: '🎉 Start the project',
		files: {
			'package.json': json({name: 'chamoji-workspace', private: true}),
			'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
			'packages/core/package.json': json({
				name: '@acme/core',
				version: '0.1.0',
			}),
			'packages/cli/package.json': json({name: '@acme/cli', version: '0.1.0'}),
		},
	},
	{tag: 'v0.1.0', annotated: true},
	{
		commit: '✨ Read commits from git',
		body: 'Why: everything else builds on the log.',
		files: {'packages/core/src/git.ts': 'git\n'},
	},
	{
		commit: '🐛 Fix the empty range crash (#4)',
		files: {'packages/core/src/range.ts': 'range\n'},
	},
	{mergeBranch: 'feature/render', commits: ['✨ Render the changelog']},
	{
		commit: '📝 Write the usage section',
		files: {'readme.md': 'usage\n'},
	},
	{
		commit: '♻️ Split the runner',
		files: {'packages/cli/src/run.ts': 'run\n'},
	},
	{commit: 'Tidy things up'},
];

/** A single package that tags without a `v`. */
const SINGLE: RepoStep[] = [
	{
		commit: '🎉 Start the project',
		files: {
			'package.json': json({name: 'widgets', version: '1.0.0'}),
		},
	},
	{tag: '1.0.0'},
	{commit: '✨ Add the widget list', files: {'src/list.ts': 'list\n'}},
	{tag: '1.1.0'},
	{
		commit: '💥 Rename the widget id',
		body: 'BREAKING CHANGE: ids are strings now.',
		files: {'src/id.ts': 'id\n'},
	},
	{commit: '🐛 Fix the sort order', files: {'src/sort.ts': 'sort\n'}},
	{commit: '🔧 Update the lint config'},
];

export const COMPAT_REPOS: Record<string, RepoStep[]> = {
	lockstep: LOCKSTEP,
	single: SINGLE,
};

export const COMPAT_COMMANDS: Record<string, string[]> = {
	'release-dry-run-json': ['release', '--dry-run', '--json'],
	'next-version': ['next-version'],
	changelog: ['changelog'],
	'changelog-json': ['changelog', '--format', 'json'],
};

/**
 * The one thing either CLI prints that changes from day to day: the release
 * heading in `release --dry-run --json` carries today's date. It becomes
 * `<today>` in what is saved and in what is compared.
 */
export function normalise(text: string): string {
	return text.replace(/("notes": "## \S+ - )\d{4}-\d{2}-\d{2}/g, '$1<today>');
}

export type CompatResult = {stdout: string; stderr: string; code: number};

/**
 * Runs `cliArgv` (the CLI to try, such as ['node', 'dist/cli.js']) with
 * `args` in `repo`. The environment is fixed so the same run gives the same
 * bytes: no CI, no TTY, no animation, no update check, and a git config that
 * is empty.
 */
export async function runCompat(
	cliArgv: string[],
	repo: FixtureRepo,
	args: string[],
): Promise<CompatResult> {
	const env: NodeJS.ProcessEnv = {...process.env};
	for (const name of [
		'CI',
		'FORCE_COLOR',
		'NO_COLOR',
		'COLORFGBG',
		'CHAMOJI_THEME',
		'CHAMOJI_ASCII',
	]) {
		delete env[name];
	}

	env['CHAMOJI_NO_ANIMATION'] = '1';
	env['CHAMOJI_NO_UPDATE_CHECK'] = '1';
	env['GIT_CONFIG_GLOBAL'] = `${repo.dir}.gitconfig`;
	env['GIT_CONFIG_NOSYSTEM'] = '1';

	const [command, ...prefix] = cliArgv;
	return new Promise(resolve => {
		execFile(
			command!,
			[...prefix, ...args],
			{cwd: repo.dir, env, maxBuffer: 16 * 1024 * 1024},
			(error, stdout, stderr) => {
				const code =
					error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
				resolve({stdout: normalise(stdout), stderr: normalise(stderr), code});
			},
		);
	});
}

export async function buildCompatRepo(name: string): Promise<FixtureRepo> {
	return createRepo(COMPAT_REPOS[name]!);
}
