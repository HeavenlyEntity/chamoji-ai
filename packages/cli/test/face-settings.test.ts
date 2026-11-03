import {expect, test} from 'vitest';
import {hasFace, shouldAnimate} from '../src/face-settings.js';

const tty = {env: {}, stderrIsTTY: true, argv: ['memory', 'sync']};

test('shouldAnimate is true for a terminal with a clean environment', () => {
	expect(shouldAnimate(tty)).toBe(true);
});

test('shouldAnimate is false when stderr is not a terminal', () => {
	expect(shouldAnimate({...tty, stderrIsTTY: false})).toBe(false);
});

test('shouldAnimate is false when CI is set', () => {
	expect(shouldAnimate({...tty, env: {CI: 'true'}})).toBe(false);
	expect(shouldAnimate({...tty, env: {CI: '1'}})).toBe(false);
});

test('shouldAnimate is false on a dumb terminal', () => {
	expect(shouldAnimate({...tty, env: {TERM: 'dumb'}})).toBe(false);
	expect(shouldAnimate({...tty, env: {TERM: 'xterm-256color'}})).toBe(true);
});

test('shouldAnimate is false with --json anywhere in argv', () => {
	expect(shouldAnimate({...tty, argv: ['memory', 'sync', '--json']})).toBe(
		false,
	);
	expect(
		shouldAnimate({...tty, argv: ['--json', 'release', '--dry-run']}),
	).toBe(false);
	expect(shouldAnimate({...tty, argv: ['release', '--json=true']})).toBe(false);
});

test('shouldAnimate is false when CHAMOJI_NO_ANIMATION=1', () => {
	expect(shouldAnimate({...tty, env: {CHAMOJI_NO_ANIMATION: '1'}})).toBe(false);
});

test('NO_COLOR keeps the face animating', () => {
	expect(shouldAnimate({...tty, env: {NO_COLOR: '1'}})).toBe(true);
});

test('hasFace is true for the commands that wait', () => {
	expect(hasFace(['memory', 'sync'], {})).toBe(true);
	expect(hasFace(['memory', 'reindex'], {})).toBe(true);
	expect(hasFace(['memory', 'search', 'login'], {ai: true})).toBe(true);
	expect(hasFace(['init'], {})).toBe(true);
	expect(hasFace(['init', '--agents'], {})).toBe(true);
	expect(hasFace(['release'], {})).toBe(true);
	expect(hasFace(['release', '2.0.0'], {})).toBe(true);
	expect(hasFace(['changelog'], {ai: true})).toBe(true);
	expect(hasFace(['next-version'], {ai: true})).toBe(true);
	expect(hasFace(['why', 'src/a.ts:2'], {})).toBe(true);
	expect(hasFace(['ws', 'ship'], {})).toBe(true);
	expect(hasFace(['ws', 'drop', 'auth'], {})).toBe(true);
});

test('hasFace is false for mcp, agent-hook, hook, the composer and card', () => {
	expect(hasFace(['mcp'], {ai: true})).toBe(false);
	expect(hasFace(['agent-hook'], {})).toBe(false);
	expect(hasFace(['hook', 'run', 'MSG'], {})).toBe(false);
	expect(hasFace(['hook', 'install'], {})).toBe(false);
	expect(hasFace(['commit'], {ai: true})).toBe(false);
	expect(hasFace(['card'], {ai: true})).toBe(false);
});

test('hasFace is false for commands that never wait on anything slow', () => {
	expect(hasFace([], {})).toBe(false);
	expect(hasFace(['changelog'], {})).toBe(false);
	expect(hasFace(['next-version'], {})).toBe(false);
	expect(hasFace(['memory'], {})).toBe(false);
	expect(hasFace(['memory', 'list'], {})).toBe(false);
	expect(hasFace(['memory', 'search', 'login'], {})).toBe(false);
	expect(hasFace(['ws'], {})).toBe(false);
	expect(hasFace(['ws', 'start', 'Auth'], {})).toBe(false);
	expect(hasFace(['nope'], {})).toBe(false);
});

test('hasFace is false for --help and --version', () => {
	expect(hasFace(['release'], {help: true})).toBe(false);
	expect(hasFace(['memory', 'sync'], {version: true})).toBe(false);
});
