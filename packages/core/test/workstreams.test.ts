import {
	mkdir,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {afterEach, expect, test} from 'vitest';
import {
	WORKSTREAMS_FILE,
	WorkstreamError,
	addWorkstream,
	getActive,
	isSlug,
	readWorkstreams,
	readWorkstreamsAt,
	setActive,
	setWorkstreamStatus,
	shouldStamp,
	slugify,
	stampWorkstream,
} from '../src/workstreams.js';
import {
	createRepo,
	gitOutput,
	type FixtureRepo,
} from './helpers/fixture-repo.js';

let repo: FixtureRepo | undefined;
afterEach(async () => {
	await repo?.cleanup();
	repo = undefined;
});

const fileIn = (dir: string) => path.join(dir, WORKSTREAMS_FILE);
const activeIn = (dir: string) => path.join(dir, '.git', 'chamoji', 'active');

async function writeWorkstreams(dir: string, text: string): Promise<void> {
	await mkdir(path.dirname(fileIn(dir)), {recursive: true});
	await writeFile(fileIn(dir), text);
}

async function writeActive(dir: string, text: string): Promise<void> {
	await mkdir(path.dirname(activeIn(dir)), {recursive: true});
	await writeFile(activeIn(dir), text);
}

test('slugify turns a title into a slug', () => {
	expect(slugify('Auth revamp!')).toBe('auth-revamp');
	expect(slugify('  Crème brûlée -- v2  ')).toBe('creme-brulee-v2');
});

test('slugify caps the slug at 64 characters without a trailing hyphen', () => {
	const slug = slugify(`${'a'.repeat(63)} b`);
	expect(slug).toBe('a'.repeat(63));
	expect(isSlug(slugify('word '.repeat(40)))).toBe(true);
});

test('slugify throws when nothing is left', () => {
	expect(() => slugify('🔐')).toThrow(WorkstreamError);
	expect(() => slugify('  ')).toThrow(WorkstreamError);
});

test('isSlug accepts lowercase words joined by single hyphens', () => {
	expect(isSlug('auth-revamp')).toBe(true);
	expect(isSlug('v2')).toBe(true);
	expect(isSlug('a'.repeat(64))).toBe(true);
	expect(isSlug('a'.repeat(65))).toBe(false);
	expect(isSlug('')).toBe(false);
	expect(isSlug('Auth')).toBe(false);
	expect(isSlug('-auth')).toBe(false);
	expect(isSlug('auth-')).toBe(false);
	expect(isSlug('auth--revamp')).toBe(false);
	expect(isSlug('bad\nslug')).toBe(false);
	expect(isSlug('bad\n')).toBe(false);
});

test('a missing or empty file reads as no workstreams', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	expect(await readWorkstreams(repo.dir)).toEqual([]);
	await writeWorkstreams(repo.dir, '');
	expect(await readWorkstreams(repo.dir)).toEqual([]);
	await writeWorkstreams(repo.dir, '# nothing yet\n');
	expect(await readWorkstreams(repo.dir)).toEqual([]);
});

test('addWorkstream writes the entry, stages it, and reads back', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	const added = await addWorkstream(repo.dir, {
		title: 'Auth revamp',
		emoji: '🔐',
		description: 'Sign-in, sessions and tokens',
	});
	expect(added).toEqual({
		slug: 'auth-revamp',
		title: 'Auth revamp',
		emoji: '🔐',
		description: 'Sign-in, sessions and tokens',
		status: 'active',
	});
	expect(await readWorkstreams(repo.dir)).toEqual([added]);
	expect(await gitOutput(repo.dir, ['diff', '--cached', '--name-only'])).toBe(
		`${WORKSTREAMS_FILE}\n`,
	);
});

test('addWorkstream keeps earlier entries and rejects a repeated slug', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await addWorkstream(repo.dir, {title: 'Auth revamp'});
	await addWorkstream(repo.dir, {title: 'Billing'});
	expect((await readWorkstreams(repo.dir)).map(item => item.slug)).toEqual([
		'auth-revamp',
		'billing',
	]);
	await expect(
		addWorkstream(repo.dir, {title: 'Auth Revamp!'}),
	).rejects.toThrow(WorkstreamError);
});

test('addWorkstream works from a subdirectory', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	const sub = path.join(repo.dir, 'packages', 'app');
	await mkdir(sub, {recursive: true});
	await addWorkstream(sub, {title: 'Billing'});
	await expect(readFile(fileIn(repo.dir), 'utf8')).resolves.toContain(
		'billing:',
	);
	expect((await readWorkstreams(sub)).map(item => item.slug)).toEqual([
		'billing',
	]);
});

test('addWorkstream cannot overwrite an entry that reads as invalid', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	const text =
		'workstreams:\n  billing:\n    title: Billing\n    status: wat\n';
	await writeWorkstreams(repo.dir, text);
	expect(await readWorkstreams(repo.dir)).toEqual([]);
	await expect(addWorkstream(repo.dir, {title: 'Billing'})).rejects.toThrow(
		WorkstreamError,
	);
	expect(await readFile(fileIn(repo.dir), 'utf8')).toBe(text);
});

test('entries with a bad slug, no title or a bad status are skipped', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await writeWorkstreams(
		repo.dir,
		[
			'workstreams:',
			'  good:',
			'    title: Good',
			'    status: shipped',
			'    links: [https://example.com/a, 3]',
			'  Bad_Slug:',
			'    title: Bad',
			'    status: active',
			'  no-title:',
			'    status: active',
			'  no-status:',
			'    title: No status',
			'  odd-status:',
			'    title: Odd',
			'    status: paused',
			'',
		].join('\n'),
	);
	expect(await readWorkstreams(repo.dir)).toEqual([
		{
			slug: 'good',
			title: 'Good',
			status: 'shipped',
			links: ['https://example.com/a'],
		},
	]);
});

test('setWorkstreamStatus changes the status, stages it, and keeps comments', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await writeWorkstreams(
		repo.dir,
		[
			'# Our workstreams',
			'workstreams:',
			'  auth-revamp:',
			'    title: Auth revamp # the big one',
			'    status: active',
			'',
		].join('\n'),
	);
	const updated = await setWorkstreamStatus(repo.dir, 'auth-revamp', 'shipped');
	expect(updated).toMatchObject({slug: 'auth-revamp', status: 'shipped'});
	const text = await readFile(fileIn(repo.dir), 'utf8');
	expect(text).toContain('# Our workstreams');
	expect(text).toContain('# the big one');
	expect(text).toContain('status: shipped');
	expect(await gitOutput(repo.dir, ['diff', '--cached', '--name-only'])).toBe(
		`${WORKSTREAMS_FILE}\n`,
	);
});

test('setWorkstreamStatus throws for an unknown slug', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await addWorkstream(repo.dir, {title: 'Billing'});
	await expect(
		setWorkstreamStatus(repo.dir, 'nope', 'dropped'),
	).rejects.toThrow(WorkstreamError);
});

test('a file with conflict markers makes writers refuse and change nothing', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	const text = [
		'workstreams:',
		'<<<<<<< HEAD',
		'  a:',
		'    title: A',
		'    status: active',
		'=======',
		'  b:',
		'    title: B',
		'    status: active',
		'>>>>>>> other',
		'',
	].join('\n');
	await writeWorkstreams(repo.dir, text);
	await expect(addWorkstream(repo.dir, {title: 'New one'})).rejects.toThrow(
		WorkstreamError,
	);
	await expect(setWorkstreamStatus(repo.dir, 'a', 'shipped')).rejects.toThrow(
		WorkstreamError,
	);
	await expect(readWorkstreams(repo.dir)).rejects.toThrow(WorkstreamError);
	expect(await readFile(fileIn(repo.dir), 'utf8')).toBe(text);
	expect(await gitOutput(repo.dir, ['diff', '--cached', '--name-only'])).toBe(
		'',
	);
});

test('a file that is not a mapping of workstreams is corrupt', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	for (const text of ['- a\n- b\n', 'workstreams: [a]\n', 'just words\n']) {
		await writeWorkstreams(repo.dir, text);
		await expect(readWorkstreams(repo.dir)).rejects.toThrow(WorkstreamError);
		await expect(addWorkstream(repo.dir, {title: 'New'})).rejects.toThrow(
			WorkstreamError,
		);
		expect(await readFile(fileIn(repo.dir), 'utf8')).toBe(text);
	}
});

test('addWorkstream fills a file whose workstreams key is empty', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await writeWorkstreams(repo.dir, '# todo\nworkstreams:\n');
	await addWorkstream(repo.dir, {title: 'Billing'});
	expect((await readWorkstreams(repo.dir)).map(item => item.slug)).toEqual([
		'billing',
	]);
	expect(await readFile(fileIn(repo.dir), 'utf8')).toContain('# todo');
});

test('readWorkstreamsAt reads the file as of a ref, not the working tree', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await addWorkstream(repo.dir, {title: 'Auth revamp'});
	await gitOutput(repo.dir, ['commit', '-q', '-m', '✨ Add a workstream']);
	await setWorkstreamStatus(repo.dir, 'auth-revamp', 'shipped');

	const atHead = await readWorkstreamsAt(repo.dir, 'HEAD');
	expect(atHead.map(item => item.status)).toEqual(['active']);
	const now = await readWorkstreams(repo.dir);
	expect(now.map(item => item.status)).toEqual(['shipped']);
});

test('readWorkstreamsAt is empty where the file is absent, and throws on a bad file', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	expect(await readWorkstreamsAt(repo.dir, 'HEAD')).toEqual([]);
	await writeWorkstreams(repo.dir, '<<<<<<< HEAD\nworkstreams: {\n');
	await gitOutput(repo.dir, ['add', '.']);
	await gitOutput(repo.dir, ['commit', '-q', '-m', '💥 Break it']);
	await expect(readWorkstreamsAt(repo.dir, 'HEAD')).rejects.toThrow(
		WorkstreamError,
	);
	await expect(readWorkstreamsAt(repo.dir, 'no-such-ref')).rejects.toThrow(
		/Unknown revision/,
	);
});

test('getActive is the slug while it is active in the working tree', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await addWorkstream(repo.dir, {title: 'Auth revamp'});
	expect(await getActive(repo.dir)).toBeNull();
	await setActive(repo.dir, 'auth-revamp');
	expect(await getActive(repo.dir)).toBe('auth-revamp');
	await expect(readFile(activeIn(repo.dir), 'utf8')).resolves.toBe(
		'auth-revamp\n',
	);
});

test('getActive is null for shipped, dropped, missing and malformed slugs', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await addWorkstream(repo.dir, {title: 'Auth revamp'});
	await addWorkstream(repo.dir, {title: 'Billing'});
	await setActive(repo.dir, 'auth-revamp');

	await setWorkstreamStatus(repo.dir, 'auth-revamp', 'shipped');
	expect(await getActive(repo.dir)).toBeNull();
	await setWorkstreamStatus(repo.dir, 'auth-revamp', 'dropped');
	expect(await getActive(repo.dir)).toBeNull();

	await writeActive(repo.dir, 'not-in-the-file\n');
	expect(await getActive(repo.dir)).toBeNull();
	await writeActive(repo.dir, 'billing\nauth-revamp\n');
	expect(await getActive(repo.dir)).toBeNull();
	await writeActive(repo.dir, 'bad\nslug');
	expect(await getActive(repo.dir)).toBeNull();
	await writeActive(repo.dir, '');
	expect(await getActive(repo.dir)).toBeNull();
});

test('setActive refuses a slug that is not a slug, and null clears it', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await addWorkstream(repo.dir, {title: 'Billing'});
	await expect(setActive(repo.dir, 'bad\nslug')).rejects.toThrow(
		WorkstreamError,
	);
	await setActive(repo.dir, 'billing');
	await setActive(repo.dir, null);
	expect(await getActive(repo.dir)).toBeNull();
	await setActive(repo.dir, null);
});

test('active state is per worktree', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await addWorkstream(repo.dir, {title: 'Billing'});
	await gitOutput(repo.dir, ['add', '.']);
	await gitOutput(repo.dir, ['commit', '-q', '-m', '✨ Add billing']);
	const other = `${repo.dir}-other`;
	await gitOutput(repo.dir, ['worktree', 'add', '-q', '-b', 'other', other]);
	try {
		await setActive(repo.dir, 'billing');
		expect(await getActive(repo.dir)).toBe('billing');
		expect(await getActive(other)).toBeNull();
	} finally {
		await gitOutput(repo.dir, ['worktree', 'remove', '--force', other]);
	}
});

test('shouldStamp is true for a plain commit and -m', () => {
	expect(shouldStamp({rebasing: false})).toBe(true);
	expect(shouldStamp({source: undefined, rebasing: false})).toBe(true);
	expect(shouldStamp({source: 'message', rebasing: false})).toBe(true);
});

test('shouldStamp is false for a template, merge, squash, commit and while rebasing', () => {
	expect(shouldStamp({source: 'template', rebasing: false})).toBe(false);
	expect(shouldStamp({source: 'merge', rebasing: false})).toBe(false);
	expect(shouldStamp({source: 'squash', rebasing: false})).toBe(false);
	expect(shouldStamp({source: 'commit', rebasing: false})).toBe(false);
	expect(shouldStamp({rebasing: true})).toBe(false);
	expect(shouldStamp({source: 'message', rebasing: true})).toBe(false);
});

const comments = [
	'',
	'# Please enter the commit message for your changes. Lines starting',
	"# with '#' will be ignored, and an empty message aborts the commit.",
	'',
].join('\n');

test('stampWorkstream puts the trailer above the comment lines', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await addWorkstream(repo.dir, {title: 'Auth revamp'});
	await setActive(repo.dir, 'auth-revamp');
	const message = path.join(repo.dir, 'MSG');
	await writeFile(message, `✨ Add sign-in\n${comments}`);

	expect(await stampWorkstream(repo.dir, message)).toBe('auth-revamp');
	const text = await readFile(message, 'utf8');
	expect(text.startsWith('✨ Add sign-in\n\nWorkstream: auth-revamp\n')).toBe(
		true,
	);
	expect(text.indexOf('Workstream:')).toBeLessThan(text.indexOf('# Please'));
});

test('stampWorkstream accepts a message file path relative to cwd', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await addWorkstream(repo.dir, {title: 'Auth revamp'});
	await setActive(repo.dir, 'auth-revamp');
	await writeFile(path.join(repo.dir, 'MSG'), '✨ Add sign-in\n');
	expect(await stampWorkstream(repo.dir, 'MSG')).toBe('auth-revamp');
	await expect(readFile(path.join(repo.dir, 'MSG'), 'utf8')).resolves.toContain(
		'Workstream: auth-revamp',
	);
});

test('stampWorkstream keeps an existing Workstream trailer', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await addWorkstream(repo.dir, {title: 'Auth revamp'});
	await addWorkstream(repo.dir, {title: 'Billing'});
	await setActive(repo.dir, 'auth-revamp');
	const message = path.join(repo.dir, 'MSG');
	const original = `✨ Add invoices\n\nWorkstream: billing\n${comments}`;
	await writeFile(message, original);

	expect(await stampWorkstream(repo.dir, message)).toBeNull();
	expect(await readFile(message, 'utf8')).toBe(original);
});

test('stamping twice changes nothing the second time', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await addWorkstream(repo.dir, {title: 'Auth revamp'});
	await setActive(repo.dir, 'auth-revamp');
	const message = path.join(repo.dir, 'MSG');
	await writeFile(message, '✨ Add sign-in\n');
	expect(await stampWorkstream(repo.dir, message)).toBe('auth-revamp');
	const once = await readFile(message, 'utf8');
	expect(await stampWorkstream(repo.dir, message)).toBeNull();
	expect(await readFile(message, 'utf8')).toBe(once);
});

test('stampWorkstream returns null and leaves the message with no active workstream', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await addWorkstream(repo.dir, {title: 'Auth revamp'});
	const message = path.join(repo.dir, 'MSG');
	const original = `✨ Add sign-in\n${comments}`;
	await writeFile(message, original);
	expect(await stampWorkstream(repo.dir, message)).toBeNull();
	expect(await readFile(message, 'utf8')).toBe(original);
});

test('a newline in the active file never reaches the message', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await addWorkstream(repo.dir, {title: 'Auth revamp'});
	await writeActive(repo.dir, 'auth-revamp\nSigned-off-by: x <x@y.z>\n');
	const message = path.join(repo.dir, 'MSG');
	await writeFile(message, '✨ Add sign-in\n');
	expect(await stampWorkstream(repo.dir, message)).toBeNull();
	expect(await readFile(message, 'utf8')).toBe('✨ Add sign-in\n');
});

// Nine levels of aliases that each double: parses cleanly, then `toJS` throws.
const BOMB = [
	'a: &a [x, x, x, x, x, x, x, x, x]',
	...'bcdefghi'
		.split('')
		.map(
			(name, index) =>
				`${name}: &${name} [${Array(9).fill(`*${'abcdefgh'[index]}`).join(', ')}]`,
		),
	'workstreams: *i',
	'',
].join('\n');

test('an alias bomb is refused as a WorkstreamError by readers and writers', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await writeWorkstreams(repo.dir, BOMB);
	await gitOutput(repo.dir, ['add', '.']);
	await gitOutput(repo.dir, ['commit', '-q', '-m', '💥 Bomb']);
	await expect(readWorkstreams(repo.dir)).rejects.toThrow(WorkstreamError);
	await expect(readWorkstreamsAt(repo.dir, 'HEAD')).rejects.toThrow(
		WorkstreamError,
	);
	await expect(addWorkstream(repo.dir, {title: 'New'})).rejects.toThrow(
		WorkstreamError,
	);
	await expect(setWorkstreamStatus(repo.dir, 'a', 'shipped')).rejects.toThrow(
		WorkstreamError,
	);
	expect(await readFile(fileIn(repo.dir), 'utf8')).toBe(BOMB);
});

test.skipIf(process.platform === 'win32')(
	'writers refuse a workstreams file that is a symlink, and leave its target alone',
	async () => {
		repo = await createRepo([{commit: '🎉 Init'}]);
		const target = `${repo.dir}.outside.yml`;
		const text = 'workstreams:\n  a:\n    title: A\n    status: active\n';
		await writeFile(target, text);
		await mkdir(path.dirname(fileIn(repo.dir)), {recursive: true});
		await symlink(target, fileIn(repo.dir));
		try {
			await expect(addWorkstream(repo.dir, {title: 'New'})).rejects.toThrow(
				WorkstreamError,
			);
			await expect(
				setWorkstreamStatus(repo.dir, 'a', 'shipped'),
			).rejects.toThrow(WorkstreamError);
			expect(await readFile(target, 'utf8')).toBe(text);
		} finally {
			await rm(target, {force: true});
		}
	},
);

test.skipIf(process.platform === 'win32')(
	'writers refuse a .chamoji directory that is a symlink, and leave its target alone',
	async () => {
		repo = await createRepo([{commit: '🎉 Init'}]);
		const outside = `${repo.dir}.outside`;
		await mkdir(outside);
		await symlink(outside, path.join(repo.dir, '.chamoji'));
		try {
			await expect(addWorkstream(repo.dir, {title: 'New'})).rejects.toThrow(
				WorkstreamError,
			);
			await expect(
				setWorkstreamStatus(repo.dir, 'new', 'shipped'),
			).rejects.toThrow(WorkstreamError);
			expect(await readdir(outside)).toEqual([]);
		} finally {
			await rm(outside, {recursive: true, force: true});
		}
	},
);

test('stampWorkstream leaves an empty message alone, so the commit still aborts', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await addWorkstream(repo.dir, {title: 'Auth revamp'});
	await setActive(repo.dir, 'auth-revamp');
	const message = path.join(repo.dir, 'MSG');
	for (const text of ['', '\n', comments, `\n${comments}`]) {
		await writeFile(message, text);
		expect(await stampWorkstream(repo.dir, message)).toBeNull();
		expect(await readFile(message, 'utf8')).toBe(text);
	}
});

test('stampWorkstream ignores the diff that git commit -v puts below the scissors', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await addWorkstream(repo.dir, {title: 'Auth revamp'});
	await setActive(repo.dir, 'auth-revamp');
	const message = path.join(repo.dir, 'MSG');
	const scissors = [
		'# ------------------------ >8 ------------------------',
		'# Do not modify or remove the line above.',
		'# Everything below it will be ignored.',
		'diff --git a/a.ts b/a.ts',
		'+export {};',
		'',
	].join('\n');

	const empty = `\n${comments}${scissors}`;
	await writeFile(message, empty);
	expect(await stampWorkstream(repo.dir, message)).toBeNull();
	expect(await readFile(message, 'utf8')).toBe(empty);

	await writeFile(message, `✨ Add sign-in\n${comments}${scissors}`);
	expect(await stampWorkstream(repo.dir, message)).toBe('auth-revamp');
	const text = await readFile(message, 'utf8');
	expect(text.startsWith('✨ Add sign-in\n\nWorkstream: auth-revamp\n')).toBe(
		true,
	);
	expect(text.indexOf('Workstream:')).toBeLessThan(text.indexOf('>8'));
});

test('stampWorkstream follows core.commentChar for what counts as a comment', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await gitOutput(repo.dir, ['config', 'core.commentChar', ';']);
	await addWorkstream(repo.dir, {title: 'Auth revamp'});
	await setActive(repo.dir, 'auth-revamp');
	const message = path.join(repo.dir, 'MSG');
	const empty = '\n; Please enter the commit message for your changes.\n;\n';
	await writeFile(message, empty);
	expect(await stampWorkstream(repo.dir, message)).toBeNull();
	expect(await readFile(message, 'utf8')).toBe(empty);

	// With ";" as the comment character, a "#" line is the message.
	await writeFile(message, '# Heading\n; a comment\n');
	expect(await stampWorkstream(repo.dir, message)).toBe('auth-revamp');
	expect(await readFile(message, 'utf8')).toContain('Workstream: auth-revamp');

	const scissors = `\n; ------------------------ >8 ------------------------\ndiff\n`;
	await writeFile(message, scissors);
	expect(await stampWorkstream(repo.dir, message)).toBeNull();
});

test('stampWorkstream treats a message of only sign-off lines as empty, as git does', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await addWorkstream(repo.dir, {title: 'Auth revamp'});
	await setActive(repo.dir, 'auth-revamp');
	const message = path.join(repo.dir, 'MSG');
	const signOff = 'Signed-off-by: T <t@t.t>';
	for (const text of [
		`\n\n${signOff}\n`,
		`\n\n${signOff}\n${signOff}\n${comments}`,
	]) {
		await writeFile(message, text);
		expect(await stampWorkstream(repo.dir, message)).toBeNull();
		expect(await readFile(message, 'utf8')).toBe(text);
	}

	// Something else in the message makes it a message again.
	await writeFile(message, `✨ Add sign-in\n\n${signOff}\n${comments}`);
	expect(await stampWorkstream(repo.dir, message)).toBe('auth-revamp');
	const text = await readFile(message, 'utf8');
	expect(text).toContain(`${signOff}\nWorkstream: auth-revamp\n`);
	expect(text.indexOf('Workstream:')).toBeLessThan(text.indexOf('# Please'));
});

test('setWorkstreamStatus keeps a long hand-written line as it was', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	const text = [
		'workstreams:',
		'  a:',
		'    title: A',
		`    description: ${'A long description written by hand that runs well past eighty columns. '.repeat(3).trim()}`,
		'    status: active',
		'',
	].join('\n');
	await writeWorkstreams(repo.dir, text);
	await setWorkstreamStatus(repo.dir, 'a', 'shipped');
	expect(await readFile(fileIn(repo.dir), 'utf8')).toBe(
		text.replace('status: active', 'status: shipped'),
	);
});

test('writers say so when .chamoji is git-ignored, and put the file back as it was', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await writeFile(path.join(repo.dir, '.gitignore'), '.chamoji/\n');
	await expect(addWorkstream(repo.dir, {title: 'New'})).rejects.toThrow(
		/workstreams\.yml is ignored by git \(\.gitignore:1:\.chamoji\/\)/,
	);
	await expect(readdir(path.join(repo.dir, '.chamoji'))).rejects.toThrow();

	// A file that was already there keeps its text.
	const text = 'workstreams:\n  a:\n    title: A\n    status: active\n';
	await writeWorkstreams(repo.dir, text);
	await expect(setWorkstreamStatus(repo.dir, 'a', 'shipped')).rejects.toThrow(
		WorkstreamError,
	);
	expect(await readFile(fileIn(repo.dir), 'utf8')).toBe(text);
});

test('stampWorkstream counts a comment-looking -m message as content, unless commit.cleanup=strip', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await addWorkstream(repo.dir, {title: 'Auth revamp'});
	await setActive(repo.dir, 'auth-revamp');
	const message = path.join(repo.dir, 'MSG');
	const text = '#123 fix the login\n';

	// An editor message with only comment lines is empty, so nothing happens.
	await writeFile(message, text);
	expect(await stampWorkstream(repo.dir, message)).toBeNull();
	expect(await readFile(message, 'utf8')).toBe(text);
	expect(await stampWorkstream(repo.dir, message, 'template')).toBeNull();

	// Git keeps "#" lines of a -m message under its default cleanup.
	expect(await stampWorkstream(repo.dir, message, 'message')).toBe(
		'auth-revamp',
	);
	expect(await readFile(message, 'utf8')).toContain('Workstream: auth-revamp');

	// With commit.cleanup=strip, git aborts on it, so the hook leaves it.
	await gitOutput(repo.dir, ['config', 'commit.cleanup', 'strip']);
	await writeFile(message, text);
	expect(await stampWorkstream(repo.dir, message, 'message')).toBeNull();
	expect(await readFile(message, 'utf8')).toBe(text);
});

test('stampWorkstream still treats empty, scissors and sign-off messages as empty for -m', async () => {
	repo = await createRepo([{commit: '🎉 Init'}]);
	await addWorkstream(repo.dir, {title: 'Auth revamp'});
	await setActive(repo.dir, 'auth-revamp');
	const message = path.join(repo.dir, 'MSG');
	for (const text of [
		'',
		'\n',
		'Signed-off-by: T <t@t.t>\n',
		'# ------------------------ >8 ------------------------\n# diff\n',
	]) {
		await writeFile(message, text);
		expect(await stampWorkstream(repo.dir, message, 'message')).toBeNull();
		expect(await readFile(message, 'utf8')).toBe(text);
	}
});
