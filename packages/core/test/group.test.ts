import {expect, test} from 'vitest';
import {DEFAULT_GROUP_CONFIG} from '../src/config.js';
import {groupCommits} from '../src/group.js';
import {commit} from './helpers/commit.js';

const ids = (groups: ReturnType<typeof groupCommits>) =>
	groups.map(group => group.group);

test('groups follow config order and omit empty groups', () => {
	const groups = groupCommits(
		[commit('🐛 Fix crash'), commit('✨ Add login'), commit('🐛 Fix typo')],
		DEFAULT_GROUP_CONFIG,
	);
	expect(ids(groups)).toEqual(['added', 'fixed']);
	expect(groups[1]!.commits.map(c => c.description)).toEqual([
		'Fix crash',
		'Fix typo',
	]);
});

test('hidden useless group is omitted', () => {
	const groups = groupCommits(
		[commit('🔖 Release v1.0.0'), commit('✨ Add login')],
		DEFAULT_GROUP_CONFIG,
	);
	expect(ids(groups)).toEqual(['added']);
});

test('breaking sparkles goes to breaking_changes', () => {
	const groups = groupCommits(
		[commit('feat!: ✨ New API')],
		DEFAULT_GROUP_CONFIG,
	);
	expect(ids(groups)).toEqual(['breaking_changes']);
});

test('commits without a matching group go to misc', () => {
	const groups = groupCommits(
		[commit('Misc stuff'), commit('💡 Comment the parser')],
		DEFAULT_GROUP_CONFIG,
	);
	expect(ids(groups)).toEqual(['misc']);
	expect(groups[0]!.commits).toHaveLength(2);
});

test('without a misc group unmatched commits are dropped', () => {
	const groups = groupCommits(
		[commit('Misc stuff'), commit('✨ Add login')],
		[{group: 'added', label: 'Added', emojis: ['sparkles']}],
	);
	expect(ids(groups)).toEqual(['added']);
});

test('dependency updates go to a collapsed Dependencies group', () => {
	const groups = groupCommits(
		[
			commit('⬆️ Bump jest from 30.3.0 to 30.5.0 (#1569)'),
			commit('chore(deps): update rollup'),
			commit('Update dependencies'),
			commit('✨ Add login'),
		],
		DEFAULT_GROUP_CONFIG,
	);
	expect(ids(groups)).toEqual(['added', 'dependencies']);
	expect(groups[1]).toMatchObject({label: 'Dependencies', collapse: true});
	expect(groups[1]!.commits).toHaveLength(3);
});

test('docs commits get their own Documentation section', () => {
	const groups = groupCommits(
		[
			commit('📝 Add the roadmap'),
			commit('docs: explain --ai'),
			commit('Update readme'),
		],
		DEFAULT_GROUP_CONFIG,
	);
	expect(groups.map(g => [g.group, g.label, g.commits.length])).toEqual([
		['documentation', 'Documentation', 3],
	]);
});
