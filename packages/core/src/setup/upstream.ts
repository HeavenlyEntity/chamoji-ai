import {runGit, runGitWithInput} from '../git.js';
import {escapeRegExp} from '../units/tags.js';
import type {ReleaseSettings} from '../units/settings.js';
import {FIELD, lines, readUpstream} from '../units/upstream.js';

export type UpstreamDetection = {
	/** 'upstream' if present; else another non-origin remote whose fetched refs share history with HEAD. */
	remote: string | null;
	/** The remote has fetched refs. */
	fetched: boolean;
	/** Suggested base name. */
	name: string | null;
	/** Full hash of the oldest own commit. */
	since: string | null;
	/** Reachable from HEAD and the remote. */
	upstreamCommits: number;
	/** Merges that bring upstream commits in. */
	syncs: number;
	/** Short hashes of commits that look like squashed syncs. */
	squashedSyncs: string[];
};

const EMPTY: UpstreamDetection = {
	remote: null,
	fetched: false,
	name: null,
	since: null,
	upstreamCommits: 0,
	syncs: 0,
	squashedSyncs: [],
};

const titleCase = (text: string): string =>
	text
		.split(/[-_.\s]+/)
		.filter(Boolean)
		.map(word => word.charAt(0).toUpperCase() + word.slice(1))
		.join(' ');

/**
 * The owner of a remote URL, title-cased, else its repo name. Local paths read
 * like URLs: the owner is the parent folder (ruling R1).
 * https://github.com/makerkit/kit.git, git@github.com:makerkit/kit.git and
 * /work/makerkit/kit all give "Makerkit".
 */
function baseName(url: string): string | null {
	const path = url
		.trim()
		.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*\/?/i, '')
		.replace(/^[^@/\\]+@[^:/\\]+:/, '')
		.replace(/\.git$/i, '');
	const segments = path.split(/[/\\]+/).filter(Boolean);
	const pick = segments.at(-2) ?? segments.at(-1);
	return pick ? titleCase(pick) || null : null;
}

async function remoteUrl(root: string, remote: string): Promise<string> {
	try {
		return (await runGit(['remote', 'get-url', remote], root)).trim();
	} catch {
		return '';
	}
}

/** The oldest commit, in topo order, that none of the tags reaches. */
async function oldestBeyondTags(
	root: string,
	tags: string[],
): Promise<string | null> {
	const out = await runGitWithInput(
		['rev-list', '--reverse', '--topo-order', '--stdin'],
		root,
		`HEAD\n--not\n${tags.map(tag => `refs/tags/${tag}`).join('\n')}\n`,
	);
	return lines(out)[0] ?? null;
}

export async function detectUpstream(
	root: string,
	remote: string | null,
	inheritedTags: string[],
): Promise<UpstreamDetection> {
	if (remote === null) {
		if (inheritedTags.length === 0) return {...EMPTY};
		return {...EMPTY, since: await oldestBeyondTags(root, inheritedTags)};
	}

	const name = baseName(await remoteUrl(root, remote));
	const refs = lines(
		await runGit(
			['for-each-ref', '--format=%(objectname)', `refs/remotes/${remote}`],
			root,
		),
	);
	if (refs.length === 0) return {...EMPTY, remote, name};

	const own = lines(
		await runGit(
			[
				'rev-list',
				'--reverse',
				'--topo-order',
				'HEAD',
				'--not',
				`--remotes=${remote}`,
			],
			root,
		),
	);
	const total = Number(
		(await runGit(['rev-list', '--count', 'HEAD'], root)).trim(),
	);

	// Reuse the engine's own idea of a sync.
	const settings: ReleaseSettings = {
		schema: 1,
		shape: 'apps',
		units: [],
		exclude: [],
		sharedChanges: 'ride-along',
		rootFiles: 'none',
		fixed: [],
		upstream: {remote, name: name ?? remote},
		tags: {ignore: [], aliases: {}},
		rootChangelog: false,
		githubReleases: 'per-unit',
	};
	const {syncs} = await readUpstream(root, 'HEAD', settings, []);

	const since = own[0] ?? null;
	const pattern = new RegExp(
		String.raw`\b(merge|sync|update|pull)\b.*\b(upstream|template${name ? `|${escapeRegExp(name)}` : ''})\b`,
		'i',
	);
	const candidates = lines(
		await runGit(
			[
				'log',
				'--no-merges',
				`--format=%H${FIELD}%h${FIELD}%s`,
				'HEAD',
				'--not',
				`--remotes=${remote}`,
			],
			root,
		),
	);
	const squashedSyncs = candidates
		.map(line => line.split(FIELD) as [string, string, string])
		.filter(([hash, , subject]) => hash !== since && pattern.test(subject))
		.map(([, short]) => short);

	return {
		remote,
		fetched: true,
		name,
		since,
		upstreamCommits: total - own.length,
		syncs: syncs.length,
		squashedSyncs,
	};
}
