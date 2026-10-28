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

export type ParsedCommit = Omit<RawCommit, 'trailers'> & {
	/** Gitmoji code without colons, e.g. `sparkles`. */
	gitmoji: string | null;
	/** Conventional Commits type, e.g. `feat`. */
	type: string | null;
	scope: string | null;
	/** Subject with the type, scope and gitmoji removed. */
	description: string;
	breaking: boolean;
	trailers: Trailer[];
};

export type GroupConfigItem = {
	group: string;
	label: string;
	/** Gitmoji codes without colons. */
	emojis: string[];
	/** Hidden groups are matched but left out of the output. */
	hidden?: boolean;
};

export type GroupConfig = GroupConfigItem[];

export type ChamojiConfig = {
	groups: GroupConfig;
	repositoryUrl?: string;
};

export type Group = {
	group: string;
	label: string;
	commits: ParsedCommit[];
};

export type Release = {
	/** Tag name, the `--release` version, or `Unreleased`. */
	version: string;
	tag: string | null;
	previousTag: string | null;
	/** `YYYY-MM-DD`, or null for an undated Unreleased section. */
	date: string | null;
	bump: SemverBump | null;
	nextVersion: string | null;
	groups: Group[];
};

export type Changelog = {
	repositoryUrl?: string;
	releases: Release[];
};
