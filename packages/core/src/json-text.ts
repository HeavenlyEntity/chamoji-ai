const JSON_NUMBER = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/** A number as digits and a power of ten, so `1.50`, `15e-1` and `1.5` compare equal. */
function numberValue(text: string): string | undefined {
	const match = JSON_NUMBER.exec(text);
	if (!match) return undefined;
	const [, sign = '', whole = '', fraction = '', exponent = '0'] = match;
	const digits = (whole + fraction).replace(/^0+/, '');
	if (digits === '') return '0';
	const trimmed = digits.replace(/0+$/, '');
	const power =
		Number(exponent) - fraction.length + (digits.length - trimmed.length);
	return `${sign}${trimmed}e${power}`;
}

/**
 * The first number in JSON text that `JSON.parse` and `JSON.stringify` would
 * change in value, such as `12345678901234567890` or `1e999`. Strings are
 * skipped. Undefined when every number comes back the same.
 */
export function inexactNumber(json: string): string | undefined {
	for (const [token] of json.matchAll(
		/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
	)) {
		if (token.startsWith('"')) continue;
		const back = JSON.stringify(Number(token));
		if (numberValue(token) !== numberValue(back)) {
			return token.length > 40 ? `${token.slice(0, 40)}…` : token;
		}
	}

	return undefined;
}

type Obj = Record<string, unknown>;

const isObject = (value: unknown): value is Obj =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** A number's text as the original file spelled it. */
class Spelling {
	constructor(
		readonly source: string,
		readonly value: number,
	) {}
}

type Reviver = (
	this: unknown,
	key: string,
	value: unknown,
	context?: {source?: string},
) => unknown;

/**
 * The original's tree with each number replaced by its spelling, or undefined
 * when the original isn't JSON. Node 22's JSON.parse hands a reviver each
 * primitive's source text.
 */
function spellings(original: string): unknown {
	const reviver: Reviver = (_key, value, context) =>
		typeof value === 'number' && context?.source !== undefined
			? new Spelling(context.source, value)
			: value;
	try {
		return JSON.parse(
			original.replace(/^\uFEFF/, ''),
			reviver as Parameters<typeof JSON.parse>[1],
		);
	} catch {
		return undefined;
	}
}

const child = (spelled: unknown, key: string | number): unknown => {
	if (Array.isArray(spelled) && typeof key === 'number') return spelled[key];
	if (
		isObject(spelled) &&
		typeof key === 'string' &&
		Object.hasOwn(spelled, key)
	)
		return spelled[key];
	return undefined;
};

/**
 * `JSON.stringify(value, null, indent)`, except that a number whose value is
 * the same as the original's at the same place keeps the original's spelling.
 */
function stringify(
	value: unknown,
	spelled: unknown,
	indent: string,
	depth: number,
): string | undefined {
	if (typeof value === 'number') {
		return spelled instanceof Spelling && spelled.value === value
			? spelled.source
			: JSON.stringify(value);
	}

	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	const inner = indent.repeat(depth + 1);
	const close = `\n${indent.repeat(depth)}`;
	if (Array.isArray(value)) {
		if (value.length === 0) return '[]';
		const items = value.map(
			(item, index) =>
				`${inner}${stringify(item, child(spelled, index), indent, depth + 1) ?? 'null'}`,
		);
		return `[\n${items.join(',\n')}${close}]`;
	}

	const entries: string[] = [];
	for (const [key, item] of Object.entries(value)) {
		const text = stringify(item, child(spelled, key), indent, depth + 1);
		if (text !== undefined) {
			entries.push(`${inner}${JSON.stringify(key)}: ${text}`);
		}
	}

	return entries.length === 0 ? '{}' : `{\n${entries.join(',\n')}${close}}`;
}

/**
 * JSON in the style of `original`: its indent, line endings, final newline
 * and BOM, and the spelling of every number whose value didn't change. An
 * empty `original` gives two-space indent and a final newline.
 */
export function renderJson(data: Obj, original: string): string {
	const indent = /^([ \t]+)\S/m.exec(original)?.[1] ?? '  ';
	let text = stringify(data, spellings(original), indent, 0) ?? '';
	if (original === '' || /\n\s*$/.test(original)) text += '\n';
	if (original.includes('\r\n')) text = text.replace(/\n/g, '\r\n');
	return original.startsWith('\uFEFF') ? `\uFEFF${text}` : text;
}
