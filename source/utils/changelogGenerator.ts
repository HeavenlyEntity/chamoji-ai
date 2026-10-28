import { getCommitsBetween } from "./gitUtils.js";
import { findMatchingEmoji } from "./emojiMapping.js";
import type { GroupConfig } from "../config/defaultGroupConfig.js";

export type Commit = {
	hash: string;
	message: string;
};

export type Release = {
	tag: string;
	date: string;
	groups: { [groupId: string]: Commit[] };
};

/**
 * Generates a Release object for a given tag (and its commit range).
 * Commits are grouped according to the provided group configuration.
 */
export async function getReleaseData(
	tag: string,
	previousTag: string | undefined,
	repositoryURL: string | undefined,
	groupConfig: GroupConfig
): Promise<Release> {
	const commitLines = await getCommitsBetween(tag, previousTag ?? '');
	const release: Release = {
		tag,
		date: await getTagDate(tag),
		groups: {},
	};

	// Initialize empty groups for each configuration item.
	for (const cfg of groupConfig) {
		release.groups[cfg.group] = [];
	}

	// Go through each commit and assign it to a group based on matching emoji.
	for (const line of commitLines) {
		const [hash, ...msgParts] = line.split(";");
		const message = msgParts.join(";").trim();
		let matched = false;
		for (const cfg of groupConfig) {
			const emojiMatch = findMatchingEmoji(message, cfg.emojis);
			if (emojiMatch !== null) {
				release.groups[cfg.group].push({ hash, message });
				matched = true;
				break;
			}
		}
		// If no matching group was found, place the commit into the 'misc' group (if configured).
		if (!matched && release.groups["misc"]) {
			release.groups["misc"].push({ hash, message });
		}
	}

	return release;
}

/**
 * Retrieves the date (ISO format) for a given Git tag.
 */
async function getTagDate(tag: string): Promise<string> {
	const { exec } = await import("child_process");
	const { promisify } = await import("util");
	const execAsync = promisify(exec);
	// Get the author date in ISO format.
	const { stdout } = await execAsync(`git log -1 --format=%aI ${tag}`);
	return stdout.trim();
} 