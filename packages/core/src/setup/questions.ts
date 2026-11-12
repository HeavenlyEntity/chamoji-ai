import {CONFIG_FILE} from '../config.js';
import {sdfFramework} from '../publish/frameworks.js';
import {parseReleaseSettings} from '../units/settings.js';
import {matchesTagPattern, versionFromTag} from '../units/tags.js';
import {ownerOf, resolveUnits, unitNameOf} from '../units/workspace.js';
import type {Detection, SetupAnswers} from './answers.js';
import {MAX_COMMITS, type LayoutDetection, type UnitFacts} from './detect.js';
import {
	candidateAt,
	effectiveTrigger,
	mentionFor,
	tokenRegistry,
	versionSource,
} from './rules.js';
import {releaseSection} from './section.js';
import type {UnitTagFormats} from './tags.js';
import {isObject} from '../util/object.js';
import {unique} from '../util/array.js';

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

export const SHARED_TAG = 'v{version}';

/** ' · Next.js' for a candidate with a known framework, else ''. */
const frameworkSuffix = (layout: LayoutDetection, folder: string): string => {
	const framework = candidateAt(layout, folder)?.framework;
	return framework ? ` · ${framework.name}` : '';
};

/** A NetSuite project's label: 'backend (NetSuite SuiteApp · com.example.myapp 2.10.34)'. */
function sdfLabel(layout: LayoutDetection, name: string, folder: string) {
	const project = candidateAt(layout, folder)?.sdf;
	if (!project) return name;
	const framework = sdfFramework(project).name;
	const detail = [project.applicationId, project.version]
		.filter(Boolean)
		.join(' ');
	return `${name} (${framework}${detail ? ` · ${detail}` : ''})`;
}

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

const FALLBACK_BASE = 'template';

/**
 * The base a repo started from: `name` as `upstream.name` holds it (the
 * engine writes "Updated the <name> base"), and `prose` as copy says it,
 * "the template" for the fallback.
 */
export function baseName(
	detection: Detection,
	answers?: SetupAnswers,
): {name: string; prose: string} {
	const name =
		answers?.upstream?.name ?? detection.upstream.name ?? FALLBACK_BASE;
	return {name, prose: name === FALLBACK_BASE ? `the ${name}` : name};
}

/** A unit's facts and tag formats, by path, so a renamed unit still finds them. */
export function factsOf(
	detection: Detection,
	unit: {path: string},
): {facts?: UnitFacts; formats?: UnitTagFormats} {
	const {units} = detection.layout;
	const facts = candidateAt(detection.layout, unit.path);
	if (!facts) return {};
	// A detected unit's formats, else the candidate's.
	const detected = units.some(each => each.path === unit.path);
	return {
		facts,
		formats: detected
			? detection.tags.perUnit[facts.name]
			: detection.tags.candidates[facts.path],
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

/** The question for a unit with no tags: which version its first release starts from. */
function firstVersionQuestion(
	name: string,
	unitPath: string,
	facts: UnitFacts | undefined,
	source: ReturnType<typeof versionSource>,
): Omit<Question, 'needsAnswer'> {
	const startAt = (version: string, value = version, recommended = false) => ({
		value,
		label: `Start at ${version}`,
		...(recommended ? {recommended} : {}),
	});
	const mismatch = facts?.versionMismatch ?? null;
	const stem = `${name} has no tags yet`;
	if (mismatch) {
		return {
			id: `firstVersion:${name}`,
			title: `${name} is ${mismatch.manifest} in manifest.xml but ${mismatch.packageJson} in package.json; which is current?`,
			found: `${stem}, ${facts?.sdf?.manifest ?? 'its manifest.xml'} says ${mismatch.manifest}, and ${unitPath}/package.json says ${mismatch.packageJson}`,
			kind: 'text',
			options: [
				startAt(mismatch.manifest, mismatch.manifest, true),
				startAt(mismatch.packageJson),
			],
		};
	}

	const manifest = facts?.version;
	const file = source.hasPackage
		? 'package.json'
		: (source.file?.split('/').pop() ?? 'manifest.xml');
	return {
		id: `firstVersion:${name}`,
		title: !manifest
			? `What version should ${name} start at?`
			: manifest === '1.0.0'
				? `${name} is ${manifest} in ${file}; start there?`
				: `${name} is ${manifest} in ${file}; start there or at 1.0.0?`,
		found: manifest
			? `${stem}, and ${source.file ?? 'manifest.xml'} says ${manifest}`
			: `${stem} and no version in ${unitPath}/package.json`,
		kind: 'text',
		options: [
			...(manifest ? [startAt(manifest, '', true)] : []),
			...(manifest === '1.0.0' ? [] : [startAt('1.0.0')]),
		],
	};
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
	const folder = unitNameOf(unit.path);
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
		add(
			firstVersionQuestion(
				name,
				unit.path,
				facts,
				versionSource(detection, unit),
			),
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

/** Where the repo's own history starts, from the remote, inherited tags or config. */
function upstreamFound(detection: Detection, answers: SetupAnswers): string {
	const {upstream, tags} = detection;
	const {prose} = baseName(detection, answers);
	if (upstream.remote) {
		return `${count(upstream.upstreamCommits, 'commit', 'commits')} came from the ${upstream.remote} remote before your own history starts`;
	}

	if (tags.inherited.examples.length > 0) {
		return `Your own history starts after ${prose}'s tags, such as ${list(tags.inherited.examples)}`;
	}

	const since = answers.upstream?.since ?? upstream.since;
	return since
		? `Your own history starts at commit ${since.slice(0, 7)}`
		: `No upstream remote or ${prose} tags were found`;
}

/** A package's role as the publish question says it: 'library: `exports` field'. */
const roleOf = (kind: string, reasons: string[]): string =>
	reasons.length > 0 ? `${kind}: ${reasons.join(', ')}` : kind;

/** The questions every shape gets: when to release, breaking changes, npm and version pins. */
function releaseQuestions(
	detection: Detection,
	answers: SetupAnswers,
): Question[] {
	const {branch, publishable, publicApps} = detection;
	const asked: Question[] = [];
	const add = (question: Omit<Question, 'needsAnswer'>, needsAnswer = false) =>
		asked.push({...question, needsAnswer});
	add(
		{
			id: 'trigger',
			title: 'When should a release happen?',
			found: `Your default branch is ${branch}`,
			kind: 'choice',
			options: choice(
				[
					['merge', `On merge to ${branch}`],
					['manual', 'Only when someone runs it'],
				],
				'merge',
			),
		},
		// A section from before triggers existed is asked again.
		answers.triggerUnset === true,
	);
	add({
		id: 'majors',
		title: 'What happens with a breaking change?',
		found:
			'A breaking change raises the major version, a bigger step than a feature or a fix',
		kind: 'choice',
		options: choice(
			[
				['auto', 'Release on merge like any other change'],
				['manual', 'Wait for someone to release it'],
			],
			'auto',
		),
	});
	if (publishable.length > 0 || answers.publish) {
		const apps = publicApps.map(app => app.name);
		const found =
			publishable.length > 0
				? `Publishing ${list(
						publishable.map(
							pkg => `${pkg.name} (${roleOf('library', pkg.reasons)})`,
						),
					)}${
						apps.length > 0
							? `; ${list(apps)} ${apps.length === 1 ? 'is an app and is' : 'are apps and are'} not published`
							: ''
					}`
				: 'No public library was found to publish';
		add({
			id: 'publish',
			title: 'Publish packages to npm?',
			found,
			kind: 'choice',
			options: choice(
				[
					['on', 'Yes, publish after each release'],
					['off', 'No, only tag and release'],
				],
				publishable.length > 0 ? 'on' : 'off',
			),
		});
	}

	if (answers.publish) {
		add({
			id: 'publish.check',
			title: 'Which command must pass before publishing?',
			found: detection.check
				? `The root package.json has scripts that ${detection.check} runs`
				: 'The root package.json has no check, test or build script',
			kind: 'text',
			options: detection.check
				? [{value: detection.check, label: detection.check, recommended: true}]
				: [{value: '', label: 'No check', recommended: true}],
		});
	}

	if (publicApps.length > 0) {
		add({
			id: 'privatize',
			title: 'Which public apps should be marked private?',
			found: `${list(publicApps.map(app => `${app.name} (${roleOf('app', app.kind.reasons)})`))} ${publicApps.length === 1 ? 'has' : 'have'} no "private": true, so npm would accept a publish`,
			kind: 'ticks',
			options: publicApps.map(app => ({
				value: app.path,
				label: `${app.name} (${app.path === '' ? 'package.json' : app.path})`,
				recommended: true,
			})),
		});
	}

	if (answers.publish) {
		const other = tokenRegistry(detection);
		add({
			id: 'ciAuth',
			title: 'How should CI sign in to npm?',
			found: other
				? `${other.name} publishes to ${other.registry}, which needs an npm token`
				: 'Every package publishes to npmjs, which supports trusted publishing',
			kind: 'choice',
			options: choice(
				[
					['oidc', 'Trusted publishing'],
					['token', 'An npm token'],
				],
				other ? 'token' : 'oidc',
			),
		});
	}

	const detected = detection.mentions.flatMap(mention => {
		const held = mentionFor(answers, mention);
		return held ? [held] : [];
	});
	const patterns = unique([
		...detected.map(mention => mention.pattern),
		...answers.mentions.map(mention => mention.pattern),
	]);
	if (patterns.length > 0) {
		const where = (pattern: string): string[] =>
			(
				answers.mentions.find(mention => mention.pattern === pattern) ??
				detected.find(mention => mention.pattern === pattern)
			)?.files ?? [];
		add({
			id: 'mentions',
			title: 'Which version pins in the docs should a release move?',
			found: list(
				patterns.map(pattern => `${pattern} is in ${list(where(pattern))}`),
			),
			kind: 'ticks',
			options: patterns.map(pattern => ({
				value: pattern,
				label: pattern,
				...(detected.some(mention => mention.pattern === pattern)
					? {recommended: true}
					: {}),
			})),
		});
	}

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
			found: [
				foundSentence(detection, answers).replace(/\.$/, ''),
				mixedNote(layout),
			]
				.filter(Boolean)
				.join('; '),
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
	asked.push(...releaseQuestions(detection, answers));
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
		.map(app => unitNameOf(app.path));
	add({
		id: 'units',
		title: `Which ${word}s get their own versions?`,
		found: `Found ${list(candidates.map(app => unitNameOf(app.path)))}${tools.length > 0 ? `; ${list(tools)} look like tests or tools` : ''}`,
		kind: 'ticks',
		options: unique([
			...candidates.map(app => app.path),
			...answers.units.map(unit => unit.path),
		]).map(path => ({
			value: path,
			label: `${unitNameOf(path)} (${path})${frameworkSuffix(layout, path)}`,
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
				`${count(tags.inherited.tags.length, 'tag looks like it', 'tags look like they')} came from ${baseName(detection, answers).prose}, such as ${list(tags.inherited.examples)}`,
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
		const suggested = baseName(detection).name;
		add(
			{
				id: 'upstream.name',
				title: 'What should sync lines call the base you started from?',
				found: upstreamFound(detection, answers),
				kind: 'text',
				options: [{value: suggested, label: suggested, recommended: true}],
			},
			upstream.remote !== null,
		);
		const chosen = answers.upstream?.authors ?? [];
		const emails = unique([
			...upstream.authors.map(author => author.email),
			...chosen,
		]);
		if (emails.length > 0) {
			const {prose} = baseName(detection, answers);
			add({
				id: 'upstream.authors',
				title: `Whose commits are always ${prose}'s?`,
				found:
					upstream.authors.length > 0
						? `${list(upstream.authors.map(author => `${author.email} wrote ${count(author.commits, 'commit', 'commits')}`))} here, and none of your recent ones`
						: `No author wrote only ${prose}'s commits`,
				kind: 'ticks',
				options: emails.map(email => {
					const author = upstream.authors.find(each => each.email === email);
					return {
						value: email,
						label: author ? `${author.name} <${email}>` : email,
						...(author ? {recommended: true} : {}),
					};
				}),
			});
		}
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
		// A repo that is one SDF project shows as that, not as a bare package.
		const root = layout.sdf.find(project => project.path === '');
		if (root) {
			const detail = [root.applicationId, root.version]
				.filter(Boolean)
				.join(' ');
			return `Found a single ${sdfFramework(root).name}${detail ? ` (${detail})` : ''}; it keeps one version, as today.`;
		}

		return 'Found a single package; it keeps one version, as today.';
	}

	const libraries = answers.shape === 'libraries';
	const candidates = (libraries ? layout.libraries : layout.apps).map(
		each => each.path,
	);
	const unitPaths = answers.units.map(unit => unit.path);
	const names = [
		...answers.units.map(unit => sdfLabel(layout, unit.name, unit.path)),
		...candidates
			.filter(path => !unitPaths.includes(path))
			.map(path => sdfLabel(layout, unitNameOf(path), path)),
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

/** For a mixed repo, the published packages that stay internal until mixed comes; else ''. */
function mixedNote(layout: LayoutDetection): string {
	if (layout.kind !== 'mixed') return '';
	const names = layout.libraries.map(pkg => pkg.name);
	const one = names.length === 1;
	return `${list(names)} ${one ? 'is' : 'are'} published but ${one ? 'stays' : 'stay'} internal for now, as a mixed setup that versions ${one ? 'it' : 'them'} is still to come`;
}

/**
 * 'commits by a count as Makerkit's', naming the answer's template authors,
 * the most prolific first: two by name, more as 'a and 2 others'. '' when
 * there are none.
 */
function authorsClause(detection: Detection, answers: SetupAnswers): string {
	const emails = answers.upstream?.authors ?? [];
	if (emails.length === 0) return '';
	const commits = (email: string) =>
		detection.upstream.authors.find(author => author.email === email)
			?.commits ?? 0;
	const named = [...emails].sort(
		(a, b) => commits(b) - commits(a) || (a < b ? -1 : a > b ? 1 : 0),
	);
	const who =
		named.length > 2
			? `${named[0]} and ${named.length - 1} others`
			: list(named);
	return `commits by ${who} count as ${baseName(detection, answers).prose}'s`;
}

/** "Releases happen on merge to main. 2 packages publish to npm after their checks pass." */
function releasesSentence(detection: Detection, answers: SetupAnswers): string {
	const when =
		effectiveTrigger(answers) === 'merge'
			? `Releases happen on merge to ${detection.branch}.`
			: 'Releases happen when someone runs them.';
	if (!answers.publish) return when;
	const n =
		answers.publish.packages.length > 0
			? answers.publish.packages.length
			: detection.publishable.length;
	const check = answers.publish.check !== null;
	return `${when} ${
		n === 1
			? `1 package publishes to npm${check ? ' after its check passes' : ''}.`
			: `${n} packages publish to npm${check ? ' after their checks pass' : ''}.`
	}`;
}

/** The first-screen paragraph: what setup found and what it will do. */
export function summary(detection: Detection, answers: SetupAnswers): string {
	const {tags, upstream} = detection;
	const base = baseName(detection, answers);
	const sentences = [foundSentence(detection, answers)];
	const mixed = mixedNote(detection.layout);
	if (mixed) sentences.push(`${mixed}.`);
	if (answers.shape !== 'single') {
		const word = answers.shape === 'libraries' ? 'package' : 'app';
		const grouped = answers.fixed.flat();
		const own = answers.units
			.map(unit => unit.name)
			.filter(name => !grouped.includes(name));
		const left = answers.exclude.map(unitNameOf);
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
		const authors = authorsClause(detection, answers);
		if (ignored > 0) {
			sentences.push(
				`${count(ignored, 'tag looks like it', 'tags look like they')} came from ${base.prose} and will be ignored${authors ? `, and ${authors}` : ''}.`,
			);
		} else if (authors) {
			sentences.push(`${authors.charAt(0).toUpperCase()}${authors.slice(1)}.`);
		}

		sentences.push(
			answers.sharedChanges === 'ride-along'
				? `Shared changes ride along with each ${word}'s own releases.`
				: `A shared change releases every ${word} that uses it.`,
		);
	}

	sentences.push(releasesSentence(detection, answers));
	for (const unit of answers.units) {
		const {facts, formats} = factsOf(detection, unit);
		if (formats?.manifestDisagrees && formats.last && facts?.version) {
			const {file = `${unit.path}/package.json`, hasPackage} = versionSource(
				detection,
				unit,
			);
			const files =
				hasPackage && facts.sdf?.version
					? 'sets both files to'
					: 'sets the file to';
			sentences.push(
				`${unit.name}'s last tag says ${formats.last.version} but ${file} says ${facts.version}; the tag wins, and the release ${files} the new version.`,
			);
		}
	}

	const squashed = upstream.squashedSyncs.length;
	if (squashed > 0) {
		// "Makerkit syncs", or "template syncs" for the fallback.
		const kind = base.name;
		sentences.push(
			squashed === 1
				? `1 commit looks like a squash-merged ${kind} sync; it counts as an ordinary commit.`
				: `${squashed} commits look like squash-merged ${kind} syncs; they count as ordinary commits.`,
		);
	}

	return sentences.join(' ');
}
