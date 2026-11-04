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
		// The tests start many git processes, which Windows runners start several
		// times slower and slower still under load; tests that take 4 s there can
		// pass 20 s on a busy runner. A real hang still fails within a minute.
		testTimeout: process.platform === 'win32' ? 60_000 : 20_000,
		hookTimeout: process.platform === 'win32' ? 60_000 : 10_000,
	},
});
