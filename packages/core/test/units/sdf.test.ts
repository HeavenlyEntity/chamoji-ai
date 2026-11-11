import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, expect, test} from 'vitest';
import {findSdfProjects, sdfProjectAt} from '../../src/units/sdf.js';
import {createRepo, type FixtureRepo} from '../helpers/fixture-repo.js';
import {
	acpSingle,
	SDF_DEPLOY,
	sdfManifest,
	suiteAppMonorepo,
	templatedSuiteApp,
} from '../helpers/setup-fixtures.js';

const repos: FixtureRepo[] = [];
afterEach(async () => {
	await Promise.all(repos.splice(0).map(async repo => repo.cleanup()));
});

const keep = (repo: FixtureRepo): string => {
	repos.push(repo);
	return repo.dir;
};

test('a configured SuiteApp is found at its folder', async () => {
	const dir = keep(await suiteAppMonorepo());
	expect(await findSdfProjects(dir)).toEqual([
		{
			path: 'apps/backend',
			manifest: 'apps/backend/src/manifest.xml',
			type: 'suiteapp',
			applicationId: 'com.example.myapp',
			version: '2.10.34',
			framework: 'netsuite-suiteapp',
		},
	]);
});

test('a SuiteApp with no config and no package.json is found from its tracked template', async () => {
	const dir = keep(await templatedSuiteApp());
	expect(await findSdfProjects(dir)).toEqual([
		{
			path: 'apps/suiteapp',
			manifest: 'apps/suiteapp/template/manifest.xml',
			type: 'suiteapp',
			applicationId: 'com.example.myapp',
			version: '0.1.0',
			framework: 'netsuite-suiteapp',
		},
	]);
});

test('an ignored src/ is never read', async () => {
	const dir = keep(await templatedSuiteApp());
	const found = await findSdfProjects(dir);
	expect(found).toHaveLength(1);
	expect(found[0]!.manifest).toBe('apps/suiteapp/template/manifest.xml');
	expect(found[0]!.version).toBe('0.1.0');
});

test('an Account Customization Project has no version', async () => {
	const dir = keep(await acpSingle());
	expect(await findSdfProjects(dir)).toEqual([
		{
			path: '',
			manifest: 'src/manifest.xml',
			type: 'acp',
			applicationId: null,
			version: null,
			framework: 'netsuite-acp',
		},
	]);
});

test('a manifest.xml without a deploy.xml, or without projecttype, is not a project', async () => {
	const repo = await createRepo([
		{
			commit: '🎉 Start',
			files: {
				'a/src/manifest.xml': sdfManifest({version: '1.0.0'}),
				'b/src/manifest.xml':
					'<manifest>\n\t<projectid>x</projectid>\n</manifest>\n',
				'b/src/deploy.xml': SDF_DEPLOY,
				'c/src/manifest.xml': '<note projecttype="SUITEAPP"/>\n',
				'c/src/deploy.xml': SDF_DEPLOY,
			},
		},
	]);
	expect(await findSdfProjects(keep(repo))).toEqual([]);
});

test('node_modules is never searched', async () => {
	const repo = await createRepo([
		{
			commit: '🎉 Start',
			files: {
				'node_modules/dep/src/manifest.xml': sdfManifest({version: '1.0.0'}),
				'node_modules/dep/src/deploy.xml': SDF_DEPLOY,
			},
		},
	]);
	expect(await findSdfProjects(keep(repo))).toEqual([]);
});

test('with a config, only its defaultProjectFolder counts; without one, src wins', async () => {
	const repo = await createRepo([
		{
			commit: '🎉 Start',
			files: {
				'one/suitecloud.config.js':
					"module.exports = {defaultProjectFolder: './app/'};\n",
				'one/app/manifest.xml': sdfManifest({version: '1.0.0'}),
				'one/app/deploy.xml': SDF_DEPLOY,
				'one/src/manifest.xml': sdfManifest({version: '2.0.0'}),
				'one/src/deploy.xml': SDF_DEPLOY,
				'two/alpha/manifest.xml': sdfManifest({version: '3.0.0'}),
				'two/alpha/deploy.xml': SDF_DEPLOY,
				'two/src/manifest.xml': sdfManifest({version: '4.0.0'}),
				'two/src/deploy.xml': SDF_DEPLOY,
			},
		},
	]);
	const found = await findSdfProjects(keep(repo));
	expect(found.map(p => [p.path, p.manifest, p.version])).toEqual([
		['one', 'one/app/manifest.xml', '1.0.0'],
		['two', 'two/src/manifest.xml', '4.0.0'],
	]);
});

test('a folder that is not a git repository has no projects', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'chamoji-sdf-'));
	try {
		await mkdir(path.join(dir, 'src'));
		await writeFile(path.join(dir, 'src', 'manifest.xml'), sdfManifest());
		await writeFile(path.join(dir, 'src', 'deploy.xml'), SDF_DEPLOY);
		expect(await findSdfProjects(dir)).toEqual([]);
	} finally {
		await rm(dir, {recursive: true, force: true});
	}
});

test('sdfProjectAt returns the project at a unit path, or null', async () => {
	const dir = keep(await suiteAppMonorepo());
	expect((await sdfProjectAt(dir, 'apps/backend'))?.manifest).toBe(
		'apps/backend/src/manifest.xml',
	);
	expect(await sdfProjectAt(dir, 'apps/web')).toBeNull();
	const acp = keep(await acpSingle());
	expect((await sdfProjectAt(acp, ''))?.type).toBe('acp');
	expect((await sdfProjectAt(acp, '.'))?.type).toBe('acp');
});
