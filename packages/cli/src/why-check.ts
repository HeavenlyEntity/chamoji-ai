import {HINT_THRESHOLD, type AdvisorClient} from './advisor.js';

/** Names the question below; change it whenever the question changes. */
export const WHY_CHECK_VERSION = 'jev-latest:why-v1';

/**
 * Asks Jev whether a Why would stop a future engineer from undoing the change
 * by mistake. It sees the title, the Why and the staged file paths, nothing
 * else. True means the reason is unclear; a failed request throws, and callers
 * treat that as "no opinion".
 */
export function createWhyChecker(client: AdvisorClient) {
	return async (input: {
		title: string;
		why: string;
		files: string[];
	}): Promise<boolean> => {
		const {title, why, files} = input;
		const {answers} = await client.systemOne({
			state: {title, why, files},
			questions: {
				specific: {
					type: 'noul',
					instructions:
						'A developer is committing a change titled `title` that touches `files`. They gave `why` as the reason for it. Would this reason stop a future engineer from undoing the change by mistake?',
					criteria: {
						true: 'It names a cause, limit, bug, request or consequence specific to this change.',
						false:
							'It is generic, restates the title, or could be said of almost any change.',
					},
				},
			},
		});
		// The answer is the chance the reason is specific.
		const specific = answers['specific']?.noul;
		return specific !== undefined && 1 - specific >= HINT_THRESHOLD;
	};
}

export type WhyChecker = ReturnType<typeof createWhyChecker>;
