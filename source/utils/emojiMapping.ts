export const EMOJI_UNICODE_MAP: { [key: string]: string } = {
	sparkles: "✨",
	tada: "🎉",
	white_check_mark: "✅",
	construction_worker: "👷",
	chart_with_upwards_trend: "📈",
	heavy_plus_sign: "➕",
	loud_sound: "🔊",
	art: "🎨",
	zap: "⚡",
	lipstick: "💄",
	rotating_light: "🚨",
	arrow_down: "⬇️",
	arrow_up: "⬆️",
	pushpin: "📌",
	recycle: "♻️",
	wrench: "🔧",
	rewind: "⏪",
	alien: "👽",
	truck: "🚚",
	bento: "🍱",
	wheelchair: "♿",
	speech_balloon: "💬",
	card_file_box: "🗃️",
	children_crossing: "🚸",
	building_construction: "🏗️",
	iphone: "📱",
	boom: "💥",
	fire: "🔥",
	heavy_minus_sign: "➖",
	mute: "🔇",
	bug: "🐛",
	ambulance: "🚑",
	apple: "🍎",
	penguin: "🐧",
	checkered_flag: "🏁",
	robot: "🤖",
	green_apple: "🍏",
	green_heart: "💚",
	pencil2: "✏️",
	lock: "🔒",
	bookmark: "🔖",
};

/**
 * Returns the Unicode version of an alias if available.
 */
export function getEmojiUnicode(alias: string): string | undefined {
	return EMOJI_UNICODE_MAP[alias];
}

/**
 * Checks the commit message for a matching emoji from a list of aliases.
 * It returns the alias if a match is found (either as :alias: or the native Unicode).
 */
export function findMatchingEmoji(commitMessage: string, emojiAliases: string[]): string | null {
	for (const alias of emojiAliases) {
		const colonNotation = `:${alias}:`;
		if (commitMessage.includes(colonNotation)) {
			return alias;
		}
		const unicode = getEmojiUnicode(alias);
		if (unicode && commitMessage.includes(unicode)) {
			return alias;
		}
	}
	return null;
} 