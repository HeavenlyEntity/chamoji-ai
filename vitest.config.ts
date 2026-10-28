import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vitest/config';

export default defineConfig({
	resolve: {
		alias: {
			'@chamoji/core': fileURLToPath(
				new URL('packages/core/src/index.ts', import.meta.url),
			),
		},
	},
	test: {
		include: ['packages/*/test/**/*.test.{ts,tsx}'],
		testTimeout: 20_000,
	},
});
