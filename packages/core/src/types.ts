import type {Workstream} from './workstreams.js';
import type {ReleaseSettings} from './units/settings.js';

export type SemverBump = 'major' | 'minor' | 'patch';

/** One commit as read from `git log`, before any interpretation. */
export type RawCommit = {
	hash: string;
	shortHash: string;
	authorName: string;
	authorEmail: string;
	/** ISO 8601 author date. */
	date: string;
	subject: string;
	body: string;
	/** Raw `%(trailers:only,unfold)` output: one `Key: value` per line. */
	trailers: string;
};

export type Trailer = {key: string; value: string};

/**
 * What a commit says about its own intent, from `Why:`, `Constraint:`,
 * `Gotcha:` and `Follow-up:` lines, in the order they were written.
 */
export type IntentCard = {
	why: string[];
	constraint: string[];
	gotcha: string[];
	followUp: string[];
};

/**
 * Where a commit's gitmoji came from: written in the message, implied by a
 * Conventional type, guessed from the wording, or picked by an AI classifier.
 */
export type GitmojiSource = 'gitmoji' | 'type' | 'rule' | 'ai' | null;

export type ParsedCommit = Omit<RawCommit, 'trailers'> & {
	/** Gitmoji code without colons, e.g. `sparkles`. */
	gitmoji: string | null;
	gitmojiSource: GitmojiSource;
	/** Conventional Commits type, e.g. `feat`. */
	type: string | null;
	scope: string | null;
	/** Subject with the type, scope and gitmoji removed. */
	description: string;
	breaking: boolean;
	trailers: Trailer[];
	/** Slug from the `Workstream:` trailer. Absent when the commit has none. */
	workstream?: string;
	/** The commit's intent lines. Absent when it has none. */
	card?: IntentCard;
	/** For a commit shared with a unit: the internal package path it changed. */
	via?: string;
	/** Set on the one line a merge from the upstream remote becomes. */
	sync?: {base: string; to: string};
};

export type GroupConfigItem = {
	group: string;
	label: string;
	/** Gitmoji codes without colons. */
	emojis: string[];
	/** Hidden groups are matched but left out of the output. */
	hidden?: boolean;
	/** Render the group as one summary line (used for dependency updates). */
	collapse?: boolean;
};

export type GroupConfig = GroupConfigItem[];

export type ChamojiConfig = {
	groups: GroupConfig;
	repositoryUrl?: string;
	release?: ReleaseSettings;
};

export type Group = {
	group: string;
	label: string;
	collapse?: boolean;
	commits: ParsedCommit[];
};

/**
 * A shipped workstream in a release: its commits, folded out of the
 * release's own groups. `links` and the other fields come from the
 * workstreams file and are data, not markup.
 */
export type Highlight = Pick<
	Workstream,
	'slug' | 'title' | 'emoji' | 'description' | 'links'
> & {groups: Group[]};

export type Release = {
	/** Tag name, the `--release` version, or `Unreleased`. */
	version: string;
	/**
	 * The release's tag. For a `--release` section, the tag it will get
	 * (e.g. `v1.2.0`); null for an unnamed Unreleased section.
	 */
	tag: string | null;
	previousTag: string | null;
	/** `YYYY-MM-DD`, or null for an undated Unreleased section. */
	date: string | null;
	bump: SemverBump | null;
	nextVersion: string | null;
	/**
	 * Shipped workstreams in this release, newest work first. Absent when
	 * there are none. Their commits are not repeated in `groups`.
	 */
	highlights?: Highlight[];
	groups: Group[];
};

export type Changelog = {
	repositoryUrl?: string;
	releases: Release[];
};

/**
 * Picks gitmoji codes for commits chamoji could not sort. Returns a map from
 * commit hash to code, for the commits it is confident about.
 */
export type CommitClassifier = (
	commits: ParsedCommit[],
) => Promise<Map<string, string>>;
