import {execFile} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
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

/** The template at <tmp>/makerkit/next-supabase-saas-kit-turbo (ruling R1), and a fork of it replaying `steps`. */
async function forkOfTemplate(steps: RepoStep[]): Promise<FixtureRepo> {
	const base = await mkdtemp(path.join(tmpdir(), 'chamoji-template-'));
	const template = await createRepo(templateSteps(), {
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
	return {
		dir: fork.dir,
		async cleanup() {
			await fork.cleanup();
			await template.cleanup();
			await rm(base, {recursive: true, force: true});
		},
	};
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
	return options.template ? forkOfTemplate(steps) : createRepo(steps);
}

/** Three published packages; `cli` depends on `core`. */
export async function libraryLayout(
	options: {extraSteps?: RepoStep[]} = {},
): Promise<FixtureRepo> {
	return createRepo([
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
	]);
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
