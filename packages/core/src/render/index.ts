import type {Changelog} from '../types.js';
import {renderHtml} from './html.js';
import {renderMarkdown} from './markdown.js';

export type OutputFormat = 'markdown' | 'json' | 'html';

/**
 * A commit's `workstream` is null in a repo that has none. Leave it out
 * then, so `--json` stays what it was before workstreams.
 */
const omitNullWorkstream = (key: string, value: unknown) =>
	key === 'workstream' && value === null ? undefined : value;

export const renderJson = (changelog: Changelog) =>
	`${JSON.stringify(changelog, omitNullWorkstream, 2)}\n`;

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
