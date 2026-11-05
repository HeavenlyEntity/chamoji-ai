// Checks docs/site, the pages chamoji.dev/docs is built from: every nav link
// has a page, every page is in the nav and has its metadata, and the copy
// keeps to the house style. `pnpm check` runs it; it prints each problem and
// exits 1 when there is one.
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

/** Marketing words the docs never use. A word matches with any ending. */
const BANNED_WORDS = [
	'powerful',
	'seamless',
	'blazing',
	'robust',
	'revolutionary',
	'next-generation',
	'game-changing',
];

/** Names that never appear in the docs, as a word or inside one. */
const BANNED_NAMES = ['gearz', 'makerkit'];

const bannedWord = new RegExp(
	`(?<![\\w-])(?:${BANNED_WORDS.join('|')})[\\w-]*`,
	'gi',
);
const bannedName = new RegExp(BANNED_NAMES.join('|'), 'gi');

/** Every file under `root`, '/'-separated and sorted. */
function listFiles(root, relative = '') {
	const files = [];
	for (const entry of readdirSync(path.join(root, relative), {
		withFileTypes: true,
	})) {
		const next = relative ? `${relative}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			files.push(...listFiles(root, next));
		} else {
			files.push(next);
		}
	}

	return files.sort();
}

/** The docs URL an .mdx file is served at, relative to /docs, as nav.json writes it. */
function routeOf(page) {
	const route = page.slice(0, -'.mdx'.length);
	if (route === 'index') return '/';
	return `/${route.endsWith('/index') ? route.slice(0, -'/index'.length) : route}`;
}

/** The text of `export const metadata = {…}`, or undefined when there is none. */
function metadataOf(text) {
	const start = /^export const metadata\s*=\s*\{/m.exec(text);
	if (!start) return undefined;
	let depth = 0;
	for (
		let index = start.index + start[0].length - 1;
		index < text.length;
		index++
	) {
		if (text[index] === '{') depth++;
		if (text[index] === '}' && --depth === 0) {
			return text.slice(start.index, index + 1);
		}
	}

	return undefined;
}

function missingMetadata(page, text) {
	const metadata = metadataOf(text) ?? '';
	const missing = ['title', 'description'].filter(
		key => !new RegExp(`(?:^|[{,\\s])${key}\\s*:`).test(metadata),
	);
	if (missing.length === 0) return [];
	return [
		`${page} has no metadata ${missing.join(' or ')}: start the page with export const metadata = {title, description}.`,
	];
}

function copyProblems(file, text) {
	const problems = [];
	for (const [index, line] of text.split('\n').entries()) {
		for (const [word] of line.matchAll(bannedWord)) {
			problems.push(
				`${file}:${index + 1} says "${word}"; say what it does instead.`,
			);
		}

		for (const [name] of line.matchAll(bannedName)) {
			problems.push(
				`${file}:${index + 1} names "${name}"; call it the template you started from.`,
			);
		}
	}

	return problems;
}

/**
 * The problems with the docs site in `dir` (docs/site), as plain sentences:
 * nav links with no page, pages missing from the nav, pages without a
 * metadata title and description, marketing words, and names that never
 * appear in the docs. An empty list means the site is sound.
 */
export function checkDocsSite(dir) {
	if (!existsSync(dir)) return [`There is no folder at ${dir}.`];
	const files = listFiles(dir);
	if (!files.includes('nav.json')) {
		return [`There is no nav.json in ${dir}.`];
	}

	let navigation;
	try {
		navigation = JSON.parse(readFileSync(path.join(dir, 'nav.json'), 'utf8'));
	} catch (error) {
		return [`nav.json isn't valid JSON: ${error.message}`];
	}

	const links = Array.isArray(navigation)
		? navigation.flatMap(group =>
				Array.isArray(group?.links) ? group.links : [],
			)
		: [];
	const pages = files.filter(file => file.endsWith('.mdx'));
	const routes = new Map(pages.map(page => [routeOf(page), page]));
	const linked = new Set(links.map(link => link?.href));

	const problems = [];
	for (const link of links) {
		if (!routes.has(link?.href)) {
			const page =
				link?.href === '/' ? 'index.mdx' : `${String(link?.href).slice(1)}.mdx`;
			problems.push(
				`nav.json links to ${link?.href} (${link?.title}), but there is no ${page}.`,
			);
		}
	}

	for (const [route, page] of routes) {
		if (!linked.has(route)) {
			problems.push(`${page} (${route}) is not in nav.json.`);
		}
	}

	for (const file of files) {
		const text = readFileSync(path.join(dir, file), 'utf8');
		if (file.endsWith('.mdx')) problems.push(...missingMetadata(file, text));
		problems.push(...copyProblems(file, text));
	}

	return problems;
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const dir = process.argv[2] ?? 'docs/site';
	const problems = checkDocsSite(dir);
	if (problems.length > 0) {
		console.error(
			`${problems.length} ${problems.length === 1 ? 'problem' : 'problems'} in ${dir}:`,
		);
		for (const problem of problems) console.error(`- ${problem}`);
		process.exit(1);
	}
}
