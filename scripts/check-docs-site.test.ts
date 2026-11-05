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
