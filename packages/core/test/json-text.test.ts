import {expect, test} from 'vitest';
import {inexactNumber, renderJsonText} from '../src/index.js';

const data = {name: 'x', list: [1, {deep: true}], empty: {}, none: []};

test("renderJson writes what JSON.stringify writes, in the original's indent", () => {
	for (const indent of ['\t', '    ', '  ']) {
		const original = `{\n${indent}"name": "old"\n}\n`;
		expect(renderJsonText(data, original)).toBe(
			`${JSON.stringify(data, null, indent)}\n`,
		);
	}
});

test('renderJson keeps the final newline, line endings and BOM as they were', () => {
	const plain = JSON.stringify(data, null, '\t');
	expect(renderJsonText(data, '{\n\t"a": 1\n}')).toBe(plain);
	expect(renderJsonText(data, '{\n\t"a": 1\n}\n')).toBe(`${plain}\n`);
	expect(renderJsonText(data, '')).toBe(
		`${JSON.stringify(data, null, '  ')}\n`,
	);
	expect(renderJsonText(data, '﻿{\r\n\t"a": 1\r\n}\r\n')).toBe(
		`﻿${plain.replaceAll('\n', '\r\n')}\r\n`,
	);
});

test('renderJson spells a number as the original did while its value is the same', () => {
	const original =
		'{\n\t"a": 1.0,\n\t"b": [1.5e3, 0.10],\n\t"c": {"d": 2.50},\n\t"e": 12345678901234567890\n}\n';
	const parsed = JSON.parse(original) as Record<string, unknown>;
	const text = renderJsonText({...parsed, c: {d: 3}, f: 1}, original);
	expect(text).toBe(
		'{\n\t"a": 1.0,\n\t"b": [\n\t\t1.5e3,\n\t\t0.10\n\t],\n\t"c": {\n\t\t"d": 3\n\t},\n\t"e": 12345678901234567890,\n\t"f": 1\n}\n',
	);
});

test('inexactNumber names a number that would change, and skips strings', () => {
	expect(inexactNumber('{"a": 12345678901234567890}')).toBe(
		'12345678901234567890',
	);
	expect(inexactNumber('{"a": 1.0, "b": "1e999"}')).toBeUndefined();
});
