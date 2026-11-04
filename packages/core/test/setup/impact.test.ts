import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, expect, test} from 'vitest';
import {
	parseReleaseSettings,
	stagedImpact,
	type ChamojiConfig,
} from '../../src/index.js';

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map(async dir => rm(dir, {recursive: true, force: true})),
	);
});

const json = (value: unknown) => `${JSON.stringify(value)}\n`;

async function monorepo(): Promise<{root: string; config: ChamojiConfig}> {
	const root = await mkdtemp(path.join(tmpdir(), 'chamoji-impact-'));
	dirs.push(root);
	const files: Record<string, string> = {
		'package.json': json({name: 'gearz', private: true}),
		'pnpm-workspace.yaml': 'packages:\n  - apps/*\n  - packages/*\n',
		'apps/web/package.json': json({
			name: '@gearz/web',
			version: '0.1.0',
			dependencies: {'@gearz/supabase': 'workspace:*'},
		}),
		'apps/mobile/package.json': json({
			name: '@gearz/mobile',
			version: '1.0.0',
			dependencies: {'@gearz/supabase': 'workspace:*'},
		}),
		'apps/dev-tool/package.json': json({name: '@gearz/dev-tool'}),
		'packages/supabase/package.json': json({
			name: '@gearz/supabase',
			version: '0.0.0',
		}),
	};
	for (const [file, text] of Object.entries(files)) {
		await mkdir(path.dirname(path.join(root, file)), {recursive: true});
		await writeFile(path.join(root, file), text);
	}

	const release = parseReleaseSettings(
		{
			schema: 1,
			shape: 'apps',
			units: {
				web: {path: 'apps/web', tag: 'web/v{version}'},
				mobile: {path: 'apps/mobile', tag: 'mobile/v{version}'},
			},
			exclude: ['apps/dev-tool'],
		},
		'chamoji.config.json',
	);
	return {root, config: {groups: [], release} as unknown as ChamojiConfig};
}

test('stagedImpact: own units, ride-along units, excluded and root files ignored', async () => {
	const {root, config} = await monorepo();
	expect(await stagedImpact(root, config, ['apps/web/src/a.ts'])).toEqual({
		own: ['web'],
		rides: [],
	});
	expect(
		await stagedImpact(root, config, [
			'apps/web/src/a.ts',
			'packages/supabase/src/s.ts',
		]),
	).toEqual({own: ['web'], rides: ['mobile']});
	expect(
		await stagedImpact(root, config, ['packages/supabase/src/s.ts']),
	).toEqual({own: [], rides: ['web', 'mobile']});
	expect(
		await stagedImpact(root, config, [
			'apps/dev-tool/x.ts',
			'README.md',
			'package.json',
		]),
	).toEqual({own: [], rides: []});
	expect(
		await stagedImpact(root, {groups: []} as unknown as ChamojiConfig, [
			'apps/web/a.ts',
		]),
	).toEqual({own: [], rides: []});
});
