import {mkdir, mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, expect, test} from 'vitest';
import {ReleaseError} from '../../src/release.js';
import {createRepo} from '../helpers/fixture-repo.js';
import {
	suiteAppMonorepo,
	templatedSuiteApp,
} from '../helpers/setup-fixtures.js';
import type {ResolvedUnit} from '../../src/units/workspace.js';
import {
	detectVersionFiles,
	editVersionFiles,
	readEasRemote,
	readUnitVersion,
	setJsonString,
} from '../../src/units/version-files.js';

let dir: string | undefined;

afterEach(async () => {
	if (dir) await rm(dir, {recursive: true, force: true});
	dir = undefined;
});

async function repo(files: Record<string, string>): Promise<string> {
	dir = await mkdtemp(path.join(tmpdir(), 'chamoji-vf-'));
	for (const [file, content] of Object.entries(files)) {
		await mkdir(path.dirname(path.join(dir, file)), {recursive: true});
		await writeFile(path.join(dir, file), content);
	}

	return dir;
}

const unit = (
	unitPath: string,
	extra: Partial<ResolvedUnit> = {},
): ResolvedUnit => ({
	name: path.posix.basename(unitPath),
	path: unitPath,
	tag: '{unit}/v{version}',
	read: [],
	versioning: 'semver',
	versionFiles: [],
	buildNumber: 'untouched',
	changelog: `${unitPath}/CHANGELOG.md`,
	pkg: null,
	uses: [],
	...extra,
});

const manifest = (version = '0.1.0'): string =>
	`{\n  "name": "mobile",\n  "version": "${version}",\n  "dependencies": {"x": "1.0.0"}\n}\n`;

const APP_CONFIG = `import type {ExpoConfig} from 'expo/config';

export default {
  name: 'Mobile',
  version: '0.1.0',
  runtimeVersion: {policy: 'appVersion'},
  plugins: [['x', {version: '9.9.9'}]],
  ios: {bundleIdentifier: 'a.b', buildNumber: '7'},
  android: {versionCode: 7},
} satisfies ExpoConfig;
`;

const options = {
	current: '0.1.0',
	buildNumber: 'untouched' as const,
	easRemote: false,
};

test('Expo app.config.ts and package.json move together', async () => {
	const root = await repo({
		'apps/mobile/package.json': manifest(),
		'apps/mobile/app.config.ts': APP_CONFIG,
	});
	const edits = await editVersionFiles(
		root,
		unit('apps/mobile', {versionFiles: ['apps/mobile/app.config.ts']}),
		'0.2.0',
		options,
	);
	expect(edits.map(edit => edit.file)).toEqual([
		'apps/mobile/package.json',
		'apps/mobile/app.config.ts',
	]);
	expect(edits.map(edit => edit.from)).toEqual(['0.1.0', '0.1.0']);
	expect(edits[0]?.text).toBe(manifest('0.2.0'));
	expect(edits[1]?.text).toBe(
		APP_CONFIG.replace("version: '0.1.0'", "version: '0.2.0'"),
	);
});

test('app.json sets expo.version and nothing else', async () => {
	const text = `{\n  "expo": {\n    "name": "m",\n    "version": "0.1.0",\n    "sdkVersion": "1",\n    "plugins": [["x", {"version": "9.9.9"}]]\n  }\n}\n`;
	const root = await repo({'apps/mobile/app.json': text});
	const edits = await editVersionFiles(
		root,
		unit('apps/mobile', {versionFiles: ['apps/mobile/app.json']}),
		'0.3.0',
		options,
	);
	expect(edits).toEqual([
		{
			file: 'apps/mobile/app.json',
			text: text.replace('"version": "0.1.0"', '"version": "0.3.0"'),
			from: '0.1.0',
		},
	]);
});

test('known kinds set the version whatever the old value was', async () => {
	const root = await repo({'apps/mobile/app.config.js': APP_CONFIG});
	const [edit] = await editVersionFiles(
		root,
		unit('apps/mobile', {versionFiles: ['apps/mobile/app.config.js']}),
		'2.0.0',
		{...options, current: '1.5.0'},
	);
	expect(edit?.from).toBe('0.1.0');
	expect(edit?.text).toContain("version: '2.0.0'");
});

test('remote EAS build numbers are untouched', async () => {
	const root = await repo({
		'apps/mobile/eas.json': JSON.stringify({
			cli: {appVersionSource: 'remote'},
		}),
		'apps/mobile/app.config.ts': APP_CONFIG,
	});
	const easRemote = await readEasRemote(root, 'apps/mobile');
	expect(easRemote).toBe(true);
	const [edit] = await editVersionFiles(
		root,
		unit('apps/mobile', {
			versionFiles: ['apps/mobile/app.config.ts'],
			buildNumber: 'increment',
		}),
		'0.2.0',
		{...options, buildNumber: 'increment', easRemote},
	);
	expect(edit?.text).toContain("buildNumber: '7'");
	expect(edit?.text).toContain('versionCode: 7}');
});

test('local build numbers increment', async () => {
	const json = `{"expo":{"version":"0.1.0","ios":{"buildNumber":"7"},"android":{"versionCode":7}}}`;
	const root = await repo({
		'apps/mobile/app.config.ts': APP_CONFIG,
		'apps/mobile/app.json': json,
	});
	expect(await readEasRemote(root, 'apps/mobile')).toBe(false);
	const edits = await editVersionFiles(
		root,
		unit('apps/mobile', {
			versionFiles: ['apps/mobile/app.config.ts', 'apps/mobile/app.json'],
		}),
		'0.2.0',
		{...options, buildNumber: 'increment'},
	);
	const config = edits.find(edit => edit.file.endsWith('.ts'));
	expect(config?.text).toContain("buildNumber: '8'");
	expect(config?.text).toContain('versionCode: 8}');
	expect(edits.find(edit => edit.file.endsWith('.json'))?.text).toBe(
		`{"expo":{"version":"0.2.0","ios":{"buildNumber":"8"},"android":{"versionCode":8}}}`,
	);
});

test('a missing build number field is left alone', async () => {
	const root = await repo({
		'apps/mobile/app.json': '{"expo":{"version":"0.1.0"}}',
	});
	const [edit] = await editVersionFiles(
		root,
		unit('apps/mobile', {versionFiles: ['apps/mobile/app.json']}),
		'0.2.0',
		{...options, buildNumber: 'increment'},
	);
	expect(edit?.text).toBe('{"expo":{"version":"0.2.0"}}');
});

const PLIST = (version: string, build = '1') =>
	`<dict>\n\t<key>CFBundleShortVersionString</key>\n\t<string>${version}</string>\n\t<key>CFBundleVersion</key>\n\t<string>${build}</string>\n</dict>\n`;

const GRADLE = (name: string, code = 1) =>
	`android {\n  defaultConfig {\n    versionCode ${code}\n    versionName "${name}"\n  }\n}\n`;

test('React Native native files', async () => {
	const root = await repo({
		'apps/rn/ios/App/Info.plist': PLIST('1.0'),
		'apps/rn/android/app/build.gradle': GRADLE('1.0'),
	});
	const edits = await editVersionFiles(
		root,
		unit('apps/rn', {
			versionFiles: [
				'apps/rn/ios/App/Info.plist',
				'apps/rn/android/app/build.gradle',
			],
		}),
		'1.1.0',
		{...options, current: '1.0.0'},
	);
	expect(edits.map(edit => [edit.text, edit.from])).toEqual([
		[PLIST('1.1.0'), '1.0'],
		[GRADLE('1.1.0'), '1.0'],
	]);

	const bumped = await editVersionFiles(
		root,
		unit('apps/rn', {
			versionFiles: [
				'apps/rn/ios/App/Info.plist',
				'apps/rn/android/app/build.gradle',
			],
		}),
		'1.1.0',
		{...options, current: '1.0.0', buildNumber: 'increment'},
	);
	expect(bumped.map(edit => edit.text)).toEqual([
		PLIST('1.1.0', '2'),
		GRADLE('1.1.0', 2),
	]);
});

test('an Info.plist that points at MARKETING_VERSION stops the release', async () => {
	const root = await repo({
		'apps/rn/ios/App/Info.plist': PLIST('$(MARKETING_VERSION)'),
	});
	const attempt = editVersionFiles(
		root,
		unit('apps/rn', {versionFiles: ['apps/rn/ios/App/Info.plist']}),
		'1.1.0',
		options,
	);
	await expect(attempt).rejects.toBeInstanceOf(ReleaseError);
	await expect(attempt).rejects.toThrow(
		/can't set the version in apps\/rn\/ios\/App\/Info\.plist: its version is the build variable \$\(MARKETING_VERSION\), which chamoji can't edit yet; remove this file from versionFiles and bump MARKETING_VERSION in Xcode yourself/,
	);
});

test('other listed files use the first occurrence of the current version', async () => {
	const root = await repo({
		'apps/web/package.json': manifest('1.2.3'),
		'apps/web/src/version.ts': "export const VERSION = '1.2.3';\n// 1.2.3\n",
	});
	const edits = await editVersionFiles(
		root,
		unit('apps/web', {versionFiles: ['apps/web/src/version.ts']}),
		'1.3.0',
		{...options, current: '1.2.3'},
	);
	expect(edits[1]).toEqual({
		file: 'apps/web/src/version.ts',
		text: "export const VERSION = '1.3.0';\n// 1.2.3\n",
		from: '1.2.3',
	});
});

test('a listed file with no version stops the release', async () => {
	const root = await repo({
		'apps/web/package.json': manifest(),
		'apps/web/src/version.ts': 'export const VERSION = "unknown";\n',
	});
	const attempt = editVersionFiles(
		root,
		unit('apps/web', {versionFiles: ['apps/web/src/version.ts']}),
		'0.2.0',
		options,
	);
	await expect(attempt).rejects.toBeInstanceOf(ReleaseError);
	await expect(attempt).rejects.toThrow('apps/web/src/version.ts');
	await expect(
		editVersionFiles(
			root,
			unit('apps/web', {versionFiles: ['apps/web/src/version.ts']}),
			'0.2.0',
			{...options, current: null},
		),
	).rejects.toThrow('apps/web/src/version.ts');
});

test('a known kind with nothing to set stops the release', async () => {
	const root = await repo({
		'apps/mobile/app.config.ts': 'export default {name: "m"};\n',
	});
	await expect(
		editVersionFiles(
			root,
			unit('apps/mobile', {versionFiles: ['apps/mobile/app.config.ts']}),
			'0.2.0',
			options,
		),
	).rejects.toThrow('apps/mobile/app.config.ts');
});

test('a package.json without a version is skipped', async () => {
	const root = await repo({
		'apps/web/package.json': '{"name": "web", "private": true}',
	});
	expect(
		await editVersionFiles(root, unit('apps/web'), '1.0.0', options),
	).toEqual([]);
});

test('readEasRemote: missing is false, malformed throws naming the file', async () => {
	const root = await repo({
		'apps/a/eas.json': '{"cli": {"appVersionSource": "local"}}',
		'apps/b/eas.json': '{nope',
	});
	expect(await readEasRemote(root, 'apps/a')).toBe(false);
	expect(await readEasRemote(root, 'apps/none')).toBe(false);
	await expect(readEasRemote(root, 'apps/b')).rejects.toThrow(
		'apps/b/eas.json',
	);
});

test('detectVersionFiles finds what applies', async () => {
	const root = await repo({
		'apps/mobile/package.json': manifest(),
		'apps/mobile/app.config.ts': APP_CONFIG,
		'apps/mobile/node_modules/x/package.json': manifest(),
		'apps/mobile/app.json': '{"expo":{"name":"m"}}',
	});
	expect(await detectVersionFiles(root, 'apps/mobile')).toEqual([
		'apps/mobile/package.json',
		'apps/mobile/app.config.ts',
	]);
});

test('detectVersionFiles finds native files and skips Pods and build folders', async () => {
	const root = await repo({
		'apps/rn/package.json': manifest(),
		'apps/rn/ios/App/Info.plist': PLIST('1.0'),
		'apps/rn/ios/Pods/X/Info.plist': PLIST('3.0'),
		'apps/rn/ios/build/Info.plist': PLIST('3.0'),
		'apps/rn/ios/Other/Info.plist': PLIST('$(MARKETING_VERSION)'),
		'apps/rn/android/app/build.gradle': GRADLE('1.0'),
	});
	expect(await detectVersionFiles(root, 'apps/rn')).toEqual([
		'apps/rn/package.json',
		'apps/rn/ios/App/Info.plist',
		'apps/rn/android/app/build.gradle',
	]);
});

async function configEdit(text: string, name = 'app.config.ts') {
	const root = await repo({[`apps/m/${name}`]: text});
	const [edit] = await editVersionFiles(
		root,
		unit('apps/m', {versionFiles: [`apps/m/${name}`]}),
		'2.0.0',
		options,
	);
	return edit;
}

const shapes: Array<[string, string, string]> = [
	[
		'destructured arrow',
		"export default ({config}) => ({...config, version: '0.1.0', name: 'x'});\n",
		"export default ({config}) => ({...config, version: '2.0.0', name: 'x'});\n",
	],
	[
		'typed arrow',
		"export default ({config}: ConfigContext): ExpoConfig => ({\n  ...config,\n  version: '0.1.0',\n});\n",
		"export default ({config}: ConfigContext): ExpoConfig => ({\n  ...config,\n  version: '2.0.0',\n});\n",
	],
	[
		'block-body arrow',
		"export default ({config}) => {\n  const x = {version: '5.5.5'};\n  return {...config, version: '0.1.0', x};\n};\n",
		"export default ({config}) => {\n  const x = {version: '5.5.5'};\n  return {...config, version: '2.0.0', x};\n};\n",
	],
	[
		'module.exports with expo',
		"module.exports = {\n  expo: {name: 'x', version: '0.1.0'},\n};\n",
		"module.exports = {\n  expo: {name: 'x', version: '2.0.0'},\n};\n",
	],
	[
		'defineConfig',
		"import {defineConfig} from 'x';\nexport default defineConfig({\n  version: '0.1.0',\n});\n",
		"import {defineConfig} from 'x';\nexport default defineConfig({\n  version: '2.0.0',\n});\n",
	],
	[
		'named const with a type',
		"const A = {version: '7.7.7'};\nconst config: ExpoConfig = {\n  name: 'x',\n  version: '0.1.0',\n};\n\nexport default config;\n",
		"const A = {version: '7.7.7'};\nconst config: ExpoConfig = {\n  name: 'x',\n  version: '2.0.0',\n};\n\nexport default config;\n",
	],
	[
		'version in a comment, a string and a nested object first',
		"export default {\n  // version: '9.9.9'\n  description: \"version: '8.8.8'\",\n  extra: {version: '6.6.6'},\n  version: '0.1.0',\n};\n",
		"export default {\n  // version: '9.9.9'\n  description: \"version: '8.8.8'\",\n  extra: {version: '6.6.6'},\n  version: '2.0.0',\n};\n",
	],
	[
		'a commented-out export above the real one',
		"// export default { version: '9.9.9' }\n/* module.exports = {version: '9.9.9'} */\nexport default {version: '0.1.0'};\n",
		"// export default { version: '9.9.9' }\n/* module.exports = {version: '9.9.9'} */\nexport default {version: '2.0.0'};\n",
	],
	[
		'a regex with a quote before version',
		"const re = /it's/;\nexport default {pattern: /\"x/, version: '0.1.0'};\n",
		"const re = /it's/;\nexport default {pattern: /\"x/, version: '2.0.0'};\n",
	],
];

test.each(shapes)('app.config shape: %s', async (_name, before, after) => {
	expect(await configEdit(before)).toEqual({
		file: 'apps/m/app.config.ts',
		text: after,
		from: '0.1.0',
	});
});

test('a listed package.json with no version stops the release', async () => {
	const root = await repo({'apps/x/package.json': '{"name": "x"}'});
	await expect(
		editVersionFiles(
			root,
			unit('apps/x', {versionFiles: ['apps/x/package.json']}),
			'1.0.0',
			options,
		),
	).rejects.toThrow('apps/x/package.json');
});

test('setJsonString sets a nested string and keeps the formatting', () => {
	const text =
		'{\n  "name": "@acme/cli",\n  "scripts": {"dependencies": "echo"},\n  "dependencies": {\n    "@acme/core":   "^1.0.0",\n    "left-pad": "1.0.0"\n  }\n}\n';
	expect(setJsonString(text, ['dependencies', '@acme/core'], '^1.0.1')).toBe(
		text.replace('"^1.0.0"', '"^1.0.1"'),
	);
	expect(setJsonString(text, ['dependencies', 'nope'], '1')).toBeUndefined();
	expect(
		setJsonString(text, ['scripts', 'dependencies', 'x'], '1'),
	).toBeUndefined();
	expect(setJsonString(text, ['dependencies'], '1')).toBeUndefined();
});

async function configRefusal(text: string): Promise<unknown> {
	const root = await repo({'apps/m/app.config.ts': text});
	return editVersionFiles(
		root,
		unit('apps/m', {versionFiles: ['apps/m/app.config.ts']}),
		'2.0.0',
		options,
	).then(
		() => undefined,
		(error: unknown) => error,
	);
}

const refusals: Array<[string, string, string]> = [
	[
		'a call wrapper with more than one argument',
		"const base = {version: '0.1.0'};\nexport default merge(base, {version: '0.1.0'});\n",
		"can't set the version in apps/m/app.config.ts: its config is passed to merge(…) with other arguments, so chamoji can't tell which object is exported",
	],
	[
		'a template literal with a placeholder',
		'const x = 3;\nexport default {version: `0.1.${x}`};\n',
		"can't set the version in apps/m/app.config.ts: its version is a template literal with ${…}, which chamoji can't set",
	],
	[
		'a duplicate version key',
		"export default {\n  version: '0.1.0',\n  name: 'x',\n  version: '0.1.0',\n};\n",
		"can't set the version in apps/m/app.config.ts: its config object has more than one version key",
	],
];

test.each(refusals)('app.config refuses %s', async (_name, text, message) => {
	const error = await configRefusal(text);
	expect(error).toBeInstanceOf(ReleaseError);
	expect(error).toMatchObject({code: 'invalid-version', message});
});

test('a one-argument call wrapper and a template literal without placeholders are still set', async () => {
	expect(
		await configEdit("export default defineConfig({version: '0.1.0'},);\n"),
	).toMatchObject({
		text: "export default defineConfig({version: '2.0.0'},);\n",
	});
	expect(
		await configEdit('export default {version: `0.1.0`};\n'),
	).toMatchObject({text: 'export default {version: `2.0.0`};\n'});
});

test.skipIf(process.platform === 'win32')(
	'a listed file that is a symlink stops the release',
	async () => {
		const root = await repo({
			'outside/app.json': '{"expo": {"version": "0.1.0"}}',
		});
		await mkdir(path.join(root, 'apps/m'), {recursive: true});
		await symlink(
			path.join(root, 'outside/app.json'),
			path.join(root, 'apps/m/app.json'),
		);
		const attempt = editVersionFiles(
			root,
			unit('apps/m', {versionFiles: ['apps/m/app.json']}),
			'2.0.0',
			options,
		);
		await expect(attempt).rejects.toBeInstanceOf(ReleaseError);
		await expect(attempt).rejects.toThrow(
			'apps/m/app.json is listed in versionFiles but is a symlink; list the file it points to instead',
		);
	},
);

test('manifest.xml: only <projectversion> changes', async () => {
	const text =
		'<?xml version="1.0"?>\r\n<!-- <projectversion>9.9.9</projectversion> -->\r\n<manifest projecttype="SUITEAPP">\r\n\t<publisherid>com.example</publisherid>\r\n\t<projectid>myapp</projectid>\r\n\t<projectversion>2.10.34</projectversion>\r\n\t<frameworkversion>1.0</frameworkversion>\r\n</manifest>\r\n';
	const root = await repo({'apps/backend/src/manifest.xml': text});
	const [edit] = await editVersionFiles(
		root,
		unit('apps/backend', {versionFiles: ['apps/backend/src/manifest.xml']}),
		'2.11.0',
		options,
	);
	expect(edit).toEqual({
		file: 'apps/backend/src/manifest.xml',
		text: text.replace('<projectversion>2.10.34<', '<projectversion>2.11.0<'),
		from: '2.10.34',
	});
});

test('a manifest.xml with no <projectversion> takes the generic replace of the current version (0.15 behaviour)', async () => {
	// Not an SDF manifest at all: the version is only text in it.
	const text = '<manifest package="com.example.app" versionName="0.1.0"/>\n';
	const root = await repo({'app/manifest.xml': text});
	const [edit] = await editVersionFiles(
		root,
		unit('app', {versionFiles: ['app/manifest.xml']}),
		'0.2.0',
		options,
	);
	expect(edit).toEqual({
		file: 'app/manifest.xml',
		text: text.replace('0.1.0', '0.2.0'),
		from: '0.1.0',
	});

	// An SDF manifest with <projectversion> still uses the setter.
	const sdf =
		'<manifest projecttype="SUITEAPP">\n\t<projectversion>3.0.0</projectversion>\n\t<note>0.1.0</note>\n</manifest>\n';
	const sdfRoot = await repo({'src/manifest.xml': sdf});
	const [setter] = await editVersionFiles(
		sdfRoot,
		unit('', {versionFiles: ['src/manifest.xml']}),
		'3.1.0',
		options,
	);
	expect(setter?.text).toBe(sdf.replace('3.0.0', '3.1.0'));
	expect(setter?.from).toBe('3.0.0');
});

test('a manifest.xml with neither a <projectversion> nor the current version still fails', async () => {
	const root = await repo({
		'src/manifest.xml': '<manifest projecttype="ACCOUNTCUSTOMIZATION"/>\n',
	});
	const attempt = editVersionFiles(
		root,
		unit('', {versionFiles: ['src/manifest.xml']}),
		'1.0.0',
		options,
	);
	await expect(attempt).rejects.toBeInstanceOf(ReleaseError);
	await expect(attempt).rejects.toThrow(
		"can't set the version in src/manifest.xml: it doesn't contain the current version 0.1.0",
	);
});

test('detectVersionFiles finds the SDF manifest', async () => {
	const fixture = await suiteAppMonorepo();
	try {
		expect(await detectVersionFiles(fixture.dir, 'apps/backend')).toEqual([
			'apps/backend/package.json',
			'apps/backend/src/manifest.xml',
		]);
	} finally {
		await fixture.cleanup();
	}
});

test('detectVersionFiles skips an SDF manifest with no <projectversion>', async () => {
	const fixture = await createRepo([
		{
			commit: '🎉 Start',
			files: {
				'src/manifest.xml': '<manifest projecttype="ACCOUNTCUSTOMIZATION"/>\n',
				'src/deploy.xml': '<deploy/>\n',
			},
		},
	]);
	try {
		expect(await detectVersionFiles(fixture.dir, '')).toEqual([]);
	} finally {
		await fixture.cleanup();
	}
});

test('readUnitVersion falls back to the manifest', async () => {
	const fixture = await templatedSuiteApp();
	try {
		const bare = unit('apps/suiteapp', {
			versionFiles: ['apps/suiteapp/template/manifest.xml'],
		});
		expect(await readUnitVersion(fixture.dir, bare)).toBe('0.1.0');
		expect(
			await readUnitVersion(fixture.dir, unit('apps/suiteapp')),
		).toBeNull();
		const withPackage = unit('apps/backend', {
			pkg: {
				name: 'b',
				path: 'apps/backend',
				version: '2.5.20',
				private: false,
				runtimeDeps: [],
				ranges: {},
			},
			versionFiles: ['apps/backend/src/manifest.xml'],
		});
		expect(await readUnitVersion(fixture.dir, withPackage)).toBe('2.5.20');
	} finally {
		await fixture.cleanup();
	}
});

test('detectVersionFiles finds the SDF manifest of a root-level unit', async () => {
	const fixture = await createRepo([
		{
			commit: '🎉 Start',
			files: {
				'src/manifest.xml':
					'<manifest projecttype="SUITEAPP">\n\t<publisherid>com.example</publisherid>\n\t<projectid>myapp</projectid>\n\t<projectversion>1.0.0</projectversion>\n</manifest>\n',
				'src/deploy.xml': '<deploy/>\n',
			},
		},
	]);
	try {
		expect(await detectVersionFiles(fixture.dir, '')).toEqual([
			'src/manifest.xml',
		]);
	} finally {
		await fixture.cleanup();
	}
});
