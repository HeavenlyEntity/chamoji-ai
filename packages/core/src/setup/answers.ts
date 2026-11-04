import semver from 'semver';
import {CONFIG_FILE} from '../config.js';
import {renderJson} from '../json-text.js';
import {parseReleaseSettings} from '../units/settings.js';
import {escapeRegExp, matchesTagPattern} from '../units/tags.js';
import {ownerOf, resolveUnits} from '../units/workspace.js';
import {detectLayout, type LayoutDetection, type UnitFacts} from './detect.js';
import {
	detectTags,
	findUpstreamRemote,
	type TagDetection,
	type UnitTagFormats,
} from './tags.js';
import {detectUpstream, type UpstreamDetection} from './upstream.js';

export type Detection = {
	layout: LayoutDetection;
	tags: TagDetection;
	upstream: UpstreamDetection;
};

/** Everything setup reads from the repo: layout, tags, then upstream history. */
export async function detect(root: string): Promise<Detection> {
	const layout = await detectLayout(root);
	const remote = await findUpstreamRemote(root);
	const tags = await detectTags(layout, remote);
	const upstream = await detectUpstream(root, remote, tags.inherited.tags);
	return {layout, tags, upstream};
}

/** Where an answer came from, for `--explain`. */
export type Source = 'detected' | 'recommended' | 'chosen' | 'kept';

export type SetupAnswers = {
	shape: 'single' | 'apps' | 'libraries';
	units: Array<{
		name: string;
		path: string;
		tag: string;
		read: string[];
		versionFiles: string[];
		buildNumber: 'untouched' | 'increment';
		firstVersion?: string;
		versioning: 'semver' | 'calver';
	}>;
	exclude: string[];
	sharedChanges: 'ride-along' | 'release-dependents';
	rootFiles: 'none' | 'all' | 'note';
	zeroMajor?: 'minor';
	fixed: string[][];
	upstream?: {remote?: string; name: string; since?: string};
	ignore: string[];
	rootChangelog: boolean;
	/** Hand-written keys setup doesn't ask about, carried through as written. */
	kept: Record<string, unknown>;
	/** Keyed by question id. */
	why: Record<string, Source>;
};

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

const NAME = /^[a-z0-9][a-z0-9._-]*$/;
const SHARED_TAG = 'v{version}';
/** Ids whose recommended answer is read from the repo rather than chamoji's default. */
const DETECTED = new Set([
	'shape',
	'units',
	'ignore',
	'name',
	'tag',
	'versionFiles',
]);

const isObject = (value: unknown): value is Obj =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
const unique = <T>(values: T[]): T[] => [...new Set(values)];
const lastSegment = (folder: string): string =>
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

const defaultTag = (shape: SetupAnswers['shape']): string =>
	shape === 'libraries' ? '{name}@{version}' : '{unit}/v{version}';

/** A unit's facts and tag formats, by path, so a renamed unit still finds them. */
function factsOf(
	detection: Detection,
	unit: Unit,
): {facts?: UnitFacts; formats?: UnitTagFormats} {
	const facts = detection.layout.units.find(each => each.path === unit.path);
	return {facts, formats: facts && detection.tags.perUnit[facts.name]};
}

/** What the unit is at now: its last tag, else its manifest. */
const current = (detection: Detection, unit: Unit): string | null => {
	const {facts, formats} = factsOf(detection, unit);
	return formats?.last?.version ?? facts?.version ?? null;
};

const recommendedShape = (layout: LayoutDetection): SetupAnswers['shape'] =>
	layout.kind === 'mixed' ? 'apps' : layout.kind;

/** The recommended answer to every question, with no prompts. */
export function recommend(detection: Detection): SetupAnswers {
	const {layout, tags, upstream} = detection;
	const shape = recommendedShape(layout);
	const units: Unit[] =
		shape === 'single'
			? []
			: layout.units.map(facts => {
					const formats = tags.perUnit[facts.name];
					return {
						name: facts.name,
						path: facts.path,
						// {unit} is resolved now, so a rename keeps the tag (ruling R9).
						tag: (formats?.write ?? defaultTag(shape)).replaceAll(
							'{unit}',
							facts.name,
						),
						read: formats?.read ?? [],
						versionFiles: facts.versionFiles,
						buildNumber: 'untouched',
						versioning: 'semver',
					};
				});
	const shared =
		shape === 'libraries' &&
		units.length > 1 &&
		units.every(unit => unit.tag === SHARED_TAG);
	const base = upstream.name ?? upstream.remote ?? 'template';
	const answers: SetupAnswers = {
		shape,
		units,
		exclude: shape === 'apps' ? [...layout.excluded] : [],
		sharedChanges: shape === 'libraries' ? 'release-dependents' : 'ride-along',
		rootFiles: 'none',
		...(units.some(unit => current(detection, unit)?.startsWith('0.'))
			? {zeroMajor: 'minor' as const}
			: {}),
		fixed: shared ? [units.map(unit => unit.name)] : [],
		...(shape !== 'single' && (upstream.remote || upstream.since)
			? {
					upstream: {
						...(upstream.remote ? {remote: upstream.remote} : {}),
						name: base,
						...(upstream.since ? {since: upstream.since} : {}),
					},
				}
			: {}),
		ignore:
			shape === 'single'
				? []
				: [...tags.inherited.patterns, ...tags.stray.patterns],
		rootChangelog: false,
		kept: {},
		why: {},
	};
	answers.why = whyFor(detection, answers, id =>
		DETECTED.has(id.split(':')[0]!) || (id === 'fixed' && shared)
			? 'detected'
			: 'recommended',
	);
	return answers;
}

const whyFor = (
	detection: Detection,
	answers: SetupAnswers,
	source: (id: string) => Source,
): Record<string, Source> =>
	Object.fromEntries(
		questions(detection, answers).map(question => [
			question.id,
			source(question.id),
		]),
	);

/** Keys setup asks about; the rest of a section is kept as written. */
const ASKED: Obj = {
	schema: true,
	shape: true,
	units: {
		'*': Object.fromEntries(
			[
				'path',
				'tag',
				'read',
				'versionFiles',
				'buildNumber',
				'firstVersion',
				'versioning',
			].map(key => [key, true]),
		),
	},
	...Object.fromEntries(
		[
			'exclude',
			'sharedChanges',
			'rootFiles',
			'zeroMajor',
			'fixed',
			'upstream',
			'rootChangelog',
		].map(key => [key, true]),
	),
	tags: {ignore: true},
};

/** What's left of `value` once the asked keys are taken out. */
function unasked(value: Obj, asked: Obj): Obj {
	const rest: Obj = {};
	for (const [key, item] of Object.entries(value)) {
		const rule = Object.hasOwn(asked, key) ? asked[key] : asked['*'];
		if (rule === true) continue;
		if (isObject(rule) && isObject(item)) {
			const inner = unasked(item, rule);
			if (Object.keys(inner).length > 0) rest[key] = inner;
		} else {
			rest[key] = item;
		}
	}

	return rest;
}

/** Answers that reproduce an existing `release` section, for a re-run. */
export function answersFromSection(
	section: unknown,
	detection: Detection,
): SetupAnswers {
	const settings = parseReleaseSettings(section, CONFIG_FILE);
	const answers: SetupAnswers = {
		shape: settings.shape,
		units: settings.units.map(unit => ({
			name: unit.name,
			path: unit.path,
			tag: unit.tag,
			read: unit.read,
			versionFiles: unit.versionFiles,
			buildNumber: unit.buildNumber,
			...(unit.firstVersion ? {firstVersion: unit.firstVersion} : {}),
			versioning: unit.versioning,
		})),
		exclude: settings.exclude,
		sharedChanges: settings.sharedChanges,
		rootFiles: settings.rootFiles,
		...(settings.zeroMajor ? {zeroMajor: settings.zeroMajor} : {}),
		fixed: settings.fixed,
		...(settings.upstream ? {upstream: settings.upstream} : {}),
		ignore: settings.tags.ignore,
		rootChangelog: settings.rootChangelog,
		kept: unasked(section as Obj, ASKED),
		why: {},
	};
	answers.why = whyFor(detection, answers, () => 'kept');
	return answers;
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

/** "12 commits since your last release touched only pnpm-lock.yaml or .github/". */
function rootFilesFound({layout, tags}: Detection): string {
	const {count: n, examples} = layout.rootOnly;
	if (n === 0)
		return 'No recent commit touched only files outside the packages';
	const shown = unique(
		examples.map(file =>
			file.includes('/') ? `${file.split('/')[0]}/` : file,
		),
	).sort((a, b) => Number(a.endsWith('/')) - Number(b.endsWith('/')));
	const since = Object.values(tags.perUnit).some(formats => formats.last)
		? 'since your last release'
		: 'so far';
	return `${count(n, 'commit', 'commits')} ${since} touched only ${list(shown, 'or')}`;
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

	if (facts?.easRemote || facts?.easLocal) {
		add(
			{
				id: `buildNumber:${name}`,
				title: `Should releases raise ${name}'s build numbers?`,
				found: facts.easRemote
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
			facts.easLocal,
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
	for (const unit of answers.units)
		asked.push(...unitQuestions(detection, answers.shape, unit));

	const detectedPatterns = [...tags.inherited.patterns, ...tags.stray.patterns];
	const patterns = unique([...detectedPatterns, ...answers.ignore]);
	if (patterns.length > 0) {
		const named = [...tags.inherited.tags, ...tags.stray.tags];
		const base = answers.upstream?.name ?? upstream.name ?? 'a template';
		const parts = [
			tags.inherited.tags.length > 0 &&
				`${count(tags.inherited.tags.length, 'tag looks like it', 'tags look like they')} came from ${base}, such as ${list(tags.inherited.examples)}`,
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
		const suggested =
			upstream.name ?? upstream.remote ?? answers.upstream?.name ?? 'template';
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
		found: rootFilesFound(detection),
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

const text = (id: string, value: string | string[]): string => {
	if (typeof value !== 'string') throw new Error(`${id} takes one value`);
	return value.trim();
};

const ticks = (id: string, value: string | string[]): string[] => {
	if (!Array.isArray(value)) throw new Error(`${id} takes a list`);
	return unique(value);
};

function oneOf<const T extends string>(
	id: string,
	value: string | string[],
	allowed: readonly T[],
): T {
	const given = text(id, value);
	if (!allowed.includes(given as T)) {
		throw new Error(`${id} must be one of ${allowed.join(', ')}`);
	}

	return given as T;
}

/** The answers with one question answered; throws when the engine would refuse the result. */
export function applyAnswer(
	answers: SetupAnswers,
	id: string,
	value: string | string[],
): SetupAnswers {
	const next = structuredClone(answers);
	const colon = id.indexOf(':');
	const kind = colon === -1 ? id : id.slice(0, colon);
	const target = colon === -1 ? '' : id.slice(colon + 1);
	const unit = next.units.find(each => each.name === target);
	const needUnit = (): Unit => {
		if (!unit) throw new Error(`${id}: there's no unit named ${target}`);
		return unit;
	};

	let chosen = id;
	switch (kind) {
		case 'shape': {
			next.shape = oneOf(id, value, ['single', 'apps', 'libraries']);
			if (next.why.sharedChanges !== 'chosen') {
				next.sharedChanges =
					next.shape === 'libraries' ? 'release-dependents' : 'ride-along';
			}

			break;
		}

		case 'units': {
			const paths = ticks(id, value);
			for (const gone of next.units.filter(
				each => !paths.includes(each.path),
			)) {
				if (next.shape === 'apps') next.exclude.push(gone.path);
				for (const key of Object.keys(next.why)) {
					if (key.endsWith(`:${gone.name}`)) delete next.why[key];
				}
			}

			next.exclude = unique(
				next.exclude.filter(path => !paths.includes(path)),
			).sort();
			const kept = next.units.filter(each => paths.includes(each.path));
			for (const path of paths.filter(
				path => !kept.some(each => each.path === path),
			)) {
				const name = lastSegment(path);
				kept.push({
					name,
					path,
					tag: defaultTag(next.shape).replaceAll('{unit}', name),
					read: [],
					versionFiles: [],
					buildNumber: 'untouched',
					versioning: 'semver',
				});
			}

			next.units = kept.sort((a, b) =>
				a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
			);
			const names = next.units.map(each => each.name);
			if (new Set(names).size !== names.length) {
				throw new Error(
					`${id}: two units would share a name; rename one first`,
				);
			}

			next.fixed = next.fixed
				.map(group => group.filter(name => names.includes(name)))
				.filter(group => group.length > 1);
			break;
		}

		case 'name': {
			const renamed = needUnit();
			const name = text(id, value);
			if (
				!NAME.test(name) ||
				next.units.some(each => each !== renamed && each.name === name)
			) {
				throw new Error(
					`A unit name must match ^[a-z0-9][a-z0-9._-]*$ and be unique; "${name}" doesn't`,
				);
			}

			rename(next, renamed.name, name);
			renamed.name = name;
			chosen = `name:${name}`;
			break;
		}

		case 'tag': {
			const changed = needUnit();
			const tag = text(id, value);
			// Old tags keep counting after the format changes.
			if (tag !== changed.tag) {
				changed.read = unique([...changed.read, changed.tag]).filter(
					each => each !== tag,
				);
			}

			changed.tag = tag;
			break;
		}

		case 'firstVersion': {
			const changed = needUnit();
			const version = text(id, value);
			if (version === '') {
				delete changed.firstVersion;
			} else if (semver.valid(version)) {
				changed.firstVersion = version;
			} else {
				throw new Error(`${id} must be a version such as 1.0.0`);
			}

			break;
		}

		case 'versionFiles':
			needUnit().versionFiles = ticks(id, value);
			break;
		case 'buildNumber':
			needUnit().buildNumber = oneOf(id, value, ['untouched', 'increment']);
			break;
		case 'versioning':
			needUnit().versioning = oneOf(id, value, ['semver', 'calver']);
			break;
		case 'ignore':
			next.ignore = ticks(id, value);
			break;
		case 'upstream.name': {
			const name = text(id, value);
			if (!name) throw new Error(`${id} needs a name, such as Makerkit`);
			next.upstream = {...next.upstream, name};
			break;
		}

		case 'sharedChanges':
			next.sharedChanges = oneOf(id, value, [
				'ride-along',
				'release-dependents',
			]);
			break;
		case 'rootFiles':
			next.rootFiles = oneOf(id, value, ['none', 'all', 'note']);
			break;
		case 'zeroMajor':
			if (oneOf(id, value, ['minor', 'major']) === 'minor') {
				next.zeroMajor = 'minor';
			} else {
				delete next.zeroMajor;
			}

			break;
		case 'fixed': {
			const group = ticks(id, value);
			const names = next.units.map(each => each.name);
			const unknown = group.find(name => !names.includes(name));
			if (unknown) throw new Error(`${id}: there's no unit named ${unknown}`);
			next.fixed = group.length > 1 ? [group] : [];
			break;
		}

		case 'rootChangelog':
			next.rootChangelog = oneOf(id, value, ['true', 'false']) === 'true';
			break;
		case 'alias':
			setAlias(next, target, text(id, value));
			break;
		default:
			throw new Error(`There's no setup question ${id}`);
	}

	next.why[chosen] = 'chosen';
	parseReleaseSettings(releaseSection(next), CONFIG_FILE);
	return next;
}

/** Moves what hangs off a unit's name: why keys, fixed groups and kept settings. */
function rename(answers: SetupAnswers, from: string, to: string): void {
	for (const [key, source] of Object.entries(answers.why)) {
		if (key.endsWith(`:${from}`)) {
			delete answers.why[key];
			answers.why[`${key.slice(0, -from.length)}${to}`] = source;
		}
	}

	answers.fixed = answers.fixed.map(group =>
		group.map(name => (name === from ? to : name)),
	);
	const {units, tags} = answers.kept;
	if (isObject(units) && Object.hasOwn(units, from)) {
		units[to] = units[from];
		delete units[from];
	}

	if (isObject(tags) && isObject(tags.aliases)) {
		for (const alias of Object.values(tags.aliases)) {
			if (isObject(alias) && alias.unit === from) alias.unit = to;
		}
	}
}

/** Records (or with '' drops) an alias for the unit the tag names, longest name first. */
function setAlias(answers: SetupAnswers, tag: string, version: string): void {
	const tags = isObject(answers.kept.tags) ? answers.kept.tags : {};
	const aliases = isObject(tags.aliases) ? tags.aliases : {};
	if (version === '') {
		delete aliases[tag];
	} else {
		if (!semver.valid(version)) {
			throw new Error(`alias:${tag} must be a version such as 1.0.0`);
		}

		const named = answers.units
			.filter(unit =>
				new RegExp(
					`(?:^|[^a-z0-9])${escapeRegExp(unit.name)}(?:[^a-z0-9]|$)`,
					'i',
				).test(tag),
			)
			.sort((a, b) => b.name.length - a.name.length)[0];
		const unit =
			named ?? (answers.units.length === 1 ? answers.units[0] : undefined);
		if (!unit) {
			throw new Error(
				`${tag} doesn't name a unit, so chamoji can't tell whose release it was`,
			);
		}

		aliases[tag] = {unit: unit.name, version};
	}

	answers.kept.tags = {...tags, aliases};
}

/** The `release` section for chamoji.config.json, defaults left out. */
export function releaseSection(answers: SetupAnswers): Record<string, unknown> {
	const section: Obj = {schema: 1, shape: answers.shape};
	const names = new Set(answers.units.map(unit => unit.name));
	if (answers.shape !== 'single') {
		const units: Obj = {};
		for (const unit of answers.units) {
			units[unit.name] = {
				path: unit.path,
				tag: unit.tag.replaceAll('{unit}', unit.name),
				...(unit.read.length > 0 ? {read: unit.read} : {}),
				...(unit.versionFiles.length > 0
					? {versionFiles: unit.versionFiles}
					: {}),
				// An EAS app always says what happens to its build numbers (R2).
				...(unit.buildNumber !== 'untouched' ||
				answers.why[`buildNumber:${unit.name}`]
					? {buildNumber: unit.buildNumber}
					: {}),
				...(unit.firstVersion ? {firstVersion: unit.firstVersion} : {}),
				...(unit.versioning === 'semver' ? {} : {versioning: unit.versioning}),
			};
		}

		Object.assign(section, {
			units,
			exclude: answers.exclude,
			sharedChanges: answers.sharedChanges,
			rootFiles: answers.rootFiles,
			...(answers.zeroMajor ? {zeroMajor: answers.zeroMajor} : {}),
			...(answers.fixed.length > 0 ? {fixed: answers.fixed} : {}),
			...(answers.upstream ? {upstream: answers.upstream} : {}),
			...(answers.ignore.length > 0 ? {tags: {ignore: answers.ignore}} : {}),
			...(answers.rootChangelog ? {rootChangelog: true} : {}),
		});
	}

	return merge(section, keptFor(answers.kept, names));
}

/** Kept settings, less any for a unit that is no longer one. */
function keptFor(kept: Obj, names: Set<string>): Obj {
	const copy = structuredClone(kept);
	if (isObject(copy.units)) {
		for (const name of Object.keys(copy.units)) {
			if (!names.has(name)) delete copy.units[name];
		}

		if (Object.keys(copy.units).length === 0) delete copy.units;
	}

	const {tags} = copy;
	if (isObject(tags) && isObject(tags.aliases)) {
		for (const [tag, alias] of Object.entries(tags.aliases)) {
			if (isObject(alias) && !names.has(alias.unit as string)) {
				delete tags.aliases[tag];
			}
		}

		if (Object.keys(tags.aliases).length === 0) delete tags.aliases;
		if (Object.keys(tags).length === 0) delete copy.tags;
	}

	return copy;
}

/** `extra` folded into `base`: objects merge, and `base` wins on a clash. */
function merge(base: Obj, extra: Obj): Obj {
	for (const [key, value] of Object.entries(extra)) {
		if (isObject(base[key]) && isObject(value)) {
			base[key] = merge({...base[key]}, value);
		} else if (!Object.hasOwn(base, key)) {
			base[key] = value;
		}
	}

	return base;
}

/** `next` with its object keys in `previous`'s order where both have them. */
function orderLike(next: unknown, previous: unknown): unknown {
	if (!isObject(next) || !isObject(previous)) return next;
	const keys = [
		...Object.keys(previous).filter(key => Object.hasOwn(next, key)),
		...Object.keys(next).filter(key => !Object.hasOwn(previous, key)),
	];
	return Object.fromEntries(
		keys.map(key => [key, orderLike(next[key], previous[key])]),
	);
}

/**
 * chamoji.config.json's text with `release` set and every other key kept, in
 * the file's own indent, number spelling and final newline. A file whose
 * section already says the same is left exactly as it is.
 */
export function writeReleaseSection(
	original: string | null,
	section: Record<string, unknown>,
): {text: string; changed: boolean} {
	const body = (original ?? '').replace(/^﻿/, '');
	let data: Obj = {};
	if (body.trim() !== '') {
		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch (error) {
			throw new Error(
				`${CONFIG_FILE} isn't valid JSON: ${(error as Error).message}`,
			);
		}

		if (!isObject(parsed))
			throw new Error(`${CONFIG_FILE} isn't a JSON object`);
		data = parsed;
	}

	const release = orderLike(section, data.release);
	if (
		original !== null &&
		Object.hasOwn(data, 'release') &&
		JSON.stringify(release) === JSON.stringify(data.release)
	) {
		return {text: original, changed: false};
	}

	data.release = release;
	const text = renderJson(data, original ?? '');
	return {text, changed: text !== original};
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
		const base = answers.upstream?.name ?? upstream.name ?? 'a template';
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
		const base = answers.upstream?.name ?? upstream.name ?? 'upstream';
		sentences.push(
			squashed === 1
				? `1 commit looks like a squash-merged ${base} sync; it counts as an ordinary commit.`
				: `${squashed} commits look like squash-merged ${base} syncs; they count as ordinary commits.`,
		);
	}

	return sentences.join(' ');
}
