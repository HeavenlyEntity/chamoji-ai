import {createRepo, type FixtureRepo, type RepoStep} from './fixture-repo.js';

/**
 * Options for `gearzLayout`. Later tasks add to this object (a template
 * remote with tags, a merge from upstream), so callers always pass it by name.
 */
export type GearzOptions = {
	/** Extra steps replayed after the initial commit. */
	extraSteps?: RepoStep[];
};

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
	return createRepo([
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
		...(options.extraSteps ?? []),
	]);
}

/** Three published packages; `cli` depends on `core`. */
export async function libraryLayout(): Promise<FixtureRepo> {
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
