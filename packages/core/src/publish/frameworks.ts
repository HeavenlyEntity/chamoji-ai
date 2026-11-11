import type {SdfProject} from '../units/sdf.js';

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
	/** Config file (relative to the package) -> regex source its text must match to count. */
	configMatch?: Record<string, string>;
	/** Found by the SDF finder in `units/sdf.ts`; the dependency matcher skips these rows. */
	detectedBy?: 'sdf';
};

/** The framework a package is built with, with the version it uses. */
export type DetectedFramework = {
	id: string;
	name: string;
	/** Major.minor as shown to people, or null when it isn't known. */
	version: string | null;
	basedOn: string[];
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
	{
		id: 'vite-preact',
		name: 'Vite + Preact',
		packages: ['@preact/preset-vite'],
		configFiles: [],
		basedOn: ['vite'],
		requires: viteApp,
	},
	{
		id: 'vite-lit',
		name: 'Vite + Lit',
		packages: ['lit'],
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
		basedOn: ['remix', 'react-router', 'vite'],
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
		// app.config.* is Expo's name too, so the file alone is a guess.
		requires: {configPackage: '@solidjs/start'},
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
		// app.config.* is SolidStart's name too, so the file alone is a guess.
		requires: {configPackage: 'expo'},
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
	{
		id: 'ember',
		name: 'Ember',
		packages: ['ember-source'],
		configFiles: ['ember-cli-build.js'],
		basedOn: [],
	},
	{
		id: 'ionic',
		name: 'Ionic',
		packages: ['@ionic/react', '@ionic/angular', '@ionic/vue'],
		configFiles: [],
		basedOn: ['capacitor', 'react', 'vite-react', 'vite-vue', 'angular'],
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
	{
		id: 'koa',
		name: 'Koa',
		packages: ['koa'],
		configFiles: [],
		basedOn: [],
	},
	// Enterprise platforms, found from their files.
	{
		id: 'salesforce-dx',
		name: 'Salesforce DX',
		packages: [],
		configFiles: ['sfdx-project.json'],
		basedOn: [],
	},
	{
		id: 'shopify-app',
		name: 'Shopify app',
		packages: [],
		configFiles: ['shopify.app.toml'],
		basedOn: [],
	},
	{
		id: 'forge',
		name: 'Forge',
		packages: [],
		configFiles: ['manifest.yml'],
		basedOn: [],
		configMatch: {
			'manifest.yml': '^app:[ \\t]*\\r?\\n(?:[ \\t]+\\S[^\\n]*\\n)*?[ \\t]+id:',
		},
	},
	{
		id: 'netsuite-suiteapp',
		name: 'NetSuite SuiteApp',
		packages: [],
		configFiles: [],
		basedOn: [],
		detectedBy: 'sdf',
	},
	{
		id: 'netsuite-acp',
		name: 'NetSuite Account Customization Project',
		packages: [],
		configFiles: [],
		basedOn: [],
		detectedBy: 'sdf',
	},
];

/** The framework an SDF project is, named from its `FRAMEWORKS` row, with its manifest version. */
export function sdfFramework(
	project: Pick<SdfProject, 'framework' | 'version'>,
): DetectedFramework {
	const row = FRAMEWORKS.find(framework => framework.id === project.framework);
	if (!row) throw new Error(`No framework row for ${project.framework}`);
	return {
		id: row.id,
		name: row.name,
		version: project.version,
		basedOn: [...row.basedOn],
	};
}
