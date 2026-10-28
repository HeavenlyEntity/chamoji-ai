import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Returns all Git tags sorted descending by version.
 */
export async function getGitTags(): Promise<string[]> {
	const { stdout } = await execAsync('git tag --list --sort=-v:refname');
	const tags = stdout
		.split('\n')
		.map(tag => tag.trim())
		.filter(tag => /^v?\d+\.\d+\.\d+$/.test(tag));
	return tags;
}

/**
 * Returns an array of commit lines for a given tag range.
 * Each commit is formatted as "hash;message".
 */
export async function getCommitsBetween(tag: string, previousTag?: string): Promise<string[]> {
	const command = previousTag
		? `git log ${previousTag}..${tag} --pretty=format:"%h;%s"`
		: `git log ${tag} --pretty=format:"%h;%s"`;
	const { stdout, stderr } = await execAsync(command);
	if (stderr) {
		throw new Error(stderr);
	}
	return stdout.split('\n').filter(line => line.trim() !== '');
} 