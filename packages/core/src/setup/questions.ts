import {CONFIG_FILE} from '../config.js';
import {parseReleaseSettings} from '../units/settings.js';
import {matchesTagPattern, versionFromTag} from '../units/tags.js';
import {ownerOf, resolveUnits} from '../units/workspace.js';
import type {Detection, SetupAnswers} from './answers.js';
import {MAX_COMMITS, type LayoutDetection, type UnitFacts} from './detect.js';
import {releaseSection} from './section.js';
import type {UnitTagFormats} from './tags.js';

type Unit = SetupAnswers['units'][number];

export type Question = {
	id: string;
	title: string;
	/** What chamoji found, in one sentence from the repo's own examples. */
	found: string;
	kind: 'choice' | 'ticks' | 'text';
	options: Array<{value: string; label: string; recommended?: boolean}>;
	/** False when detection settles it; such a question shows only under "Change something". */
	needsAnswer: boolean;
};

type Obj = Record<string, unknown>;

export const SHARED_TAG = 'v{version}';

export const isObject = (value: unknown): value is Obj =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
export const unique = <T>(values: T[]): T[] => [...new Set(values)];
/** 'apps/e2e' -> 'e2e', 'tooling/*' -> 'tooling'. */
export const lastSegment = (folder: string): string =>
	folder
		.replace(/\/\*+$/, '')
		.split('/')
		.filter(Boolean)
		.pop() ?? folder;
const count = (n: number, one: string, many: string): string =>
	`${n} ${n === 1 ? one : many}`;

/** 'a', 'a and b', 'a, b and c'; `or` for 'a or b'. */
function list(items: string[], word = 'and'): string {
	if (items.length <= 1) return items.join('');
	return `${items.slice(0, -1).join(', ')} ${word} ${items.at(-1)}`;
}

export const defaultTag = (shape: SetupAnswers['shape']): string =>
	shape === 'libraries' ? '{name}@{version}' : '{unit}/v{version}';

export const recommendedShape = (
	layout: LayoutDetection,
): SetupAnswers['shape'] => (layout.kind === 'mixed' ? 'apps' : layout.kind);

/** The base a repo started from, as copy says it. */
export const baseName = (detection: Detection, answers?: SetupAnswers) =>
	answers?.upstream?.name ?? detection.upstream.name ?? 'the template';

/**
 * The name setup suggests for `upstream.name`: the same fallback without its
 * article, since the engine writes "Updated the <name> base".
 */
export const suggestedBase = (detection: Detection): string =>
	baseName(detection).replace(/^the /, '');

/** A unit's facts and tag formats, by path, so a renamed unit still finds them. */
export function factsOf(
	detection: Detection,
	unit: {path: string},
): {facts?: UnitFacts; formats?: UnitTagFormats} {
	const {candidates, units} = detection.layout;
	const facts = candidates.find(each => each.path === unit.path);
	// Tag formats were worked out for detected units only.
	const detected = units.some(each => each.path === unit.path);
	return {
		facts,
		formats: facts && detected ? detection.tags.perUnit[facts.name] : undefined,
	};
}

/** What the unit is at now: its last tag, else its manifest. */
export function current(detection: Detection, unit: Unit): string | null {
	const {facts, formats} = factsOf(detection, unit);
	return formats?.last?.version ?? facts?.version ?? null;
}

const choice = (
	options: Array<[string, string]>,
	recommended: string,
): Question['options'] =>
	options.map(([value, label]) => ({
		value,
		label,
		...(value === recommended ? {recommended: true} : {}),
	}));

/** Whether `tag` reads as a release of one of the units, under its tag or read templates. */
function isUnitTag(
	detection: Detection,
	answers: SetupAnswers,
	tag: string,
): boolean {
	return answers.units.some(unit => {
		const name =
			detection.layout.packages.find(pkg => pkg.path === unit.path)?.name ?? '';
		return [unit.tag, ...unit.read].some(
			template =>
				versionFromTag(tag, template, {unit: unit.name, name}) !== null,
		);
	});
}

/** "12 commits since your last release touched only pnpm-lock.yaml or .github/". */
function rootFilesFound(detection: Detection, answers: SetupAnswers): string {
	const {count: n, examples, since} = detection.layout.rootOnly;
	const window =
		since === null
			? `in the last ${MAX_COMMITS} commits`
			: isUnitTag(detection, answers, since)
				? 'since your last release'
				: `since ${since}`;
	if (n === 0) {
		return `No commit ${window} touched only files outside the packages`;
	}

	const shown = unique(
		examples.map(file =>
			file.includes('/') ? `${file.split('/')[0]}/` : file,
		),
	).sort((a, b) => Number(a.endsWith('/')) - Number(b.endsWith('/')));
	return `${count(n, 'commit', 'commits')} ${window} touched only ${list(shown, 'or')}`;
}

function unitQuestions(
	detection: Detection,
	shape: SetupAnswers['shape'],
	unit: Unit,
): Question[] {
	const {facts, formats} = factsOf(detection, unit);
	const {name} = unit;
	const asked: Question[] = [];
	const add = (question: Omit<Question, 'needsAnswer'>, needsAnswer = false) =>
		asked.push({...question, needsAnswer});
	const folder = lastSegment(unit.path);
	add({
		id: `name:${name}`,
		title: `What should ${name} be called?`,
		found: `${name} lives in ${unit.path}, and commands name it, as in --unit ${name}`,
		kind: 'text',
		options: [{value: folder, label: folder, recommended: true}],
	});
	const write = (formats?.write ?? defaultTag(shape)).replaceAll(
		'{unit}',
		name,
	);
	add({
		id: `tag:${name}`,
		title: `How should ${name}'s tags look?`,
		found: formats?.last
			? `${name}'s last tag is ${formats.last.tag}`
			: `${name} has no tags of its own yet`,
		kind: 'text',
		options: unique([write, unit.tag]).map(tag => ({
			value: tag,
			label: tag,
			...(tag === write ? {recommended: true} : {}),
		})),
	});
	if (!formats?.last) {
		const manifest = facts?.version;
		add(
			{
				id: `firstVersion:${name}`,
				title: manifest
					? `${name} is ${manifest} in package.json; start there or at 1.0.0?`
					: `What version should ${name} start at?`,
				found: manifest
					? `${name} has no tags yet, and ${unit.path}/package.json says ${manifest}`
					: `${name} has no tags yet and no version in ${unit.path}/package.json`,
				kind: 'text',
				options: [
					...(manifest
						? [{value: '', label: `Start at ${manifest}`, recommended: true}]
						: []),
					...(manifest === '1.0.0'
						? []
						: [{value: '1.0.0', label: 'Start at 1.0.0'}]),
				],
			},
			true,
		);
	}

	const detected = facts?.versionFiles ?? [];
	const files = unique([
		...detected,
		...unit.versionFiles,
		...(facts?.otherVersionFiles ?? []),
	]);
	if (files.length > 0) {
		add({
			id: `versionFiles:${name}`,
			title: `Which files hold ${name}'s version?`,
			found: `${name}'s version${facts?.version ? ` ${facts.version}` : ''} is also in ${list(files)}`,
			kind: 'ticks',
			options: files.map(file => ({
				value: file,
				label: file,
				...(detected.includes(file) ? {recommended: true} : {}),
			})),
		});
	}

	if (unit.eas) {
		add(
			{
				id: `buildNumber:${name}`,
				title: `Should releases raise ${name}'s build numbers?`,
				found:
					unit.eas === 'remote'
						? `EAS keeps ${name}'s build numbers (appVersionSource: remote), so chamoji leaves them alone`
						: `${unit.path}/eas.json keeps ${name}'s build numbers in the app (appVersionSource: local)`,
				kind: 'choice',
				options: choice(
					[
						['untouched', 'Leave build numbers alone'],
						['increment', 'Raise them by one on each release'],
					],
					'untouched',
				),
			},
			unit.eas === 'local',
		);
	}

	const version = current(detection, unit);
	add({
		id: `versioning:${name}`,
		title: `How should ${name} number its versions?`,
		found: version ? `${name} is at ${version}` : `${name} has no version yet`,
		kind: 'choice',
		options: choice(
			[
				['semver', 'Semver, such as 1.4.0'],
				['calver', 'Dates, as YYYY.MM.N'],
			],
			'semver',
		),
	});
	return asked;
}

/** Every question setup can ask, in screen order, given the current answers. */
export function questions(
	detection: Detection,
	answers: SetupAnswers,
): Question[] {
	const {layout, tags, upstream} = detection;
	const asked: Question[] = [
		{
			id: 'shape',
			title: 'What does this repo release?',
			found: foundSentence(detection, answers).replace(/\.$/, ''),
			kind: 'choice',
			options: choice(
				[
					['single', 'One version for the whole repo'],
					['apps', 'Each app has its own version'],
					['libraries', 'Each published package has its own version'],
				],
				recommendedShape(layout),
			),
			needsAnswer: false,
		},
	];
	if (answers.shape === 'single') return asked;
	const add = (question: Omit<Question, 'needsAnswer'>, needsAnswer = false) =>
		asked.push({...question, needsAnswer});

	const libraries = answers.shape === 'libraries';
	const word = libraries ? 'package' : 'app';
	const candidates = libraries
		? layout.libraries.map(pkg => ({path: pkg.path, ticked: true}))
		: layout.apps;
	const tools = candidates
		.filter(app => !app.ticked)
		.map(app => lastSegment(app.path));
	add({
		id: 'units',
		title: `Which ${word}s get their own versions?`,
		found: `Found ${list(candidates.map(app => lastSegment(app.path)))}${tools.length > 0 ? `; ${list(tools)} look like tests or tools` : ''}`,
		kind: 'ticks',
		options: unique([
			...candidates.map(app => app.path),
			...answers.units.map(unit => unit.path),
		]).map(path => ({
			value: path,
			label: `${lastSegment(path)} (${path})`,
			...(candidates.some(app => app.path === path && app.ticked)
				? {recommended: true}
				: {}),
		})),
	});
	for (const unit of answers.units) {
		asked.push(...unitQuestions(detection, answers.shape, unit));
	}

	const detectedPatterns = [...tags.inherited.patterns, ...tags.stray.patterns];
	const patterns = unique([...detectedPatterns, ...answers.ignore]);
	if (patterns.length > 0) {
		const named = [...tags.inherited.tags, ...tags.stray.tags];
		const parts = [
			tags.inherited.tags.length > 0 &&
				`${count(tags.inherited.tags.length, 'tag looks like it', 'tags look like they')} came from ${baseName(detection, answers)}, such as ${list(tags.inherited.examples)}`,
			tags.stray.tags.length > 0 &&
				`${count(tags.stray.tags.length, 'looks', 'look')} stray, such as ${list(tags.stray.tags.slice(0, 3))}`,
		].filter(Boolean);
		add({
			id: 'ignore',
			title: 'Which tags should never count as releases?',
			found:
				parts.length > 0
					? parts.join(', and ')
					: 'No tags look inherited or stray',
			kind: 'ticks',
			options: patterns.map(pattern => {
				const example = named.find(tag => matchesTagPattern(tag, pattern));
				return {
					value: pattern,
					label: example ? `${pattern} (such as ${example})` : pattern,
					...(detectedPatterns.includes(pattern) ? {recommended: true} : {}),
				};
			}),
		});
	}

	const {tags: kept} = answers.kept;
	const aliases = isObject(kept) && isObject(kept.aliases) ? kept.aliases : {};
	for (const unit of answers.units) {
		for (const tag of factsOf(detection, unit).formats?.unparseable ?? []) {
			add(
				{
					id: `alias:${tag}`,
					title: `Which version of ${unit.name} was ${tag}?`,
					found: `${tag} names ${unit.name} but has no version in it`,
					kind: 'text',
					options: [{value: '', label: "It isn't a release"}],
				},
				!Object.hasOwn(aliases, tag),
			);
		}
	}

	if (upstream.remote || answers.upstream) {
		const suggested = suggestedBase(detection);
		add(
			{
				id: 'upstream.name',
				title: 'What should sync lines call the base you started from?',
				found: upstream.remote
					? `${count(upstream.upstreamCommits, 'commit', 'commits')} came from the ${upstream.remote} remote before your own history starts`
					: `Your own history starts after tags such as ${tags.inherited.examples[0] ?? 'the template'}`,
				kind: 'text',
				options: [{value: suggested, label: suggested, recommended: true}],
			},
			upstream.remote !== null,
		);
	}

	// The engine's own idea of which internal packages a unit uses.
	const uses = resolveUnits(
		parseReleaseSettings(releaseSection(answers), CONFIG_FILE),
		layout.packages,
	).filter(unit => unit.uses.length > 0);
	add({
		id: 'sharedChanges',
		title: 'What happens when a shared package changes?',
		found:
			uses.length > 0
				? uses.map(unit => `${unit.name} uses ${list(unit.uses)}`).join('; ')
				: `No ${word} uses an internal package yet`,
		kind: 'choice',
		options: choice(
			[
				['ride-along', `It rides along with each ${word}'s own next release`],
				['release-dependents', `It releases every ${word} that uses it`],
			],
			libraries ? 'release-dependents' : 'ride-along',
		),
	});
	add({
		id: 'rootFiles',
		title: 'What about commits that touch only root files?',
		found: rootFilesFound(detection, answers),
		kind: 'choice',
		options: choice(
			[
				['none', 'Leave them out of every changelog'],
				['all', `Count them for every ${word}`],
				['note', 'One summary line in each changelog'],
			],
			'none',
		),
	});
	const zero = answers.units.flatMap(unit => {
		const version = current(detection, unit);
		return version?.startsWith('0.') ? [`${unit.name} is at ${version}`] : [];
	});
	add(
		{
			id: 'zeroMajor',
			title: 'What should a breaking change do while a version is 0.x?',
			found: zero.length > 0 ? list(zero) : `No ${word} is at 0.x`,
			kind: 'choice',
			options: choice(
				[
					['minor', 'Bump the minor version, as 0.2.0 to 0.3.0'],
					['major', 'Bump to 1.0.0'],
				],
				zero.length > 0 ? 'minor' : 'major',
			),
		},
		zero.length > 0,
	);
	if (libraries) {
		const shared = answers.units.filter(
			unit => factsOf(detection, unit).formats?.write === SHARED_TAG,
		);
		add({
			id: 'fixed',
			title: 'Which packages always share one version?',
			found:
				shared.length > 1
					? `${list(shared.map(unit => unit.name))} share ${SHARED_TAG} tags`
					: 'Each package has tags of its own',
			kind: 'ticks',
			options: answers.units.map(unit => ({
				value: unit.name,
				label: unit.name,
				...(shared.length > 1 && shared.includes(unit)
					? {recommended: true}
					: {}),
			})),
		});
	}

	add({
		id: 'rootChangelog',
		title: 'Should a root CHANGELOG.md list every release too?',
		found: `Each ${word} gets a CHANGELOG.md in its own folder`,
		kind: 'choice',
		options: choice(
			[
				['false', `No; each ${word}'s changelog stands alone`],
				['true', "Yes, with links to each one's changelog"],
			],
			'false',
		),
	});
	return asked;
}

/** "Found 4 apps (web, mobile, e2e, dev-tool) and 39 internal packages." */
function foundSentence({layout}: Detection, answers: SetupAnswers): string {
	if (answers.shape === 'single') {
		return 'Found a single package; it keeps one version, as today.';
	}

	const libraries = answers.shape === 'libraries';
	const candidates = (libraries ? layout.libraries : layout.apps).map(
		each => each.path,
	);
	const unitPaths = answers.units.map(unit => unit.path);
	const names = [
		...answers.units.map(unit => unit.name),
		...candidates.filter(path => !unitPaths.includes(path)).map(lastSegment),
	];
	const internal = layout.packages.filter(
		pkg =>
			!candidates.includes(pkg.path) &&
			!unitPaths.includes(pkg.path) &&
			ownerOf(`${pkg.path}/package.json`, [], layout.packages, answers.exclude)
				.kind !== 'excluded',
	).length;
	const what = libraries
		? count(names.length, 'published package', 'published packages')
		: count(names.length, 'app', 'apps');
	return `Found ${what} (${names.join(', ')})${
		internal > 0
			? ` and ${count(internal, 'internal package', 'internal packages')}`
			: ''
	}.`;
}

/** The first-screen paragraph: what setup found and what it will do. */
export function summary(detection: Detection, answers: SetupAnswers): string {
	const {tags, upstream} = detection;
	const base = baseName(detection, answers);
	const sentences = [foundSentence(detection, answers)];
	if (answers.shape !== 'single') {
		const word = answers.shape === 'libraries' ? 'package' : 'app';
		const grouped = answers.fixed.flat();
		const own = answers.units
			.map(unit => unit.name)
			.filter(name => !grouped.includes(name));
		const left = answers.exclude.map(lastSegment);
		const clauses = [
			own.length > 0 &&
				`${list(own)} ${own.length === 1 ? 'gets its own version' : 'get their own versions'}`,
			...answers.fixed.map(group => `${list(group)} share one version`),
			left.length > 0 &&
				`${list(left)} ${left.length === 1 ? 'is' : 'are'} left out`,
		].filter(Boolean);
		if (clauses.length > 0) sentences.push(`${clauses.join('; ')}.`);
		const ignored = tags.inherited.tags.filter(tag =>
			answers.ignore.some(pattern => matchesTagPattern(tag, pattern)),
		).length;
		if (ignored > 0) {
			sentences.push(
				`${count(ignored, 'tag looks like it', 'tags look like they')} came from ${base} and will be ignored.`,
			);
		}

		sentences.push(
			answers.sharedChanges === 'ride-along'
				? `Shared changes ride along with each ${word}'s own releases.`
				: `A shared change releases every ${word} that uses it.`,
		);
	}

	for (const unit of answers.units) {
		const {facts, formats} = factsOf(detection, unit);
		if (formats?.manifestDisagrees && formats.last && facts?.version) {
			sentences.push(
				`${unit.name}'s last tag says ${formats.last.version} but ${unit.path}/package.json says ${facts.version}; the tag wins, and the release sets the file to the new version.`,
			);
		}
	}

	const squashed = upstream.squashedSyncs.length;
	if (squashed > 0) {
		// "Makerkit syncs", or "template syncs" for the fallback.
		const kind = answers.upstream?.name ?? suggestedBase(detection);
		sentences.push(
			squashed === 1
				? `1 commit looks like a squash-merged ${kind} sync; it counts as an ordinary commit.`
				: `${squashed} commits look like squash-merged ${kind} syncs; they count as ordinary commits.`,
		);
	}

	return sentences.join(' ');
}
