import {readFile} from 'node:fs/promises';
import path from 'node:path';
import type {ChamojiConfig, GroupConfig} from './types.js';

export const CONFIG_FILE = 'chamoji.config.json';

/**
 * Keep a Changelog style sections. Every official gitmoji appears exactly once
 * (enforced by a test). The retired `apple`, `penguin`, `checkered_flag`,
 * `robot` and `green_apple` codes stay under Fixed for older histories.
 */
export const DEFAULT_GROUP_CONFIG: GroupConfig = [
	{
		group: 'added',
		label: 'Added',
		emojis: [
			'sparkles',
			'tada',
			'white_check_mark',
			'construction_worker',
			'chart_with_upwards_trend',
			'loud_sound',
			'globe_with_meridians',
			'camera_flash',
			'seedling',
			'test_tube',
			'necktie',
			'triangular_flag_on_post',
			'egg',
			'money_with_wings',
			'thread',
			'safety_vest',
			'airplane',
			'stethoscope',
		],
	},
	{
		group: 'changed',
		label: 'Changed',
		emojis: [
			'art',
			'zap',
			'lipstick',
			'rotating_light',
			'recycle',
			'wrench',
			'rewind',
			'alien',
			'truck',
			'bento',
			'wheelchair',
			'speech_balloon',
			'card_file_box',
			'children_crossing',
			'building_construction',
			'iphone',
			'hammer',
			'package',
			'label',
			'mag',
			'dizzy',
			'goal_net',
			'bricks',
			'technologist',
			'page_facing_up',
			'poop',
		],
	},
	{group: 'breaking_changes', label: 'Breaking changes', emojis: ['boom']},
	{group: 'deprecated', label: 'Deprecated', emojis: ['wastebasket']},
	{
		group: 'removed',
		label: 'Removed',
		emojis: ['fire', 'mute', 'coffin'],
	},
	{
		group: 'fixed',
		label: 'Fixed',
		emojis: [
			'bug',
			'ambulance',
			'green_heart',
			'pencil2',
			'adhesive_bandage',
			'apple',
			'penguin',
			'checkered_flag',
			'robot',
			'green_apple',
		],
	},
	{
		group: 'security',
		label: 'Security',
		emojis: ['lock', 'closed_lock_with_key', 'passport_control'],
	},
	{
		group: 'dependencies',
		label: 'Dependencies',
		emojis: [
			'arrow_up',
			'arrow_down',
			'pushpin',
			'heavy_plus_sign',
			'heavy_minus_sign',
		],
		collapse: true,
	},
	{
		group: 'useless',
		label: 'Useless',
		emojis: ['bookmark', 'twisted_rightwards_arrows'],
		hidden: true,
	},
	{
		group: 'misc',
		label: 'Miscellaneous',
		emojis: [
			'memo',
			'bulb',
			'rocket',
			'construction',
			'beers',
			'busts_in_silhouette',
			'clown_face',
			'see_no_evil',
			'alembic',
			'monocle_face',
		],
	},
];

/**
 * Loads `explicitPath`, or `chamoji.config.json` in `cwd` when present.
 * A JSON array is treated as a legacy group config.
 */
export async function loadConfig(
	cwd: string,
	explicitPath?: string,
): Promise<ChamojiConfig> {
	const file = path.resolve(cwd, explicitPath ?? CONFIG_FILE);

	let text: string;
	try {
		text = await readFile(file, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw error;
		}

		if (explicitPath) {
			throw new Error(`Config file not found: ${file}`);
		}

		return {groups: DEFAULT_GROUP_CONFIG};
	}

	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch (error) {
		throw new Error(`Invalid config ${file}: ${(error as Error).message}`);
	}

	if (Array.isArray(data)) {
		return {groups: validateGroups(data, file)};
	}

	if (!data || typeof data !== 'object') {
		throw new Error(`Invalid config ${file}: expected an object or an array`);
	}

	const {groups, repositoryUrl} = data as Record<string, unknown>;
	if (repositoryUrl !== undefined && typeof repositoryUrl !== 'string') {
		throw new Error(`Invalid config ${file}: repositoryUrl must be a string`);
	}

	return {
		groups:
			groups === undefined
				? DEFAULT_GROUP_CONFIG
				: validateGroups(groups, file),
		...(repositoryUrl ? {repositoryUrl} : {}),
	};
}

function validateGroups(value: unknown, file: string): GroupConfig {
	const valid =
		Array.isArray(value) &&
		value.every(
			item =>
				item &&
				typeof item.group === 'string' &&
				typeof item.label === 'string' &&
				Array.isArray(item.emojis) &&
				item.emojis.every((code: unknown) => typeof code === 'string'),
		);
	if (!valid) {
		throw new Error(
			`Invalid config ${file}: groups must be [{group, label, emojis: string[]}]`,
		);
	}

	return (value as GroupConfig).map(item => ({
		...item,
		emojis: item.emojis.map(code => code.replaceAll(':', '')),
	}));
}
