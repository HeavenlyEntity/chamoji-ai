import {runGit} from './git.js';

export type StagedFile = {
	path: string;
	status: 'added' | 'modified' | 'deleted' | 'renamed';
	added: number;
	deleted: number;
};

export type StagedChanges = {
	files: StagedFile[];
	/** Staged files left out because their paths may hold secrets or are lockfiles. */
	withheld: number;
	/** The staged diff of the files above, only with `sendDiffs`. */
	diff?: string;
};

const LOCKFILES = new Set([
	'package-lock.json',
	'pnpm-lock.yaml',
	'yarn.lock',
	'bun.lockb',
	'Cargo.lock',
	'poetry.lock',
	'composer.lock',
	'Gemfile.lock',
]);

/** File names that hold credentials, matched in any case. */
const SECRET_NAME =
	/^(?:\.env(?:\..+)?|\.envrc|\.npmrc|\.netrc|\.pgpass|\.git-credentials|credentials(?:\..+)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?)$|\.(?:pem|key|p12|pfx|p8|jks|keystore|ppk|asc|tfvars|tfstate)$/i;

/** Paths that are never sent anywhere, not even by name. */
export function isWithheld(file: string): boolean {
	const name = file.split('/').pop() ?? file;
	return SECRET_NAME.test(name) || /secret/i.test(file) || LOCKFILES.has(name);
}

/**
 * Credential-shaped strings, replaced in diff text even in files that pass
 * the path checks: private-key blocks, and AWS, GitHub, Slack, npm and
 * Stripe-style tokens.
 */
const SECRET_TEXT = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
	/\b(?:AKIA|ASIA)[A-Z\d]{16}\b/g,
	/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z\d]{30,}\b/g,
	/\bgithub_pat_\w{30,}\b/g,
	/\bxox[abprs]-[\w-]{10,}\b/g,
	/\bnpm_[A-Za-z\d]{30,}\b/g,
	/\b(?:sk|rk)_(?:live|test)_[A-Za-z\d]{16,}\b/g,
];

function redactSecrets(text: string): string {
	return SECRET_TEXT.reduce(
		(redacted, pattern) => redacted.replaceAll(pattern, '<redacted>'),
		text,
	);
}

const LINES_PER_FILE = 200;
const LINES_IN_ALL = 2000;
const STATUS: Record<string, StagedFile['status']> = {
	A: 'added',
	M: 'modified',
	D: 'deleted',
	R: 'renamed',
};

/**
 * What is staged for the next commit: each file's path, status and line
 * counts, and the diff text only when `sendDiffs` is on. Withheld paths are
 * dropped before anything else sees them.
 */
export async function readStagedChanges(
	cwd: string,
	options: {sendDiffs?: boolean} = {},
): Promise<StagedChanges> {
	const nameStatus = await runGit(
		['diff', '--cached', '--name-status', '-M', '-z'],
		cwd,
	);
	const numstat = await runGit(
		['diff', '--cached', '--numstat', '-M', '-z'],
		cwd,
	);
	const counts = parseNumstat(numstat);
	const files: StagedFile[] = [];
	let withheld = 0;
	const parts = nameStatus.split('\0').filter(Boolean);
	for (let i = 0; i < parts.length; i++) {
		const code = parts[i]!;
		const renamed = code.startsWith('R') || code.startsWith('C');
		// A rename or copy is withheld if either name is, so `.env` renamed to
		// notes.txt can't carry its content out.
		const source = renamed ? parts[++i]! : undefined;
		const file = parts[++i]!;
		if (isWithheld(file) || (source !== undefined && isWithheld(source))) {
			withheld++;
			continue;
		}

		const [added, deleted] = counts.get(file) ?? [0, 0];
		files.push({
			path: file,
			status: STATUS[code[0]!] ?? 'modified',
			added,
			deleted,
		});
	}

	if (!options.sendDiffs || files.length === 0) {
		return {files, withheld};
	}

	const chunks: string[] = [];
	let budget = LINES_IN_ALL;
	for (const file of files) {
		if (budget <= 0) break;
		// :(literal) keeps a name like `*` from matching other files.
		const lines = redactSecrets(
			await runGit(
				['diff', '--cached', '-M', '-U2', '--', `:(literal)${file.path}`],
				cwd,
			),
		)
			.trimEnd()
			.split('\n');
		const keep = Math.min(lines.length, LINES_PER_FILE, budget);
		chunks.push(
			lines.slice(0, keep).join('\n') +
				(keep < lines.length ? `\n… ${lines.length - keep} lines cut` : ''),
		);
		budget -= keep;
	}

	return {files, withheld, diff: chunks.join('\n')};
}

/** Added and deleted line counts per path; binary files count as 0. */
function parseNumstat(output: string): Map<string, [number, number]> {
	const counts = new Map<string, [number, number]>();
	const parts = output.split('\0');
	for (let i = 0; i < parts.length; i++) {
		const [added, deleted, file] = parts[i]!.split('\t');
		if (added === undefined || deleted === undefined) continue;
		// A rename's line has an empty path, and the new path comes two parts on.
		const target = file === '' ? parts[(i += 2)] : file;
		if (target) {
			counts.set(target, [Number(added) || 0, Number(deleted) || 0]);
		}
	}

	return counts;
}
