import type {Changelog} from '../types.js';
import {renderHtml} from './html.js';
import {renderMarkdown} from './markdown.js';

export type OutputFormat = 'markdown' | 'json' | 'html';

export const renderJson = (changelog: Changelog) =>
	`${JSON.stringify(changelog, null, 2)}\n`;

export function render(changelog: Changelog, format: OutputFormat): string {
	switch (format) {
		case 'markdown': {
			return renderMarkdown(changelog);
		}

		case 'html': {
			return renderHtml(changelog);
		}

		case 'json': {
			return renderJson(changelog);
		}
	}
}

export {escapeHtml, renderHtml} from './html.js';
export {renderMarkdown} from './markdown.js';
