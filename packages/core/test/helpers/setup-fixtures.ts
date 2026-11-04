import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {createRepo, type FixtureRepo, type RepoStep} from './fixture-repo.js';

const execFileAsync = promisify(execFile);

/**
 * Options for `gearzLayout`. Later tasks add to this object (a template
 * remote with tags, a merge from upstream), so callers always pass it by name.
 */
export type GearzOptions = {
	/** Extra steps replayed after the initial commit. */
	extraSteps?: RepoStep[];
	/**
	 * Fork the gearz commits from a Makerkit-style template: 30 commits by
	 * Makerkit Bot tagged 4.0.1, 4.0.2 and v4.0.2-1, cloned with origin renamed
	 * to upstream. The fork's own commits are by Gearz Dev, and a stray
	 * wip/crm-pipeline-stages tag sits on the first of them.
	 */
	template?: boolean;
	/**
	 * With `template`: after the fork's own commits the template gains 3
	 * commits (the last adds apps/web/next.config.mjs) and the tag 4.0.3, and
	 * the fork fetches upstream and merges it with a real merge commit.
	 */
	sync?: boolean;
	/**
	 * With `template`: after the fork's own commits the template grows a
	 * v3-step branch of 2 commits by Makerkit Bot under apps/web (its tip
	 * tagged 4.1.0 when 'tagged'), the fork merges it with "chore(makerkit):
	 * merge v3-step", the template deletes the branch and the fork prunes it.
	 * Then the fork keeps working: 50 empty own commits, then "✨ Add
	 * invoices" to web, so its newest authors are its own.
	 */
	prunedBranch?: 'tagged' | 'untagged';
};

const TEMPLATE_AUTHOR = {name: 'Makerkit Bot', email: 'bot@makerkit.dev'};
const FORK_AUTHOR = {name: 'Gearz Dev', email: 'dev@gearz.example'};
const TEMPLATE_COMMITS = 30;
const TEMPLATE_TAGS: Record<number, string> = {
	10: '4.0.1',
	20: '4.0.2',
	30: 'v4.0.2-1',
};

function templateSteps(): RepoStep[] {
	const steps: RepoStep[] = [];
	for (let n = 1; n <= TEMPLATE_COMMITS; n++) {
		steps.push({
			commit: `Update the kit (${n})`,
			files: {'README.md': `# Next Supabase SaaS Kit Turbo\n\nRevision ${n}\n`},
		});
		const tag = TEMPLATE_TAGS[n];
		if (tag) steps.push({tag});
	}

	return steps;
}

/**
 * A template at <tmp>/makerkit/next-supabase-saas-kit-turbo (ruling R1), its
 * commits by Makerkit Bot, and a fork of it replaying `steps` as Gearz Dev,
 * with origin renamed to upstream.
 */
async function forkOfTemplate(
	steps: RepoStep[],
	fromTemplate: RepoStep[] = templateSteps(),
	sync = false,
	pruned?: GearzOptions['prunedBranch'],
): Promise<FixtureRepo> {
	const base = await mkdtemp(path.join(tmpdir(), 'chamoji-template-'));
	const template = await createRepo(fromTemplate, {
		dir: path.join(base, 'makerkit', 'next-supabase-saas-kit-turbo'),
		author: TEMPLATE_AUTHOR,
	});
	const fork = await createRepo(steps, {
		clone: template.dir,
		author: FORK_AUTHOR,
	});
	await execFileAsync('git', ['remote', 'rename', 'origin', 'upstream'], {
		cwd: fork.dir,
	});
	if (sync) await syncFromTemplate(template.dir, fork.dir);
	if (pruned) await mergePrunedBranch(template.dir, fork.dir, pruned);
	return {
		dir: fork.dir,
		async cleanup() {
			await fork.cleanup();
			await template.cleanup();
			await rm(base, {recursive: true, force: true});
		},
	};
}

const SYNC_COMMITS = 3;
/** The file the last sync commit adds, so the merge changes web. */
const WEB_FILE = 'apps/web/next.config.mjs';

/** The template gains commits and 4.0.3; the fork fetches and merges them. */
async function syncFromTemplate(template: string, fork: string): Promise<void> {
	const when = '2026-06-01T00:00:00Z';
	const env = {
		...process.env,
		GIT_AUTHOR_DATE: when,
		GIT_COMMITTER_DATE: when,
	};
	const run = async (cwd: string, args: string[], who: typeof FORK_AUTHOR) =>
		execFileAsync(
			'git',
			['-c', `user.name=${who.name}`, '-c', `user.email=${who.email}`, ...args],
			{cwd, env},
		);
	for (let n = 1; n <= SYNC_COMMITS; n++) {
		await writeFile(
			path.join(template, 'README.md'),
			`# Next Supabase SaaS Kit Turbo\n\nRevision ${TEMPLATE_COMMITS + n}\n`,
		);
		await run(template, ['add', '--', 'README.md'], TEMPLATE_AUTHOR);
		if (n === SYNC_COMMITS) {
			// As in the real kit, the sync reaches the web app.
			await mkdir(path.join(template, 'apps/web'), {recursive: true});
			await writeFile(path.join(template, WEB_FILE), 'export default {};\n');
			await run(template, ['add', '--', WEB_FILE], TEMPLATE_AUTHOR);
		}

		await run(
			template,
			['commit', '-q', '-m', `Update the kit (${TEMPLATE_COMMITS + n})`],
			TEMPLATE_AUTHOR,
		);
	}

	await run(template, ['tag', '4.0.3'], TEMPLATE_AUTHOR);
	await run(fork, ['fetch', '-q', 'upstream'], FORK_AUTHOR);
	await run(
		fork,
		['merge', '--no-ff', '-q', '-m', 'Merge upstream', 'upstream/main'],
		FORK_AUTHOR,
	);
}

/** Template subjects on the pruned branch; none may reach release notes. */
export const PRUNED_SUBJECTS = ['✨ Template step one', '✨ Template step two'];

async function mergePrunedBranch(
	template: string,
	fork: string,
	kind: 'tagged' | 'untagged',
): Promise<void> {
	let minute = 0;
	const run = async (cwd: string, args: string[], who: typeof FORK_AUTHOR) => {
		const when = new Date(
			Date.parse('2026-07-01T00:00:00Z') + minute++ * 60_000,
		).toISOString();
		return execFileAsync(
			'git',
			['-c', `user.name=${who.name}`, '-c', `user.email=${who.email}`, ...args],
			{
				cwd,
				env: {...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when},
			},
		);
	};

	await run(template, ['switch', '-q', '-c', 'v3-step'], TEMPLATE_AUTHOR);
	for (const [index, subject] of PRUNED_SUBJECTS.entries()) {
		const file = `apps/web/step-${index + 1}.ts`;
		await mkdir(path.join(template, 'apps/web'), {recursive: true});
		await writeFile(
			path.join(template, file),
			`export const step = ${index};\n`,
		);
		await run(template, ['add', '--', file], TEMPLATE_AUTHOR);
		await run(template, ['commit', '-q', '-m', subject], TEMPLATE_AUTHOR);
	}

	if (kind === 'tagged') await run(template, ['tag', '4.1.0'], TEMPLATE_AUTHOR);
	await run(template, ['switch', '-q', 'main'], TEMPLATE_AUTHOR);
	await run(fork, ['fetch', '-q', 'upstream'], FORK_AUTHOR);
	await run(
		fork,
		[
			'merge',
			'--no-ff',
			'-q',
			'-m',
			'chore(makerkit): merge v3-step',
			'upstream/v3-step',
		],
		FORK_AUTHOR,
	);
	await run(template, ['branch', '-q', '-D', 'v3-step'], TEMPLATE_AUTHOR);
	await run(fork, ['fetch', '-q', '--prune', 'upstream'], FORK_AUTHOR);
	for (let n = 1; n <= 50; n++) {
		await run(
			fork,
			['commit', '-q', '--allow-empty', '-m', `🔧 Tune the CRM (${n})`],
			FORK_AUTHOR,
		);
	}

	await writeFile(
		path.join(fork, 'apps/web/invoices.ts'),
		'export const invoices = [];\n',
	);
	await run(fork, ['add', '--', 'apps/web/invoices.ts'], FORK_AUTHOR);
	await run(fork, ['commit', '-q', '-m', '✨ Add invoices'], FORK_AUTHOR);
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const manifest = (name: string, extra: Record<string, unknown> = {}): string =>
	json({name, version: '0.0.0', ...extra});

/**
 * A pnpm monorepo shaped like a Makerkit-style SaaS: two real apps (web,
 * mobile), two test/tool apps, internal packages and a tooling folder.
 */
export async function gearzLayout(
	options: GearzOptions = {},
): Promise<FixtureRepo> {
	const steps: RepoStep[] = [
		{
			commit: '🎉 Start the gearz monorepo',
			files: {
				'package.json': manifest('gearz', {private: true}),
				'pnpm-workspace.yaml':
					"packages:\n  - 'apps/*'\n  - 'packages/*'\n  - 'tooling/*'\n",
				'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
				'.github/workflows/ci.yml': 'name: ci\non: push\n',
				'apps/web/package.json': manifest('web', {
					private: true,
					version: '0.1.0',
					dependencies: {'@gearz/supabase': 'workspace:*'},
					devDependencies: {'@gearz/eslint-config': 'workspace:*'},
				}),
				'apps/mobile/package.json': manifest('mobile', {version: '1.0.0'}),
				'apps/mobile/app.config.ts':
					"export default {\n\tname: 'Gearz',\n\tversion: '1.0.0',\n};\n",
				'apps/mobile/eas.json': json({cli: {appVersionSource: 'remote'}}),
				'apps/e2e/package.json': manifest('e2e', {private: true}),
				'apps/dev-tool/package.json': manifest('dev-tool', {private: true}),
				'packages/supabase/package.json': manifest('@gearz/supabase', {
					private: true,
				}),
				'packages/ui/package.json': manifest('@gearz/ui', {private: true}),
				'tooling/eslint/package.json': manifest('@gearz/eslint-config', {
					private: true,
				}),
			},
		},
		...(options.template ? [{tag: 'wip/crm-pipeline-stages'}] : []),
		...(options.extraSteps ?? []),
	];
	return options.template
		? forkOfTemplate(steps, templateSteps(), options.sync, options.prunedBranch)
		: createRepo(steps);
}

/** Three published packages; `cli` depends on `core`. */
export async function libraryLayout(
	options: {
		extraSteps?: RepoStep[];
		/** Fork the libraries from a template made of these steps, as gearzLayout's template does. */
		templateSteps?: RepoStep[];
	} = {},
): Promise<FixtureRepo> {
	const steps: RepoStep[] = [
		{
			commit: '🎉 Start the libraries',
			files: {
				'package.json': manifest('libs', {private: true}),
				'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
				'packages/core/package.json': manifest('@libs/core', {
					version: '1.2.0',
				}),
				'packages/types/package.json': manifest('@libs/types', {
					version: '1.2.0',
				}),
				'packages/cli/package.json': manifest('@libs/cli', {
					version: '1.2.0',
					dependencies: {'@libs/core': 'workspace:*'},
				}),
			},
		},
		...(options.extraSteps ?? []),
	];
	return options.templateSteps
		? forkOfTemplate(steps, options.templateSteps)
		: createRepo(steps);
}

/** One root package.json and no workspace. */
export async function singlePackage(): Promise<FixtureRepo> {
	return createRepo([
		{
			commit: '🎉 Start the package',
			files: {'package.json': manifest('solo', {version: '2.0.0'})},
		},
	]);
}

const TEAM = [
	{name: 'Alice', email: 'alice@team.example'},
	{name: 'Bob', email: 'bob@team.example'},
];
const CONTRIBUTOR = {name: 'Dave', email: 'dave@contrib.example'};

/** The contributor's own subjects in `forkWorkflow`; each must reach web's notes. */
export const CONTRIBUTOR_SUBJECTS = [
	'✨ Add the dashboard',
	'✨ Add the search',
];

/**
 * A GitHub fork-workflow clone: `upstream` is the team's canonical repo, not
 * a template. Alice and Bob take turns writing 6 commits to web, tagging
 * v1.0.0 after the 3rd and v1.1.0 after the 6th. With `teamAfterLastTag`
 * they write 2 more after v1.1.0 (so the canonical-repo guard sees them);
 * without it, the contributor's commits are the only ones after the last
 * tag. Dave, the contributor, clones it, renames origin to upstream, and
 * writes CONTRIBUTOR_SUBJECTS to web.
 */
export async function forkWorkflow(options: {
	teamAfterLastTag: boolean;
}): Promise<FixtureRepo> {
	const base = await mkdtemp(path.join(tmpdir(), 'chamoji-canonical-'));
	const team: RepoStep[] = [
		{
			commit: '🎉 Start the shop',
			files: {
				'package.json': json({
					name: 'shop',
					private: true,
					workspaces: ['apps/*'],
				}),
				'apps/web/package.json': manifest('web', {
					private: true,
					version: '1.1.0',
				}),
				'apps/mobile/package.json': manifest('mobile', {
					private: true,
					version: '1.1.0',
				}),
			},
		},
	];
	const canonical = await createRepo(team, {
		dir: path.join(base, 'team', 'shop'),
		author: TEAM[0],
	});
	let n = 0;
	const teamCommit = async () => {
		const who = TEAM[n % TEAM.length]!;
		n++;
		const file = `apps/web/feature-${n}.ts`;
		await writeFile(
			path.join(canonical.dir, file),
			`export const feature = ${n};\n`,
		);
		const when = new Date(Date.parse('2026-01-01T01:00:00Z') + n * 60_000);
		const env = {
			...process.env,
			GIT_AUTHOR_DATE: when.toISOString(),
			GIT_COMMITTER_DATE: when.toISOString(),
		};
		const git = async (args: string[]) =>
			execFileAsync(
				'git',
				[
					'-c',
					`user.name=${who.name}`,
					'-c',
					`user.email=${who.email}`,
					...args,
				],
				{cwd: canonical.dir, env},
			);
		await git(['add', '--', file]);
		await git(['commit', '-q', '-m', `✨ Team feature ${n}`]);
		return git;
	};

	for (const tag of ['v1.0.0', 'v1.1.0']) {
		let git: Awaited<ReturnType<typeof teamCommit>> | undefined;
		for (let step = 0; step < 3; step++) git = await teamCommit();
		await git!(['tag', tag]);
	}

	if (options.teamAfterLastTag) {
		for (let step = 0; step < 2; step++) await teamCommit();
	}

	const fork = await createRepo(
		CONTRIBUTOR_SUBJECTS.map((subject, index) => ({
			commit: subject,
			files: {[`apps/web/contrib-${index + 1}.ts`]: `export const x = 1;\n`},
		})),
		{clone: canonical.dir, author: CONTRIBUTOR},
	);
	await execFileAsync('git', ['remote', 'rename', 'origin', 'upstream'], {
		cwd: fork.dir,
	});
	return {
		dir: fork.dir,
		async cleanup() {
			await fork.cleanup();
			await canonical.cleanup();
			await rm(base, {recursive: true, force: true});
		},
	};
}
