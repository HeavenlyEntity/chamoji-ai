import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, expect, test} from 'vitest';
import {checkDocsSite} from './check-docs-site.mjs';

const folders: string[] = [];

afterEach(() => {
	for (const folder of folders.splice(0)) {
		rmSync(folder, {recursive: true, force: true});
	}
});

const page = (title: string, body = 'Plain words.') =>
	`export const metadata = {title: '${title}', description: 'About ${title}.'};\n\n# ${title}\n\n${body}\n`;

/** A docs folder with these files, by path from the folder. */
function site(files: Record<string, string>): string {
	const dir = mkdtempSync(path.join(tmpdir(), 'chamoji-docs-site-'));
	folders.push(dir);
	for (const [file, text] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(dir, file)), {recursive: true});
		writeFileSync(path.join(dir, file), text);
	}

	return dir;
}

const nav = (...hrefs: string[]) =>
	JSON.stringify([
		{title: 'Get started', links: hrefs.map(href => ({title: href, href}))},
	]);

test('a sound site has no problems', () => {
	const dir = site({
		'nav.json': nav('/', '/commands/release'),
		'index.mdx': page('Introduction'),
		'commands/release.mdx': page('release'),
	});
	expect(checkDocsSite(dir)).toEqual([]);
});

test('a nav link with no page', () => {
	const dir = site({
		'nav.json': nav('/', '/install'),
		'index.mdx': page('Introduction'),
	});
	expect(checkDocsSite(dir)).toEqual([
		'nav.json links to /install (/install), but there is no install.mdx.',
	]);
});

test('a page missing from the nav', () => {
	const dir = site({
		'nav.json': nav('/'),
		'index.mdx': page('Introduction'),
		'guides/monorepos.mdx': page('Monorepos'),
	});
	expect(checkDocsSite(dir)).toEqual([
		'guides/monorepos.mdx (/guides/monorepos) is not in nav.json.',
	]);
});

test('a page without a metadata title and description', () => {
	const dir = site({
		'nav.json': nav('/', '/install', '/quickstart'),
		'index.mdx': page('Introduction'),
		'install.mdx': "export const metadata = {title: 'Install'};\n\n# Install\n",
		'quickstart.mdx': '# Quickstart\n\nNo metadata at all.\n',
	});
	expect(checkDocsSite(dir)).toEqual([
		'install.mdx has no metadata description: start the page with export const metadata = {title, description}.',
		'quickstart.mdx has no metadata title or description: start the page with export const metadata = {title, description}.',
	]);
});

test('a banned word', () => {
	const dir = site({
		'nav.json': nav('/'),
		'index.mdx': page(
			'Introduction',
			'A Powerful tool.\n\nIt works seamlessly, and it is game-changing.',
		),
	});
	expect(checkDocsSite(dir)).toEqual([
		'index.mdx:5 says "Powerful"; say what it does instead.',
		'index.mdx:7 says "seamlessly"; say what it does instead.',
		'index.mdx:7 says "game-changing"; say what it does instead.',
	]);
});

test('the names gearz or Makerkit anywhere', () => {
	const dir = site({
		'nav.json': JSON.stringify([
			{title: 'Gearz', links: [{title: 'Introduction', href: '/'}]},
		]),
		'index.mdx': page(
			'Introduction',
			'Commits by dev@makerkit.example count as the template’s.',
		),
	});
	expect(checkDocsSite(dir)).toEqual([
		'index.mdx:5 names "makerkit"; call it the template you started from.',
		'nav.json:1 names "Gearz"; call it the template you started from.',
	]);
});

/** A one-page site whose index.mdx has `body` under its metadata and title. */
const onePage = (body: string) =>
	checkDocsSite(site({'nav.json': nav('/'), 'index.mdx': page('Home', body)}));

test('the components, attributes and heading annotations the docs use are fine', () => {
	expect(
		onePage(
			[
				'<p className="lead">Lead.</p>',
				'<Tag variant="changes">CHANGES YOUR REPO</Tag>',
				"## Flags {{ tag: 'X', variant: 'mono', label: 'release', icon: 'flag', badge: '9', anchor: false }}",
				'<Properties>\n\t<Property name="--dry-run" type="boolean" since="0.9.0">\n\t\tText.\n\t</Property>\n</Properties>',
				'<Steps>\n\t<Step title="One.">Text.</Step>\n</Steps>',
				'<Row>\n\t<Col sticky>\n\t\tText.\n\t</Col>\n</Row>',
				'<Guides>\n\t<Guide href="/x" name="X" description="Y" />\n</Guides>',
				'<Resources>\n\t<Resource href="/x" name="X" description="Y" icon="robot" />\n</Resources>',
				'<Button href="/x" arrow="right" count={3} wide={true}>Go</Button>',
				'<Note>Careful.</Note>',
				'<CodeGroup title="Install">\n\n```bash\nnpm i chamoji\n```\n\n</CodeGroup>',
				'Code like `{x}` and `<b>` is only text.',
				"```bash {{ title: 'Install' }}\nnpm i chamoji\n```",
				"```js{{ title: 'x.js', tag: 'GET', label: '/v1' }}\nx\n```",
				'```bash\ncurl -d \'{"a": {"b": 1}}\'\n```',
				'[Release](/commands/release), [the repo](https://github.com/HeavenlyEntity/chamoji-ai), [flags](#flags), [mail](mailto:hi@chamoji.dev) and [notes][notes].',
				'[notes]: ./guides/writing-commits',
			].join('\n\n'),
		),
	).toEqual([]);
});

test('MDX that does not parse', () => {
	expect(onePage('<Note>never closed')).toEqual([
		expect.stringMatching(/^index\.mdx:\d+(:\d+)? isn't valid MDX: /),
	]);
});

test('an import', () => {
	expect(onePage("import x from 'y'")).toEqual([
		'index.mdx:5 has an import. Pages are compiled as code on chamoji.dev, so they may only export metadata.',
	]);
});

test('ESM other than the metadata export', () => {
	expect(onePage('export const other = 1')).toEqual([
		'index.mdx:5 exports something other than `export const metadata = {title, description}`.',
	]);
});

test('a second metadata export', () => {
	expect(
		onePage("export const metadata = {title: 'B', description: 'C'}"),
	).toEqual([
		'index.mdx:5 exports metadata a second time; a page has one `export const metadata`.',
	]);
});

test('metadata whose title or description is not a string literal', () => {
	const dir = site({
		'nav.json': nav('/'),
		'index.mdx':
			"export const metadata = {title: `Home ${1}`, description: 'D', extra: 'E'};\n\n# Home\n",
	});
	expect(checkDocsSite(dir)).toEqual([
		'index.mdx:1 metadata title must be a string literal.',
		'index.mdx:1 metadata has extra, but only title and description belong there.',
	]);
});

test('a component outside the allowed list', () => {
	expect(onePage('<Script>x</Script>\n\nText with <span>html</span>.')).toEqual(
		[
			'index.mdx:5 uses <Script>, which the docs site does not provide. Use one of Note, Properties, Property, Steps, Step, CodeGroup, Row, Col, Guides, Guide, Resources, Resource, Tag, Button, p.',
			'index.mdx:7 uses <span>, which the docs site does not provide. Use one of Note, Properties, Property, Steps, Step, CodeGroup, Row, Col, Guides, Guide, Resources, Resource, Tag, Button, p.',
		],
	);
});

test('a fragment', () => {
	expect(onePage('<>x</>')).toEqual([
		'index.mdx:5 uses <>, which the docs site does not provide. Use one of Note, Properties, Property, Steps, Step, CodeGroup, Row, Col, Guides, Guide, Resources, Resource, Tag, Button, p.',
	]);
});

test('an attribute value that is an expression', () => {
	expect(
		onePage('<Note title={globalThis.x}>a</Note>\n\n<Note {...props}>b</Note>'),
	).toEqual([
		'index.mdx:5 gives <Note> title={globalThis.x}; attribute values must be strings, numbers or booleans.',
		'index.mdx:7 spreads {...props} into <Note>; attribute values must be strings, numbers or booleans.',
	]);
});

test('a text expression that is not a heading annotation', () => {
	expect(onePage('Text {1 + 1}.\n\n{globalThis.process}')).toEqual([
		"index.mdx:5 has the expression {1 + 1}. Pages are compiled as code, so the only `{…}` allowed is a heading annotation such as {{ icon: 'flag' }}.",
		"index.mdx:7 has the expression {globalThis.process}. Pages are compiled as code, so the only `{…}` allowed is a heading annotation such as {{ icon: 'flag' }}.",
	]);
});

test('a heading annotation with an unknown key or a value that is not a literal', () => {
	expect(
		onePage("## A {{ onClick: 'x' }}\n\n## B {{ label: someVariable }}"),
	).toEqual([
		'index.mdx:5 annotates a heading with onClick; the keys are tag, variant, label, icon, badge, anchor and className.',
		'index.mdx:7 annotates a heading with label: someVariable; annotation values must be strings, numbers or booleans.',
	]);
});

test('an unknown icon name', () => {
	expect(
		onePage(
			'## A {{ icon: \'rocket\' }}\n\n<Resources>\n\t<Resource href="/x" name="X" description="Y" icon="spaceship" />\n</Resources>',
		),
	).toEqual([
		'index.mdx:5 uses the icon "rocket", which the docs site does not have.',
		'index.mdx:8 uses the icon "spaceship", which the docs site does not have.',
	]);
});

test('an unknown Tag variant', () => {
	expect(
		onePage(
			"<Tag variant=\"danger\">X</Tag>\n\n## A {{ tag: 'X', variant: 'loud' }}",
		),
	).toEqual([
		'index.mdx:5 uses the Tag variant "danger"; the variants are changes, mono, ci and setup.',
		'index.mdx:7 uses the Tag variant "loud"; the variants are changes, mono, ci and setup.',
	]);
});

test('a nav href listed twice', () => {
	const dir = site({
		'nav.json': JSON.stringify([
			{title: 'A', links: [{title: 'Home', href: '/'}]},
			{title: 'B', links: [{title: 'Home again', href: '/'}]},
		]),
		'index.mdx': page('Home'),
	});
	expect(checkDocsSite(dir)).toEqual([
		'nav.json lists / twice (Home, Home again); each page goes in the nav once.',
	]);
});

test('a nav.json with the wrong shape', () => {
	const shapes = [
		[{title: 'A', links: [{title: 'Home', href: '/'}]}, {links: []}],
		{title: 'A'},
		[{title: 'A', links: [{title: 'Home'}]}],
		[{title: 'A', links: [{title: 'Home', href: 'install'}]}],
	];
	expect(
		shapes.map(shape =>
			checkDocsSite(
				site({'nav.json': JSON.stringify(shape), 'index.mdx': page('Home')}),
			),
		),
	).toEqual([
		[
			'nav.json must be a list of groups, each {title, links: [{title, href}]} with string values and hrefs that start with /: group 2 has no title.',
		],
		[
			'nav.json must be a list of groups, each {title, links: [{title, href}]} with string values and hrefs that start with /: it is not a list.',
		],
		[
			'nav.json must be a list of groups, each {title, links: [{title, href}]} with string values and hrefs that start with /: link 1 of group 1 (A) has no href.',
		],
		[
			'nav.json must be a list of groups, each {title, links: [{title, href}]} with string values and hrefs that start with /: link 1 of group 1 (A) has the href "install".',
		],
	]);
});

test('a page at /changelog, which the docs build writes itself', () => {
	const dir = site({
		'nav.json': nav('/', '/changelog'),
		'index.mdx': page('Home'),
		'changelog.mdx': page('Changelog'),
	});
	expect(checkDocsSite(dir)).toEqual([
		'changelog.mdx is reserved: chamoji.dev/docs builds /changelog from CHANGELOG.md. Rename the page.',
	]);
});

test('a code block annotation with a value that is not a string', () => {
	expect(
		onePage(
			[
				'```bash {{ title: globalThis.process.env.DATABASE_URL }}\necho hi\n```',
				"```js{{ title: (() => { throw new Error('ran at build') })() }}\nx\n```",
			].join('\n\n'),
		),
	).toEqual([
		'index.mdx:5 annotates a code block with title: globalThis.process.env.DATABASE_URL; code block annotation values must be strings.',
		"index.mdx:9 annotates a code block with title: (() => { throw new Error('ran at build') })(); code block annotation values must be strings.",
	]);
});

test('a code block annotation with a key other than title, tag or label', () => {
	expect(
		onePage(
			[
				"```bash {{ title: 'x', dangerouslySetInnerHTML: {__html: '<img src=x onerror=alert(1)>'} }}\necho hi\n```",
				'```bash {{ ...globalThis }}\necho hi\n```',
			].join('\n\n'),
		),
	).toEqual([
		'index.mdx:5 annotates a code block with dangerouslySetInnerHTML; the keys are title, tag and label.',
		'index.mdx:9 annotates a code block with ...globalThis; the keys are title, tag and label.',
	]);
});

test('a code block annotation that is not one object', () => {
	expect(
		onePage(
			[
				"```bash {{ title: 'a' }); globalThis.x = 1; ({ }}\necho hi\n```",
				"```bash {{ title: 'a' }}, {{ title: 'b' }}\necho hi\n```",
			].join('\n\n'),
		),
	).toEqual([
		"index.mdx:5 has a code block annotation that isn't one object; write it like {{ title: 'Install' }}.",
		"index.mdx:9 has a code block annotation that isn't one object; write it like {{ title: 'Install' }}.",
	]);
});

test('a link that is not a path, a web address or a mail address', () => {
	expect(
		onePage(
			[
				'[a](javascript:alert(1)) and ![b](data:text/html,x) and [c][ref].',
				'[ref]: VBScript:msgbox',
				'<Button href=" java\tscript:alert(1)">Go</Button>',
				'<Guides>\n\t<Guide href="//evil.example" name="X" description="Y" />\n</Guides>',
			].join('\n\n'),
		),
	).toEqual([
		'index.mdx:5 links to javascript:alert(1); a link is a path such as /commands/release, or an http, https or mailto address.',
		'index.mdx:5 links to data:text/html,x; a link is a path such as /commands/release, or an http, https or mailto address.',
		'index.mdx:7 links to VBScript:msgbox; a link is a path such as /commands/release, or an http, https or mailto address.',
		'index.mdx:9 links to " java\\tscript:alert(1)"; a link is a path such as /commands/release, or an http, https or mailto address.',
		'index.mdx:12 links to //evil.example; a link is a path such as /commands/release, or an http, https or mailto address.',
	]);
});
