// Checks docs/site, the pages chamoji.dev/docs is built from: every nav link
// has a page, every page is in the nav and has its metadata, and the copy
// keeps to the house style. chamoji.dev compiles each page as MDX, which is
// code, so each page is also parsed and may only use the site's components,
// literal attribute values and heading annotations. `pnpm check` runs it; it
// prints each problem and exits 1 when there is one.
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import remarkMdx from 'remark-mdx';
import remarkParse from 'remark-parse';
import {unified} from 'unified';

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

/** The components the docs site gives MDX pages. */
const COMPONENTS = [
	'Note',
	'Properties',
	'Property',
	'Steps',
	'Step',
	'CodeGroup',
	'Row',
	'Col',
	'Guides',
	'Guide',
	'Resources',
	'Resource',
	'Tag',
	'Button',
	'p',
];

/** The keys a heading annotation, `## Title {{ icon: 'flag' }}`, may set. */
const ANNOTATION_KEYS = [
	'tag',
	'variant',
	'label',
	'icon',
	'badge',
	'anchor',
	'className',
];

/** The Tag tints. */
const TAG_VARIANTS = ['changes', 'mono', 'ci', 'setup'];

/**
 * The icon names the docs site has: the keys of ICONS in chamoji-web's
 * packages/brand/src/icons.ts, names only. Keep the two in step.
 */
const ICON_NAMES = new Set([
	'terminal',
	'sliders',
	'shield',
	'sparkle',
	'calendar',
	'changelog',
	'notes',
	'review',
	'file',
	'rocket-launch',
	'terminal-window',
	'book-open-text',
	'brackets-curly',
	'list-numbers',
	'brackets-angle',
	'flag',
	'stack',
	'sign-out',
	'play-circle',
	'notebook',
	'file-code',
	'git-commit',
	'tag',
	'cloud-arrow-up',
	'github-logo',
	'copy',
	'check-circle',
	'robot',
	'magnifying-glass',
	'package',
	'tree-structure',
	'file-md',
	'sun',
	'moon',
	'info',
	'x-logo',
	'gear',
	'play',
	'pause',
	'arrow-counter-clockwise',
	'git-merge',
	'folder',
	'arrow-right',
	'arrow-left',
	'hash',
	'pencil-simple',
]);

const parser = unified().use(remarkParse).use(remarkMdx);

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

/** A literal's value, or undefined when `node` is anything else (a negative number counts). */
function literalValue(node) {
	if (node?.type === 'Literal' && node.regex === undefined) {
		return {value: node.value};
	}

	if (
		node?.type === 'UnaryExpression' &&
		node.operator === '-' &&
		typeof node.argument?.value === 'number'
	) {
		return {value: -node.argument.value};
	}

	return undefined;
}

/** The single expression in an MDX expression's estree, or undefined. */
function expressionOf(node) {
	const body = node.data?.estree?.body ?? [];
	return body.length === 1 && body[0].type === 'ExpressionStatement'
		? body[0].expression
		: undefined;
}

function propertyName(property) {
	if (property.type !== 'Property' || property.computed) return undefined;
	return property.key.type === 'Identifier'
		? property.key.name
		: String(property.key.value);
}

const sourceOf = (text, node) =>
	typeof node?.start === 'number' ? text.slice(node.start, node.end) : '…';

/** Problems with a page's ESM: no imports, and only one `export const metadata = {title, description}`. */
function esmProblems(page, text, node, state) {
	const problems = [];
	for (const statement of node.data?.estree?.body ?? []) {
		const line = statement.loc?.start.line ?? node.position.start.line;
		if (statement.type === 'ImportDeclaration') {
			problems.push(
				`${page}:${line} has an import. Pages are compiled as code on chamoji.dev, so they may only export metadata.`,
			);
			continue;
		}

		const declaration = statement.declaration;
		const declarator =
			statement.type === 'ExportNamedDeclaration' &&
			declaration?.type === 'VariableDeclaration' &&
			declaration.kind === 'const' &&
			declaration.declarations.length === 1
				? declaration.declarations[0]
				: undefined;
		if (
			declarator?.id.type !== 'Identifier' ||
			declarator.id.name !== 'metadata' ||
			declarator.init?.type !== 'ObjectExpression'
		) {
			problems.push(
				`${page}:${line} exports something other than \`export const metadata = {title, description}\`.`,
			);
			continue;
		}

		if (state.metadata) {
			problems.push(
				`${page}:${line} exports metadata a second time; a page has one \`export const metadata\`.`,
			);
			continue;
		}

		state.metadata = true;
		for (const property of declarator.init.properties) {
			const key = propertyName(property);
			if (key === 'title' || key === 'description') {
				if (typeof literalValue(property.value)?.value !== 'string') {
					problems.push(
						`${page}:${line} metadata ${key} must be a string literal.`,
					);
				}
			} else {
				problems.push(
					`${page}:${line} metadata has ${key ?? sourceOf(text, property)}, but only title and description belong there.`,
				);
			}
		}
	}

	return problems;
}

/** Problems with a heading annotation: known keys, literal values, real icons and Tag variants. */
function annotationProblems(page, text, line, object) {
	const problems = [];
	for (const property of object.properties) {
		const key = propertyName(property);
		if (!key || !ANNOTATION_KEYS.includes(key)) {
			problems.push(
				`${page}:${line} annotates a heading with ${key ?? sourceOf(text, property)}; the keys are ${ANNOTATION_KEYS.slice(0, -1).join(', ')} and ${ANNOTATION_KEYS.at(-1)}.`,
			);
			continue;
		}

		const literal = literalValue(property.value);
		if (!literal) {
			problems.push(
				`${page}:${line} annotates a heading with ${key}: ${sourceOf(text, property.value)}; annotation values must be strings, numbers or booleans.`,
			);
			continue;
		}

		problems.push(...valueProblems(page, line, key, literal.value));
	}

	return problems;
}

/** An unknown icon name, or an unknown Tag variant. */
function valueProblems(page, line, key, value) {
	if (key === 'icon' && !ICON_NAMES.has(value)) {
		return [
			`${page}:${line} uses the icon "${value}", which the docs site does not have.`,
		];
	}

	if (key === 'variant' && !TAG_VARIANTS.includes(value)) {
		return [
			`${page}:${line} uses the Tag variant "${value}"; the variants are ${TAG_VARIANTS.slice(0, -1).join(', ')} and ${TAG_VARIANTS.at(-1)}.`,
		];
	}

	return [];
}

/** Problems with a JSX element: an allowed component, with literal attribute values. */
function elementProblems(page, node) {
	const line = node.position.start.line;
	const name = node.name ?? '';
	if (!COMPONENTS.includes(name)) {
		return [
			`${page}:${line} uses <${name}>, which the docs site does not provide. Use one of ${COMPONENTS.join(', ')}.`,
		];
	}

	const problems = [];
	for (const attribute of node.attributes) {
		const at = attribute.position?.start.line ?? line;
		if (attribute.type === 'mdxJsxExpressionAttribute') {
			problems.push(
				`${page}:${at} spreads {${attribute.value}} into <${name}>; attribute values must be strings, numbers or booleans.`,
			);
			continue;
		}

		let value = attribute.value ?? true;
		if (typeof attribute.value === 'object' && attribute.value !== null) {
			const literal = literalValue(expressionOf(attribute.value));
			if (!literal) {
				problems.push(
					`${page}:${at} gives <${name}> ${attribute.name}={${attribute.value.value}}; attribute values must be strings, numbers or booleans.`,
				);
				continue;
			}

			value = literal.value;
		}

		if (attribute.name === 'icon') {
			problems.push(...valueProblems(page, at, 'icon', value));
		} else if (attribute.name === 'variant' && name === 'Tag') {
			problems.push(...valueProblems(page, at, 'variant', value));
		}
	}

	return problems;
}

/** Parses a page as MDX and lists what it uses beyond the docs site's allowed set. */
function mdxProblems(page, text) {
	let tree;
	try {
		tree = parser.parse(text);
	} catch (error) {
		const where = error.line
			? `:${error.line}${error.column ? `:${error.column}` : ''}`
			: '';
		return [
			`${page}${where} isn't valid MDX: ${error.reason ?? error.message}`,
		];
	}

	const problems = [];
	const state = {metadata: false};
	const walk = (node, parent) => {
		const line = node.position?.start.line;
		switch (node.type) {
			case 'mdxjsEsm': {
				problems.push(...esmProblems(page, text, node, state));
				break;
			}

			case 'mdxJsxFlowElement':
			case 'mdxJsxTextElement': {
				problems.push(...elementProblems(page, node));
				break;
			}

			case 'mdxFlowExpression':
			case 'mdxTextExpression': {
				const expression = expressionOf(node);
				if (
					node.type === 'mdxTextExpression' &&
					parent?.type === 'heading' &&
					expression?.type === 'ObjectExpression'
				) {
					problems.push(...annotationProblems(page, text, line, expression));
				} else {
					problems.push(
						`${page}:${line} has the expression {${node.value}}. Pages are compiled as code, so the only \`{…}\` allowed is a heading annotation such as {{ icon: 'flag' }}.`,
					);
				}

				break;
			}

			default:
		}

		for (const child of node.children ?? []) walk(child, node);
	};

	walk(tree);
	return problems;
}

/** What is wrong with nav.json's shape, as one sentence each. */
function navShapeProblems(navigation) {
	if (!Array.isArray(navigation)) return ['it is not a list'];
	const problems = [];
	for (const [index, group] of navigation.entries()) {
		const name = `group ${index + 1}`;
		if (typeof group?.title !== 'string') {
			problems.push(`${name} has no title`);
			continue;
		}

		if (!Array.isArray(group.links)) {
			problems.push(`${name} (${group.title}) has no list of links`);
			continue;
		}

		for (const [position, link] of group.links.entries()) {
			const where = `link ${position + 1} of ${name} (${group.title})`;
			if (typeof link?.title !== 'string') {
				problems.push(`${where} has no title`);
			} else if (typeof link.href !== 'string') {
				problems.push(`${where} has no href`);
			} else if (!link.href.startsWith('/')) {
				problems.push(`${where} has the href ${JSON.stringify(link.href)}`);
			}
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

	const shape = navShapeProblems(navigation);
	if (shape.length > 0) {
		return shape.map(
			problem =>
				`nav.json must be a list of groups, each {title, links: [{title, href}]} with string values and hrefs that start with /: ${problem}.`,
		);
	}

	const links = navigation.flatMap(group => group.links);
	const pages = files.filter(file => file.endsWith('.mdx'));
	const routes = new Map(pages.map(page => [routeOf(page), page]));
	const linked = new Set(links.map(link => link.href));

	const problems = [];
	const titlesByHref = new Map();
	for (const link of links) {
		titlesByHref.set(link.href, [
			...(titlesByHref.get(link.href) ?? []),
			link.title,
		]);
	}

	for (const [href, titles] of titlesByHref) {
		if (titles.length > 1) {
			problems.push(
				`nav.json lists ${href} ${titles.length === 2 ? 'twice' : `${titles.length} times`} (${titles.join(', ')}); each page goes in the nav once.`,
			);
		}
	}

	const reserved = routes.get('/changelog');
	if (reserved) {
		problems.push(
			`${reserved} is reserved: chamoji.dev/docs builds /changelog from CHANGELOG.md. Rename the page.`,
		);
	}

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
		if (file.endsWith('.mdx')) {
			problems.push(...missingMetadata(file, text), ...mdxProblems(file, text));
		}

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
