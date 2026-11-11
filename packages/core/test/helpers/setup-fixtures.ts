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

const lockLine = (name: string, version: string): string =>
	`      ${name}:\n        specifier: ^${version}\n        version: ${version}\n`;

type ZooCase = {
	/** Dependencies with the version the lockfile says is installed. */
	dependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	files?: Record<string, string>;
};

const ZOO: Record<string, ZooCase> = {
	'vite-react': {
		dependencies: {
			'@vitejs/plugin-react': '6.1.2',
			vite: '6.1.0',
			'react-dom': '19.0.0',
		},
		files: {'index.html': '<div id="root"></div>\n'},
	},
	next: {dependencies: {next: '15.2.3', react: '19.0.0'}},
	astro: {dependencies: {astro: '5.3.0', vite: '6.1.0'}},
	gatsby: {dependencies: {gatsby: '5.14.1', react: '18.3.1'}},
	remix: {dependencies: {'@remix-run/react': '2.15.2', react: '18.3.1'}},
	nestjs: {dependencies: {'@nestjs/core': '11.0.5'}},
	hydrogen: {
		dependencies: {
			'@shopify/hydrogen': '2025.1.3',
			'@remix-run/react': '2.15.2',
			'@react-router/node': '7.1.0',
			vite: '6.1.0',
		},
	},
	qwik: {dependencies: {'@builder.io/qwik-city': '1.12.1', vite: '6.1.0'}},
	expo: {dependencies: {expo: '52.0.11', 'react-native': '0.76.3'}},
	'ionic-angular': {
		dependencies: {
			'@ionic/angular': '8.4.1',
			'@angular/core': '19.1.0',
		},
		files: {'angular.json': '{}\n'},
	},
	'ionic-react': {
		dependencies: {
			'@ionic/react': '8.4.1',
			'react-dom': '19.0.0',
		},
		files: {'index.html': '<div id="root"></div>\n'},
	},
	'forge-crlf': {
		files: {
			'manifest.yml':
				'modules:\r\n  function: []\r\napp:\r\n  runtime:\r\n    name: nodejs22.x\r\n  id: ari:cloud:ecosystem::app/1\r\n',
		},
	},
	'forge-huge': {
		files: {'manifest.yml': `app:\n${' \n'.repeat(200_000)}`},
	},
	'peer-only': {peerDependencies: {next: '^15.0.0'}},
	nothing: {dependencies: {lodash: '4.17.21'}},
	'sfdx-project': {
		files: {'sfdx-project.json': '{"packageDirectories": []}\n'},
	},
	'shopify-app': {files: {'shopify.app.toml': 'name = "example"\n'}},
	forge: {
		files: {
			'manifest.yml':
				'modules:\n  function: []\napp:\n  id: ari:cloud:ecosystem::app/1\n',
		},
	},
	'forge-plain': {
		files: {'manifest.yml': 'name: not a forge app\nid: something\n'},
	},
};

/**
 * One package per case under `apps/`, named for the case, each with the
 * dependencies and files of that framework. A `pnpm-lock.yaml` at the root
 * gives the installed version of every dependency, as a real install would.
 */
export async function frameworkZoo(): Promise<FixtureRepo> {
	const files: Record<string, string> = {
		'package.json': manifest('zoo', {private: true}),
		'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n",
	};
	let importers = '';
	for (const [id, entry] of Object.entries(ZOO)) {
		const declared = (versions: Record<string, string> | undefined) =>
			versions
				? Object.fromEntries(
						Object.entries(versions).map(([name, v]) => [
							name,
							v.startsWith('^') ? v : `^${v}`,
						]),
					)
				: undefined;
		files[`apps/${id}/package.json`] = manifest(`@zoo/${id}`, {
			private: true,
			...(entry.dependencies && {dependencies: declared(entry.dependencies)}),
			...(entry.peerDependencies && {
				peerDependencies: entry.peerDependencies,
			}),
		});
		for (const [file, text] of Object.entries(entry.files ?? {})) {
			files[`apps/${id}/${file}`] = text;
		}

		if (entry.dependencies) {
			importers += `  apps/${id}:\n    dependencies:\n`;
			for (const [name, version] of Object.entries(entry.dependencies)) {
				importers += lockLine(name, version);
			}
		}
	}

	files['pnpm-lock.yaml'] =
		`lockfileVersion: '9.0'\n\nimporters:\n  .: {}\n${importers}`;
	return createRepo([{commit: '🎉 Start the zoo', files}]);
}

/** An SDF `manifest.xml` of the shape `suitecloud project:create` writes. */
export function sdfManifest(
	options: {type?: 'SUITEAPP' | 'ACCOUNTCUSTOMIZATION'; version?: string} = {},
): string {
	const type = options.type ?? 'SUITEAPP';
	const suiteApp =
		`\t<publisherid>com.example</publisherid>\n\t<projectid>myapp</projectid>\n` +
		`\t<projectname>My App</projectname>\n` +
		(options.version
			? `\t<projectversion>${options.version}</projectversion>\n`
			: '');
	return (
		`<manifest projecttype="${type}">\n` +
		(type === 'SUITEAPP' ? suiteApp : '\t<projectname>My App</projectname>\n') +
		`\t<frameworkversion>1.0</frameworkversion>\n</manifest>\n`
	);
}

export const SDF_DEPLOY = '<deploy>\n\t<objects>\n\t</objects>\n</deploy>\n';

/**
 * A npm workspace shaped like a NetSuite SuiteApp template: `apps/backend`
 * is a package whose SuiteCloud project lives in `src/` (SuiteApp
 * `com.example.myapp` at 2.10.34), next to `apps/web`, a Next.js app.
 */
export async function suiteAppMonorepo(
	options: {extraSteps?: RepoStep[]} = {},
): Promise<FixtureRepo> {
	return createRepo([
		{
			commit: '🎉 Start the SuiteApp monorepo',
			files: {
				'package.json': manifest('suiteapp-monorepo', {
					private: true,
					workspaces: ['apps/*'],
				}),
				'apps/backend/package.json': manifest('@example/backend', {
					version: '2.5.20',
					main: 'suitecloud.config.js',
				}),
				'apps/backend/suitecloud.config.js':
					'module.exports = {\n\tdefaultProjectFolder: "src",\n\tcommands: {},\n};\n',
				'apps/backend/src/manifest.xml': sdfManifest({version: '2.10.34'}),
				'apps/backend/src/deploy.xml': SDF_DEPLOY,
				'apps/web/package.json': manifest('@example/web', {
					private: true,
					version: '0.1.0',
					dependencies: {next: '^15.2.0', react: '^19.0.0'},
				}),
				'apps/web/next.config.mjs': 'export default {};\n',
			},
		},
		...(options.extraSteps ?? []),
	]);
}

/**
 * A pnpm workspace shaped like a templated SuiteApp: `apps/suiteapp` has no
 * package.json and no suitecloud.config.js; its `template/` is tracked at
 * 0.1.0 and its generated `src/` is git-ignored (on disk at 9.9.9).
 */
export async function templatedSuiteApp(): Promise<FixtureRepo> {
	const repo = await createRepo([
		{
			commit: '🎉 Start the templated SuiteApp',
			files: {
				'package.json': manifest('templated', {private: true}),
				'pnpm-workspace.yaml': "packages:\n  - 'apps/suiteapp'\n",
				'.gitignore': 'apps/suiteapp/src/\n',
				'apps/suiteapp/template/manifest.xml': sdfManifest({version: '0.1.0'}),
				'apps/suiteapp/template/deploy.xml': SDF_DEPLOY,
			},
		},
	]);
	const src = path.join(repo.dir, 'apps', 'suiteapp', 'src');
	await mkdir(src, {recursive: true});
	await writeFile(
		path.join(src, 'manifest.xml'),
		sdfManifest({version: '9.9.9'}),
	);
	await writeFile(path.join(src, 'deploy.xml'), SDF_DEPLOY);
	return repo;
}

/** A single repo whose root is an Account Customization Project in `src/`. */
export async function acpSingle(): Promise<FixtureRepo> {
	return createRepo([
		{
			commit: '🎉 Start the account customization',
			files: {
				'suitecloud.config.js':
					'module.exports = {\n\tdefaultProjectFolder: "src",\n};\n',
				'src/manifest.xml': sdfManifest({type: 'ACCOUNTCUSTOMIZATION'}),
				'src/deploy.xml': SDF_DEPLOY,
			},
		},
	]);
}

/** The libraries of `libraryLayout`, publishable, with root `check` and `test` scripts under pnpm. */
export async function publishableLibraries(
	options: {registry?: string; extraSteps?: RepoStep[]} = {},
): Promise<FixtureRepo> {
	return createRepo([
		{
			commit: '🎉 Start the libraries',
			files: {
				'package.json': manifest('acme', {
					private: true,
					scripts: {check: 'tsc', test: 'vitest'},
				}),
				'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
				'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
				'packages/ui/package.json': manifest('@acme/ui', {
					version: '1.2.0',
					exports: {'.': './dist/index.js'},
					...(options.registry
						? {publishConfig: {registry: options.registry}}
						: {}),
				}),
				'packages/core/package.json': manifest('@acme/core', {
					version: '1.2.0',
					exports: {'.': './dist/index.js'},
				}),
			},
		},
		...(options.extraSteps ?? []),
	]);
}

/** A public Next.js app next to a private one, no libraries. */
export async function publicApps(): Promise<FixtureRepo> {
	return createRepo([
		{
			commit: '🎉 Start the apps',
			files: {
				'package.json': manifest('acme', {private: true}),
				'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n",
				'apps/web/package.json': manifest('web', {
					version: '1.0.0',
					dependencies: {next: '^15.2.0', react: '^19.0.0'},
				}),
				'apps/web/next.config.mjs': 'export default {};\n',
				'apps/admin/package.json': manifest('admin', {
					private: true,
					version: '1.0.0',
					dependencies: {next: '^15.2.0', react: '^19.0.0'},
				}),
				'apps/admin/next.config.mjs': 'export default {};\n',
			},
		},
	]);
}

/** One library plus one public app, as a mixed repo. */
export async function libraryAndApp(): Promise<FixtureRepo> {
	return createRepo([
		{
			commit: '🎉 Start the repo',
			files: {
				'package.json': manifest('acme', {private: true}),
				'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n  - 'packages/*'\n",
				'packages/ui/package.json': manifest('@acme/ui', {
					version: '1.2.0',
					exports: {'.': './dist/index.js'},
				}),
				'packages/core/package.json': manifest('@acme/core', {
					version: '1.2.0',
					exports: {'.': './dist/index.js'},
				}),
				'apps/web/package.json': manifest('web', {
					version: '1.0.0',
					dependencies: {next: '^15.2.0', react: '^19.0.0'},
				}),
				'apps/web/next.config.mjs': 'export default {};\n',
			},
		},
	]);
}

/**
 * A repo that is itself a Next.js app, with a public Expo app and a Vite
 * site under `packages/`, an Expo module and a React component library whose
 * `react` is a peer. Nothing in it is `private`, the root app included.
 */
export async function appsAndLibraries(): Promise<FixtureRepo> {
	return createRepo([
		{
			commit: '🎉 Start the apps and libraries',
			files: {
				'package.json': manifest('shop', {
					version: '1.0.0',
					workspaces: ['packages/*'],
					dependencies: {next: '^15.2.0', react: '^19.0.0'},
				}),
				'next.config.mjs': 'export default {};\n',
				'packages/mobile/package.json': manifest('@shop/mobile', {
					version: '1.0.0',
					dependencies: {expo: '^52.0.0', 'react-native': '^0.76.0'},
				}),
				'packages/mobile/app.json': json({expo: {name: 'Shop'}}),
				'packages/site/package.json': manifest('@shop/site', {
					version: '1.0.0',
					devDependencies: {vite: '^6.1.0'},
				}),
				'packages/site/index.html': '<div id="root"></div>\n',
				'packages/camera/package.json': manifest('@shop/camera', {
					version: '1.0.0',
					main: 'index.js',
					dependencies: {expo: '^52.0.0'},
				}),
				'packages/camera/expo-module.config.json': json({platforms: ['ios']}),
				'packages/camera/index.js': 'export {};\n',
				'packages/ui/package.json': manifest('@shop/ui', {
					version: '1.0.0',
					exports: {'.': './index.js'},
					peerDependencies: {react: '^19.0.0'},
				}),
				'packages/ui/index.js': 'export {};\n',
			},
		},
	]);
}

/**
 * Two published libraries tagged at 1.0.0 whose readme pins each version, as
 * `npm i @acme/ui@1.0.0` does.
 */
export async function readmePins(): Promise<FixtureRepo> {
	return createRepo([
		{
			commit: '🎉 Start the libraries',
			files: {
				'package.json': manifest('acme', {private: true}),
				'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
				'README.md':
					'# Acme\n\nInstall with `npm i @acme/ui@1.0.0` or `npm i @acme/core@1.0.0`.\n',
				'packages/ui/package.json': manifest('@acme/ui', {
					version: '1.0.0',
					exports: {'.': './dist/index.js'},
				}),
				'packages/core/package.json': manifest('@acme/core', {
					version: '1.0.0',
					exports: {'.': './dist/index.js'},
				}),
			},
		},
		{tag: '@acme/ui@1.0.0', annotated: true},
		{tag: '@acme/core@1.0.0', annotated: true},
	]);
}

/** A single package whose root is a public Next.js app. */
export async function nextRootApp(): Promise<FixtureRepo> {
	return createRepo([
		{
			commit: '🎉 Start the app',
			files: {
				'package.json': manifest('storefront', {
					version: '1.0.0',
					dependencies: {next: '^15.2.0', react: '^19.0.0'},
				}),
				'next.config.mjs': 'export default {};\n',
			},
		},
	]);
}
