import {existsSync} from 'node:fs';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {
	applyUnitReleases,
	committedSection,
	discardPublishPlan,
	planUnitReleases,
	pushUnitReleases,
	readWorkspace,
	render,
	resolveUnits,
	runGit,
	stripTitle,
	uniqueTags,
	unitChangelog,
	unitTagHistory,
	type ChamojiConfig,
	type CommitClassifier,
	type OutputFormat,
	type PublishOutcome,
	type ReadyUnitPlan,
	type UnitPending,
	type UnitPlan,
} from '@chamoji/core';
import {runStep} from '../face.js';
import {stripControlLines} from '../text.js';
import {NO_RELEASE_NEEDED, type CommandContext} from './context.js';
import {
	announceHeld,
	checkRelease,
	DEFERRED,
	defersGithubRelease,
	githubReleaseStep,
	heldFacts,
	holdMajors,
	planned,
	planningStep,
	printResult,
	publishAfterPush,
	publishedLines,
	pushStep,
	syncAfterRelease,
	uncheckRelease,
	wouldPublish,
} from './release-steps.js';

const MONOREPO_HINT =
	'chamoji: this looks like a monorepo with several apps; run chamoji setup to version each one';

/** Whether `release`, `next-version` and `changelog` work per unit: a release section whose shape isn't single. */
export function releasesUnits(config: ChamojiConfig): boolean {
	return config.release !== undefined && config.release.shape !== 'single';
}

/** `web  0.1.0 → 0.2.0  minor  3 own, 1 shared` */
function unitLine(unit: UnitPlan): string {
	return `${unit.unit}  ${unit.from ?? 'none'} → ${unit.version}  ${unit.bump}  ${unit.own} own, ${unit.shared} shared`;
}

/**
 * What a unit that isn't releasing has waiting: its own commits that need no
 * release, and the shared ones that ride along with its next one.
 */
function pendingLine({unit, own, shared}: UnitPending): string {
	const ownPart =
		own === 0
			? 'no changes of its own'
			: `no release needed (${own === 1 ? "1 change of its own doesn't" : `${own} changes of its own don't`} need one)`;
	if (shared === 0) return `${unit}: ${ownPart}`;
	const sharedPart =
		shared === 1 ? '1 shared change rides' : `${shared} shared changes ride`;
	return `${unit}: ${ownPart}; ${sharedPart} along with its next release`;
}

/** A unit `--unit` left out, which may well need a release of its own. */
function leftOutLine({unit, own, shared}: UnitPending): string {
	const parts = [
		...(own === 0
			? []
			: [own === 1 ? '1 change of its own' : `${own} changes of its own`]),
		...(shared === 0 ? [] : [`${shared} shared waiting`]),
	];
	return `${unit}: left out by --unit (${parts.join(', ')})`;
}

function tagList(plan: ReadyUnitPlan): string {
	return uniqueTags(plan.units).join(', ');
}

/** A unit's notes heading: its tag, with the unit's name when fixed-group members share the tag. */
function unitHeading(
	units: Array<{unit: string; tag: string}>,
	unit: {unit: string; tag: string},
): string {
	return units.filter(other => other.tag === unit.tag).length > 1
		? `${unit.tag} (${unit.unit})`
		: unit.tag;
}

/** The release notes for one tag: its unit's notes, or a section per unit that shares it. */
function tagNotes(
	units: Array<{unit: string; tag: string; notes: string}>,
): string {
	return units.length === 1
		? units[0]!.notes
		: units
				.map(unit => `## ${unitHeading(units, unit)}\n\n${unit.notes}`)
				.join('\n\n');
}

/** One GitHub release per tag (fixed-group members can share one), or one for the whole release commit under `combined`. */
function githubReleases(
	plan: ReadyUnitPlan,
	config: ChamojiConfig,
): Array<{tag: string; title: string; notes: string; prerelease: boolean}> {
	if (config.release?.githubReleases === 'combined') {
		return [
			{
				tag: plan.units[0]!.tag,
				title: tagList(plan),
				notes: plan.units
					.map(unit => `## ${unitHeading(plan.units, unit)}\n\n${unit.notes}`)
					.join('\n\n'),
				prerelease: plan.units.some(unit => unit.bump === 'prerelease'),
			},
		];
	}

	return uniqueTags(plan.units).map(tag => {
		const members = plan.units.filter(unit => unit.tag === tag);
		return {
			tag,
			title: tag,
			notes: tagNotes(members),
			prerelease: members.some(unit => unit.bump === 'prerelease'),
		};
	});
}

/**
 * `release` in a repo with release units: one release commit, a tag per
 * unit, and a GitHub release per tag (or one for all of them) on --push.
 */
export async function releaseUnits(
	ctx: CommandContext,
	config: ChamojiConfig,
	version: string | undefined,
	classify: CommitClassifier | undefined,
): Promise<number> {
	const {io, flags} = ctx;
	const only = flags.unit;
	if (version !== undefined && only.length !== 1) {
		throw new Error(
			'give --unit with a version, for example: chamoji release 2.0.0 --unit mobile',
		);
	}

	const plan = await planningStep(
		ctx,
		async options =>
			planUnitReleases({
				cwd: io.cwd,
				config,
				...(only.length > 0 ? {units: only} : {}),
				...(version === undefined ? {} : {versions: {[only[0]!]: version}}),
				...holdMajors(ctx, config),
				classify,
				...options,
			}),
		result => (result.status === 'nothing' ? undefined : tagList(result)),
	);

	const waiting = plan.pending.map(line =>
		only.length > 0 && !only.includes(line.unit)
			? leftOutLine(line)
			: pendingLine(line),
	);
	announceHeld(ctx, plan.held);
	if (plan.status === 'nothing') {
		printResult(
			ctx,
			[
				'Nothing to release: no unit has a commit of its own that implies a version bump.',
				...waiting,
			],
			{status: 'nothing', pending: plan.pending, ...heldFacts(plan.held)},
		);
		return NO_RELEASE_NEEDED;
	}

	const tags = uniqueTags(plan.units);
	const files = plan.changes.map(change => change.file);
	const units = plan.units.map(unit => unitLine(unit));
	const notices = [
		...plan.warnings.map(warning => `warning: ${warning}`),
		...plan.units.flatMap(unit =>
			unit.disagreed.map(
				file =>
					`note: ${file} had a version other than ${unit.from} (${unit.lastTag ?? 'its package.json version'}); it now says ${unit.version}`,
			),
		),
		...(plan.excludedNote ? plan.excludedNote.split('\n') : []),
	];
	const notes = plan.units.flatMap(unit => [
		'',
		`## ${unitHeading(plan.units, unit)}`,
		'',
		unit.notes,
	]);
	const unitFacts = {
		units: plan.units,
		files,
		warnings: plan.warnings,
		pending: plan.pending,
		...heldFacts(plan.held),
	};
	const checked = flags.publish
		? await checkRelease(
				ctx,
				plan,
				config,
				new Map(plan.units.map(unit => [unit.tag, unit.version])),
			)
		: undefined;
	if (flags.dryRun) {
		const would = wouldPublish(ctx, checked);
		printResult(
			ctx,
			[
				'Would release:',
				...units,
				`files: ${files.join(', ')}`,
				...notices,
				...waiting,
				...notes,
				...would.lines,
			],
			{status: 'dry-run', ...unitFacts, ...would.json},
		);
		return 0;
	}

	let commit: string;
	try {
		({commit} = await applyUnitReleases(plan, {trailers: flags.trailer}));
	} catch (error) {
		await uncheckRelease(checked);
		throw error;
	}

	const listed = tagList(plan);
	let pushed = `no; to ship: git push origin HEAD ${tags.join(' ')}`;
	let pushError: string | undefined;
	let publishError: string | undefined;
	let published: PublishOutcome[] = [];
	let githubRelease: boolean | 'deferred' = false;
	let memory: string | undefined;
	if (flags.push || flags.publish) {
		try {
			await pushStep(ctx, plan.root, tags, async env =>
				pushUnitReleases(plan, env),
			);
			pushed = `yes (HEAD and ${listed})`;
			memory = await syncAfterRelease(ctx);
			if (checked) {
				({outcomes: published, error: publishError} = await publishAfterPush(
					ctx,
					checked,
				));
			}

			const failed: string[] = [];
			const releases =
				publishError || defersGithubRelease(ctx, config)
					? []
					: githubReleases(plan, config);
			for (const item of releases) {
				const named = releases.length === 1 ? '' : ` for ${item.tag}`;
				const settled = await githubReleaseStep(ctx, {
					root: plan.root,
					...item,
					...(releases.length === 1 ? {} : {forTag: item.tag}),
				});
				// The push is done: a release that fails before gh answers (the
				// notes file can't be written) is one not created, not a failed push.
				const result = settled.ok
					? settled.value
					: {ok: false, message: (settled.error as Error).message};
				if (!result.ok) {
					failed.push(
						`GitHub release not created${named}: ${stripControlLines(result.message)}`,
					);
				}
			}

			if (publishError) {
				pushed += published.some(outcome => outcome.status === 'failed')
					? '; no GitHub release, since the publish failed'
					: "; no GitHub release, since a package isn't on npm";
			} else if (defersGithubRelease(ctx, config)) {
				githubRelease = 'deferred';
				pushed += `; ${DEFERRED}`;
			} else {
				githubRelease = failed.length === 0;
				pushed += githubRelease
					? `; GitHub release${releases.length === 1 ? '' : 's'} created`
					: `; ${failed.join('; ')}`;
			}
		} catch (error) {
			pushError = stripControlLines((error as Error).message);
			pushed = `failed: ${pushError}`;
		} finally {
			// A push that failed leaves the tarballs; runPublish removed them otherwise.
			if (checked) await discardPublishPlan(checked.plan);
		}
	}

	if (publishError) io.stderr(`chamoji: ${publishError}\n`);
	printResult(
		ctx,
		[
			`Released ${listed}.`,
			...units,
			`files: ${files.join(', ')}`,
			`commit: ${commit} ${plan.subject}`,
			`tags: ${listed} (annotated)`,
			`pushed: ${pushed}`,
			...(checked && pushed.startsWith('yes') ? publishedLines(published) : []),
			...(memory === undefined ? [] : [`memory: ${memory}`]),
			...notices,
			...waiting,
			...(pushed.startsWith('yes')
				? []
				: [
						`undo before pushing: git tag -d ${tags.join(' ')} && git reset --hard ${plan.start.slice(0, 7)}`,
					]),
			...notes,
		],
		{
			status: 'released',
			...unitFacts,
			commit,
			pushed: pushed.startsWith('yes'),
			githubRelease,
			...(checked ? {published} : {}),
			...(pushError || publishError ? {error: pushError ?? publishError} : {}),
			...(memory === undefined ? {} : {memory}),
		},
	);
	return pushError || publishError ? 1 : 0;
}

/** `next-version` in a repo with release units: one line per unit. */
export async function nextVersions(
	ctx: CommandContext,
	config: ChamojiConfig,
	classify: CommitClassifier | undefined,
): Promise<number> {
	const {io, flags, face, jevHost} = ctx;
	// Like next-version without units, this reads; it checks no branch or tree.
	const plan = await runStep(
		face,
		'Working out the next versions',
		async step => {
			jevHost.step = step;
			try {
				return await planUnitReleases({
					cwd: io.cwd,
					config,
					...(flags.unit.length > 0 ? {units: flags.unit} : {}),
					anyBranch: true,
					allowDirty: true,
					fetch: false,
					today: io.today,
					classify,
				});
			} finally {
				jevHost.step = undefined;
			}
		},
		result =>
			planned(
				ctx,
				result.status === 'nothing'
					? undefined
					: `Next: ${result.units.map(unit => `${unit.unit} ${unit.version}`).join(', ')}`,
			),
	);
	const releasing = plan.status === 'ready' ? plan.units : [];
	const names =
		flags.unit.length > 0
			? flags.unit
			: config.release!.units.map(unit => unit.name);
	const units = names.map(name => {
		const found = releasing.find(unit => unit.unit === name);
		if (found) {
			const {unit, version, own, shared} = found;
			return {unit, version, own, shared};
		}

		const waiting = plan.pending.find(item => item.unit === name);
		return {
			unit: name,
			version: null,
			own: waiting?.own ?? 0,
			shared: waiting?.shared ?? 0,
		};
	});
	io.stdout(
		flags.json
			? `${JSON.stringify({units}, null, 2)}\n`
			: `${units
					.map(unit =>
						unit.version === null
							? unit.own + unit.shared > 0
								? pendingLine(unit)
								: `${unit.unit}: nothing to release`
							: `${unit.unit}: ${unit.version}`,
					)
					.join('\n')}\n`,
	);
	return units.some(unit => unit.version !== null) ? 0 : NO_RELEASE_NEEDED;
}

/** `changelog --unit` and `--for-tag`, in a repo with release units. */
export async function changelogUnits(
	ctx: CommandContext,
	config: ChamojiConfig,
	format: OutputFormat,
	classify: CommitClassifier | undefined,
): Promise<number> {
	const {io, flags, froms} = ctx;
	const {forTag} = flags;
	if (flags.unit.length === 0 && forTag === undefined) {
		throw new Error(
			`this repo releases units (${config.release!.units.map(unit => unit.name).join(', ')}); pass --unit <name> or --for-tag <tag>`,
		);
	}

	if (flags.unit.length > 0 && forTag !== undefined) {
		throw new Error('pass --unit or --for-tag, not both');
	}

	if (flags.unit.length > 1) {
		throw new Error('changelog takes one --unit');
	}

	if (
		froms.length > 0 ||
		flags.release !== undefined ||
		flags.since !== undefined ||
		flags.to !== 'HEAD'
	) {
		throw new Error(
			"--from, --to, --release and --since don't work with --unit or --for-tag",
		);
	}

	const write = async (output: string) => {
		if (flags.output) {
			await writeFile(path.resolve(io.cwd, flags.output), output);
			io.stderr(`Wrote ${flags.output}\n`);
		} else {
			io.stdout(output);
		}
	};

	const rebuilt = async (unit: string) => {
		const changelog = await unitChangelog({
			cwd: io.cwd,
			config,
			unit,
			...(classify ? {classify} : {}),
		});
		if (forTag === undefined) return changelog;
		const releases = changelog.releases.filter(
			release => release.tag === forTag,
		);
		if (releases.length === 0) {
			throw new Error(
				`${forTag} isn't one of ${unit}'s releases on this branch`,
			);
		}

		return {...changelog, releases};
	};

	if (forTag === undefined) {
		await write(render(await rebuilt(flags.unit[0]!), format));
		return 0;
	}

	const owners = await ownersOf(forTag);
	if (format !== 'markdown') {
		const parts = [];
		for (const {unit} of owners) parts.push(await rebuilt(unit));
		await write(
			render(
				{...parts[0]!, releases: parts.flatMap(part => part.releases)},
				format,
			),
		);
		return 0;
	}

	// What the release committed, so lines only the release wrote are kept.
	const sections = [];
	for (const owner of owners) {
		const notes =
			(await committedSection(
				owner.root,
				forTag,
				owner.changelog,
				owner.version,
			)) ?? stripTitle(render(await rebuilt(owner.unit), 'markdown'));
		sections.push({unit: owner.unit, tag: forTag, notes});
	}

	await write(`${tagNotes(sections)}\n`);
	return 0;

	/**
	 * The units released under the tag, as their tag histories read it: the
	 * first that reads it, with the other members of its fixed group that
	 * share it.
	 */
	async function ownersOf(tag: string) {
		const settings = config.release!;
		const root = (
			await runGit(['rev-parse', '--show-toplevel'], io.cwd)
		).trim();
		const reading = resolveUnits(settings, await readWorkspace(root)).flatMap(
			item => {
				const [read] = unitTagHistory([{name: tag, date: ''}], item, settings);
				return read
					? [
							{
								unit: item.name,
								changelog: item.changelog,
								version: read.version,
								root,
							},
						]
					: [];
			},
		);
		const first = reading[0];
		if (!first) throw new Error(`no unit's tag format matches ${tag}`);
		const group = settings.fixed.find(members => members.includes(first.unit));
		return group ? reading.filter(item => group.includes(item.unit)) : [first];
	}
}

/** The unit flags only mean something with release units. */
export function refuseUnitFlags(ctx: CommandContext): void {
	const {flags} = ctx;
	if (flags.unit.length > 0 || flags.forTag !== undefined) {
		throw new Error(
			'--unit and --for-tag need release units; add them under release.units in chamoji.config.json',
		);
	}
}

/**
 * Says once per clone, on stderr, that setup can version each app, in a
 * repo with no release section and two or more packages under apps/. Never
 * under --json or in CI, and never in the way of the command.
 */
export async function monorepoHint(
	ctx: CommandContext,
	config: ChamojiConfig,
): Promise<void> {
	const {io, flags} = ctx;
	if (config.release !== undefined || flags.json) return;
	if ((io.env ?? process.env)['CI']) return;
	try {
		const gitDir = (
			await runGit(['rev-parse', '--absolute-git-dir'], io.cwd)
		).trim();
		const marker = path.join(gitDir, 'chamoji', 'monorepo-hint');
		if (existsSync(marker)) return;
		const root = (
			await runGit(['rev-parse', '--show-toplevel'], io.cwd)
		).trim();
		const apps = (await readWorkspace(root)).filter(pkg =>
			/^apps\/[^/]+$/.test(pkg.path),
		);
		if (apps.length < 2) return;
		await mkdir(path.dirname(marker), {recursive: true});
		await writeFile(marker, '');
		io.stderr(`${MONOREPO_HINT}\n`);
	} catch {
		// A hint is never worth failing a release over.
	}
}
