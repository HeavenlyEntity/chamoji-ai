import {expect, test} from 'vitest';
import {
	bumpManifest,
	insertSection,
	releaseSubject,
	tagPrefix,
} from '../src/release.js';

const SECTION =
	'## [v1.3.0](https://x/compare/v1.2.0...v1.3.0) - 2026-10-28\n\n### Added\n\n- ✨ Add export';

test('insertSection puts the new release above the last one and keeps the rest byte for byte', () => {
	const old =
		'## [v1.2.0](https://x) - 2026-09-02\n\n### Fixed\n\n- 🐛 Fix a crash\n';
	const changelog = `# Changelog\n\n${old}`;
	expect(insertSection(changelog, SECTION)).toBe(
		`# Changelog\n\n${SECTION}\n\n${old}`,
	);
});

test('insertSection keeps an Unreleased section above the new release', () => {
	const changelog =
		'# Changelog\n\n## [Unreleased]\n\n- Draft note\n\n## [2.0.1] - 2026-08-30\n\n- Old\n';
	const result = insertSection(changelog, '## [2.0.2] - 2026-10-28\n\n- New');
	expect(result.indexOf('## [Unreleased]')).toBeLessThan(
		result.indexOf('## [2.0.2]'),
	);
	expect(result.indexOf('## [2.0.2]')).toBeLessThan(
		result.indexOf('## [2.0.1]'),
	);
	expect(result).toContain('- Draft note');
	expect(result.endsWith('## [2.0.1] - 2026-08-30\n\n- Old\n')).toBe(true);
});

test('insertSection appends below the title when there is no release yet', () => {
	expect(insertSection('# Changelog\n', SECTION)).toBe(
		`# Changelog\n\n${SECTION}\n`,
	);
});

test('bumpManifest changes only the top-level version of package.json', () => {
	const text =
		'{\n\t"name": "@acme/widgets",\n\t"version": "1.2.0",\n\t"dependencies": {\n\t\t"left-pad": "1.2.0"\n\t}\n}\n';
	expect(bumpManifest('package.json', text, '1.2.0', '1.3.0')).toBe(
		text.replace('"version": "1.2.0"', '"version": "1.3.0"'),
	);
});

test('bumpManifest changes only the root entries of package-lock.json', () => {
	const lock = JSON.stringify(
		{
			name: 'widgets',
			version: '1.2.0',
			lockfileVersion: 3,
			packages: {
				'': {name: 'widgets', version: '1.2.0'},
				'node_modules/left-pad': {version: '1.2.0'},
			},
		},
		null,
		2,
	);
	const bumped = JSON.parse(
		bumpManifest('package-lock.json', lock, '1.2.0', '1.3.0')!,
	);
	expect(bumped.version).toBe('1.3.0');
	expect(bumped.packages[''].version).toBe('1.3.0');
	expect(bumped.packages['node_modules/left-pad'].version).toBe('1.2.0');
});

test('bumpManifest handles pyproject.toml and Cargo.toml', () => {
	expect(
		bumpManifest(
			'pyproject.toml',
			'[project]\nname = "ledger"\nversion = "2.0.1"\n',
			'2.0.1',
			'2.0.2',
		),
	).toBe('[project]\nname = "ledger"\nversion = "2.0.2"\n');
	expect(
		bumpManifest(
			'crates/core/Cargo.toml',
			'[package]\nname = "core"\nversion = "0.3.0"\n\n[dependencies]\nserde = { version = "0.3.0" }\n',
			'0.3.0',
			'0.4.0',
		),
	).toBe(
		'[package]\nname = "core"\nversion = "0.4.0"\n\n[dependencies]\nserde = { version = "0.3.0" }\n',
	);
});

test('bumpManifest leaves files that carry another version alone', () => {
	expect(
		bumpManifest('package.json', '{"version": "9.9.9"}', '1.2.0', '1.3.0'),
	).toBeNull();
	expect(
		bumpManifest('package.json', '{"name": "x"}', '1.2.0', '1.3.0'),
	).toBeNull();
});

test('bumpManifest sets any version on a first release, unless it already matches', () => {
	expect(
		bumpManifest('package.json', '{"version": "0.0.0"}', null, '0.1.0'),
	).toBe('{"version": "0.1.0"}');
	expect(
		bumpManifest('package.json', '{"version": "0.1.0"}', null, '0.1.0'),
	).toBeNull();
});

test('releaseSubject follows the repo commit style', () => {
	const gitmoji = Array.from({length: 30}, (_, i) =>
		i % 2 ? '✨ Add a thing' : '🐛 Fix a thing',
	);
	expect(releaseSubject(gitmoji, 'v1.3.0')).toBe('🔖 Release v1.3.0');
	expect(
		releaseSubject(
			[
				'fix: keep currency symbol',
				'feat: initial ledger',
				'docs: explain --strict',
			],
			'2.0.2',
		),
	).toBe('chore(release): 🔖 2.0.2');
	expect(
		releaseSubject(['Add search', 'Fix the login form', 'Tidy up'], 'v1.0.0'),
	).toBe('Release v1.0.0');
});

test('tagPrefix follows the newest tag', () => {
	expect(tagPrefix(['v1.2.0', 'v1.1.0'])).toBe('v');
	expect(tagPrefix(['2.0.1'])).toBe('');
	expect(tagPrefix([])).toBe('v');
});
