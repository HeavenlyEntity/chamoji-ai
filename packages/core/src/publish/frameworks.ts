/** One app framework: how to spot it in a package. Data only, one row each. */
export type Framework = {
	id: string;
	name: string;
	/** Dependency names that mean the framework is used. */
	packages: string[];
	/** Config files (relative to the package) that mean the framework is used. */
	configFiles: string[];
	/** Ids of the frameworks this one is built on. */
	basedOn: string[];
	/**
	 * Something the package must also hold for this to count as an app: a file,
	 * or (for the config files only) a dependency in any dependency field.
	 */
	requires?: {file?: string; configPackage?: string};
};

const viteApp = {file: 'index.html'};

export const FRAMEWORKS: readonly Framework[] = [
	// Vite, bare and with each plugin.
	{
		id: 'vite',
		name: 'Vite',
		packages: ['vite'],
		configFiles: [],
		basedOn: [],
		requires: viteApp,
	},
	{
		id: 'vite-react',
		name: 'Vite + React',
		packages: ['@vitejs/plugin-react', '@vitejs/plugin-react-swc'],
		configFiles: [],
		basedOn: ['vite', 'react'],
		requires: viteApp,
	},
	{
		id: 'vite-vue',
		name: 'Vite + Vue',
		packages: ['@vitejs/plugin-vue', '@vitejs/plugin-vue-jsx'],
		configFiles: [],
		basedOn: ['vite'],
		requires: viteApp,
	},
	{
		id: 'vite-svelte',
		name: 'Vite + Svelte',
		packages: ['@sveltejs/vite-plugin-svelte'],
		configFiles: [],
		basedOn: ['vite'],
		requires: viteApp,
	},
	{
		id: 'vite-solid',
		name: 'Vite + Solid',
		packages: ['vite-plugin-solid'],
		configFiles: [],
		basedOn: ['vite'],
		requires: viteApp,
	},
	// React.
	{
		id: 'react',
		name: 'React',
		packages: ['react-dom'],
		configFiles: [],
		basedOn: [],
		requires: viteApp,
	},
	{
		id: 'create-react-app',
		name: 'Create React App',
		packages: ['react-scripts'],
		configFiles: [],
		basedOn: ['react'],
	},
	// Meta-frameworks.
	{
		id: 'next',
		name: 'Next.js',
		packages: ['next'],
		configFiles: ['next.config.js', 'next.config.mjs', 'next.config.ts'],
		basedOn: ['react'],
	},
	{
		id: 'nuxt',
		name: 'Nuxt',
		packages: ['nuxt'],
		configFiles: ['nuxt.config.js', 'nuxt.config.ts'],
		basedOn: ['vite'],
	},
	{
		id: 'sveltekit',
		name: 'SvelteKit',
		packages: ['@sveltejs/kit'],
		configFiles: ['svelte.config.js', 'svelte.config.ts'],
		basedOn: ['vite'],
		requires: {configPackage: '@sveltejs/kit'},
	},
	{
		id: 'astro',
		name: 'Astro',
		packages: ['astro'],
		configFiles: ['astro.config.mjs', 'astro.config.js', 'astro.config.ts'],
		basedOn: ['vite'],
	},
	{
		id: 'remix',
		name: 'Remix',
		packages: ['@remix-run/node', '@remix-run/react', '@remix-run/serve'],
		configFiles: ['remix.config.js'],
		basedOn: ['react'],
	},
	{
		id: 'react-router',
		name: 'React Router',
		packages: [
			'@react-router/dev',
			'@react-router/node',
			'@react-router/serve',
		],
		configFiles: ['react-router.config.ts', 'react-router.config.js'],
		basedOn: ['react', 'vite'],
	},
	{
		id: 'hydrogen',
		name: 'Hydrogen',
		packages: ['@shopify/hydrogen'],
		configFiles: [],
		basedOn: ['react-router', 'vite'],
	},
	{
		id: 'qwik',
		name: 'Qwik',
		packages: ['@builder.io/qwik-city'],
		configFiles: [],
		basedOn: ['vite'],
	},
	{
		id: 'solid-start',
		name: 'SolidStart',
		packages: ['@solidjs/start'],
		configFiles: ['app.config.ts', 'app.config.js'],
		basedOn: ['vite'],
	},
	{
		id: 'tanstack-start',
		name: 'TanStack Start',
		packages: ['@tanstack/react-start', '@tanstack/start'],
		configFiles: [],
		basedOn: ['react', 'vite'],
	},
	{
		id: 'gatsby',
		name: 'Gatsby',
		packages: ['gatsby'],
		configFiles: ['gatsby-config.js', 'gatsby-config.ts'],
		basedOn: ['react'],
	},
	{
		id: 'docusaurus',
		name: 'Docusaurus',
		packages: ['@docusaurus/core'],
		configFiles: ['docusaurus.config.js', 'docusaurus.config.ts'],
		basedOn: ['react'],
	},
	{
		id: 'angular',
		name: 'Angular',
		packages: ['@angular/core'],
		configFiles: [],
		basedOn: [],
		requires: {file: 'angular.json'},
	},
	// Mobile and desktop.
	{
		id: 'expo',
		name: 'Expo',
		packages: ['expo'],
		configFiles: ['app.config.js', 'app.config.ts'],
		basedOn: ['react-native'],
	},
	{
		id: 'react-native',
		name: 'React Native',
		packages: ['react-native'],
		configFiles: ['metro.config.js'],
		basedOn: ['react'],
	},
	{
		id: 'capacitor',
		name: 'Capacitor',
		packages: ['@capacitor/core', '@capacitor/cli'],
		configFiles: ['capacitor.config.ts', 'capacitor.config.json'],
		basedOn: [],
	},
	{
		id: 'tauri',
		name: 'Tauri',
		packages: ['@tauri-apps/cli'],
		configFiles: ['src-tauri/tauri.conf.json'],
		basedOn: [],
	},
	{
		id: 'electron',
		name: 'Electron',
		packages: ['electron'],
		configFiles: [
			'electron-builder.yml',
			'electron-builder.json',
			'electron-builder.js',
			'electron-builder.ts',
			'forge.config.js',
			'forge.config.ts',
		],
		basedOn: [],
	},
	// Servers.
	{
		id: 'nestjs',
		name: 'NestJS',
		packages: ['@nestjs/core'],
		configFiles: ['nest-cli.json'],
		basedOn: [],
	},
	{
		id: 'express',
		name: 'Express',
		packages: ['express'],
		configFiles: [],
		basedOn: [],
	},
	{
		id: 'fastify',
		name: 'Fastify',
		packages: ['fastify'],
		configFiles: [],
		basedOn: [],
	},
	{
		id: 'hono',
		name: 'Hono',
		packages: ['hono'],
		configFiles: [],
		basedOn: [],
	},
];
