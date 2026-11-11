import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {assertNoSymlinks} from '../links.js';
import {pnpmSetupVersion} from '../publish/lockfile.js';
import {detectPackageManager} from '../publish/pack.js';
import type {FileChange} from '../release.js';
import type {Detection, SetupAnswers} from './answers.js';
import {privatizeEdit} from './privatize.js';
import {effectiveTrigger} from './rules.js';
import {
	findReleaseWorkflow,
	RELEASE_WORKFLOW_FILE,
	releaseWorkflow,
	workflowAdvice,
	workflowLacking,
} from './workflow.js';

/** Whether the answers need a release workflow: a merge trigger that is set, or publishing on. */
export const wantsWorkflow = (answers: SetupAnswers): boolean =>
	effectiveTrigger(answers) === 'merge' || answers.publish !== null;

/**
 * The public packages these answers publish: those the publish answer names
 * (by name or path), or every one of them when it names none. Nothing when
 * the answers don't publish.
 */
export function publishTargets(
	detection: Pick<Detection, 'publishable'>,
	answers: Pick<SetupAnswers, 'publish'>,
): Detection['publishable'] {
	if (!answers.publish) return [];
	const named = answers.publish.packages;
	return detection.publishable.filter(
		pkg =>
			named.length === 0 ||
			named.includes(pkg.name) ||
			named.includes(pkg.path),
	);
}

/**
 * The files besides the config that these answers write. A workflow that
 * already runs chamoji, or a file already at the new one's path, is never
 * replaced: `advice` says what the existing one needs instead. Refuses a
 * symlink in the way of any of them.
 */
export async function planSetupFiles(
	root: string,
	answers: SetupAnswers,
	branch: string,
	cliVersion: string | undefined,
): Promise<{
	/** The release workflow when it's new, then each privatized package.json. */
	files: FileChange[];
	/** What an existing workflow that runs chamoji lacks, said as advice, instead of a new file. */
	advice: string | null;
	/** The lines `advice` names; empty when nothing is missing. */
	adviceLines: string[];
	/** The file that stands in for a new workflow. */
	existingWorkflow: string | null;
}> {
	const files: FileChange[] = [];
	let advice: string | null = null;
	let adviceLines: string[] = [];
	let existingWorkflow: string | null = null;
	if (wantsWorkflow(answers) && cliVersion !== undefined) {
		const found = await findReleaseWorkflow(root, branch);
		const target = path.join(root, RELEASE_WORKFLOW_FILE);
		await assertNoSymlinks(root, RELEASE_WORKFLOW_FILE);
		// An untracked file at the new path counts too: it's someone's to keep.
		const present =
			found?.file ?? (existsSync(target) ? RELEASE_WORKFLOW_FILE : null);
		if (present) {
			existingWorkflow = present;
			const body = await readFile(path.join(root, present), 'utf8').catch(
				() => '',
			);
			// One that has it all, as setup's own file does, needs no advice.
			adviceLines = workflowLacking(body, {
				ciAuth: answers.ciAuth,
				branch,
				merge: effectiveTrigger(answers) === 'merge',
				publishing: answers.publish !== null,
			});
			advice =
				adviceLines.length > 0 ? workflowAdvice(present, adviceLines) : null;
		} else {
			const packageManager = await detectPackageManager(root);
			files.push({
				file: RELEASE_WORKFLOW_FILE,
				text: releaseWorkflow({
					branch,
					cliVersion,
					ciAuth: answers.ciAuth,
					packageManager,
					publishing: answers.publish !== null,
					pnpmVersion:
						packageManager === 'pnpm' ? await pnpmSetupVersion(root) : null,
				}),
				how:
					effectiveTrigger(answers) === 'merge'
						? `new file; releases on every push to ${branch} and on "Run workflow"`
						: 'new file; releases on "Run workflow"',
			});
		}
	}

	for (const pkgPath of answers.privatize) {
		// eslint-disable-next-line no-await-in-loop -- one file at a time, in the answers' order
		const change = await privatizeEdit(root, pkgPath);
		// eslint-disable-next-line no-await-in-loop
		const before = await readFile(path.join(root, change.file), 'utf8');
		if (change.text !== before) files.push(change);
	}

	return {files, advice, adviceLines, existingWorkflow};
}
