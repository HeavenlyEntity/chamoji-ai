import {listTags, runGit, runGitWithInput} from '../git.js';
import {escapeRegExp} from '../units/tags.js';
import type {ReleaseSettings} from '../units/settings.js';
import {FIELD, lines, readUpstream, VERSION_LIKE} from '../units/upstream.js';
import {recentAuthors} from './tags.js';

/** Someone who wrote template history; `commits` counts theirs on HEAD. */
export type TemplateAuthor = {email: string; name: string; commits: number};

export type UpstreamDetection = {
	/** 'upstream' if present; else another non-origin remote whose fetched refs share history with HEAD. */
	remote: string | null;
	/** The remote has fetched refs. */
	fetched: boolean;
	/** Suggested base name. */
	name: string | null;
	/** Full hash of the oldest own commit. */
	since: string | null;
	/** Commits on HEAD in the engine's upstream set. */
	upstreamCommits: number;
	/** Merges that bring upstream commits in. */
	syncs: number;
	/** Short hashes of commits that look like squashed syncs. */
	squashedSyncs: string[];
	/**
	 * Template authors for upstream.authors, by email (lower-cased, sorted):
	 * see `templateAuthors`. None when the remote looks like the team's
	 * canonical repo.
	 */
	authors: TemplateAuthor[];
};

const EMPTY: UpstreamDetection = {
	remote: null,
	fetched: false,
	name: null,
	since: null,
	upstreamCommits: 0,
	syncs: 0,
	squashedSyncs: [],
	authors: [],
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

/**
 * Who wrote the upstream set (the remote's commits and those the inherited
 * tags reach), isn't a recent own author (the author rule's window, with what
 * the remote reaches left out of it too), and, with a remote, wrote a commit
 * on HEAD that the remote doesn't reach.
 *
 * That last part keeps a canonical repo's team out: in a fork workflow the
 * remote reaches every teammate's commit, while a template's author shows up
 * outside it only through history the template has since dropped (a pruned
 * step branch), which is what upstream.authors is for. A template whose
 * history the remote still holds needs no authors; the remote and the
 * inherited tags already mark it.
 */
async function templateAuthors(
	root: string,
	remote: string | null,
	refs: string[],
	inheritedTags: string[],
): Promise<TemplateAuthor[]> {
	const onHead = (await listTags(root, 'HEAD'))
		.map(tag => tag.name)
		.filter(name => VERSION_LIKE.test(name));
	// Recent own work: what the remote reaches, a sync just merged, isn't.
	const recent = await recentAuthors(root, onHead, refs);
	const names = new Set(recent.map(author => author.name));
	const emails = new Set(recent.map(author => author.email));
	const out = await runGitWithInput(
		[
			'log',
			'--format=%an%x1f%ae',
			...(remote ? [`--glob=refs/remotes/${remote}/*`] : []),
			'--stdin',
		],
		root,
		inheritedTags.map(tag => `refs/tags/${tag}\n`).join(''),
	);
	const found = new Map<string, string>();
	for (const line of lines(out)) {
		const [name = '', email = ''] = line.split(FIELD);
		const key = email.toLowerCase();
		if (!key || names.has(name) || emails.has(key) || found.has(key)) continue;
		found.set(key, name);
	}

	if (remote) {
		const outside = new Set(
			lines(
				await runGitWithInput(
					['log', '--format=%ae', '--stdin'],
					root,
					['HEAD', '--not', ...refs].map(rev => `${rev}\n`).join(''),
				),
			).map(email => email.toLowerCase()),
		);
		for (const email of found.keys()) {
			if (!outside.has(email)) found.delete(email);
		}
	}

	if (found.size === 0) return [];
	const counts = new Map<string, number>();
	for (const email of lines(
		await runGit(['log', '--format=%ae', 'HEAD'], root),
	)) {
		const key = email.toLowerCase();
		if (found.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
	}

	return [...found]
		.map(([email, name]) => ({email, name, commits: counts.get(email) ?? 0}))
		.sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
}

const exactPattern = (tag: string): string => `^${escapeRegExp(tag)}$`;

/**
 * The upstream history setup finds. `canonical` is the tag detection's
 * canonical-repo verdict (`TagDetection.canonical`); when it holds, no
 * template author is proposed.
 */
export async function detectUpstream(
	root: string,
	remote: string | null,
	inheritedTags: string[],
	{canonical = false}: {canonical?: boolean} = {},
): Promise<UpstreamDetection> {
	if (remote === null && inheritedTags.length === 0) return {...EMPTY};

	const name = remote ? baseName(await remoteUrl(root, remote)) : null;
	const refs = remote
		? lines(
				await runGit(
					['for-each-ref', '--format=%(objectname)', `refs/remotes/${remote}`],
					root,
				),
			)
		: [];
	if (remote && refs.length === 0) return {...EMPTY, remote, name};

	const authors = canonical
		? []
		: await templateAuthors(root, remote, refs, inheritedTags);
	// The engine's own upstream set and idea of a sync: the remote, the
	// inherited tags and the template's authors.
	const settings: ReleaseSettings = {
		schema: 1,
		shape: 'apps',
		units: [],
		exclude: [],
		sharedChanges: 'ride-along',
		rootFiles: 'none',
		fixed: [],
		upstream: {
			...(remote ? {remote} : {}),
			name: name ?? remote ?? 'template',
			...(authors.length > 0
				? {authors: authors.map(author => author.email)}
				: {}),
		},
		tags: {ignore: inheritedTags.map(exactPattern), aliases: {}},
		rootChangelog: false,
		githubReleases: 'per-unit',
	};
	const {commits, syncs} = await readUpstream(
		root,
		'HEAD',
		settings,
		inheritedTags.map(tag => ({name: tag, date: ''})),
	);

	// Everything the remote and the inherited tags reach goes on the --not
	// side; commits by the template's authors are taken out after.
	const own = lines(
		await runGitWithInput(
			['rev-list', '--reverse', '--topo-order', '--stdin'],
			root,
			[
				'HEAD',
				'--not',
				...refs,
				...inheritedTags.map(tag => `refs/tags/${tag}`),
			]
				.map(rev => `${rev}\n`)
				.join(''),
		),
	).filter(hash => !commits.has(hash));
	const total = Number(
		(await runGit(['rev-list', '--count', 'HEAD'], root)).trim(),
	);

	const since = own[0] ?? null;
	const pattern = new RegExp(
		String.raw`\b(merge|sync|update|pull)\b.*\b(upstream|template${name ? `|${escapeRegExp(name)}` : ''})\b`,
		'i',
	);
	const ownSet = new Set(own);
	const candidates = lines(
		await runGit(
			['log', '--no-merges', `--format=%H${FIELD}%h${FIELD}%s`, 'HEAD'],
			root,
		),
	);
	const squashedSyncs = candidates
		.map(line => line.split(FIELD) as [string, string, string])
		.filter(
			([hash, , subject]) =>
				ownSet.has(hash) && hash !== since && pattern.test(subject),
		)
		.map(([, short]) => short);

	return {
		remote,
		fetched: remote !== null,
		name,
		since,
		upstreamCommits: total - own.length,
		syncs: syncs.length,
		squashedSyncs,
		authors,
	};
}
