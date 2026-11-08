export {FRAMEWORKS, type Framework} from './frameworks.js';
export {classifyPackage, type PackageKind} from './kind.js';
export {
	detectPackageManager,
	packArgs,
	packPackage,
	readTarball,
	spawnSpec,
	tarCommand,
	tarballProblems,
	type PackageManager,
	type TarballFacts,
} from './pack.js';
export {distTagFor} from './dist-tags.js';
export {
	DEFAULT_REGISTRY,
	MIN_NPM,
	npmVersion,
	publishedVersions,
	requireNpm,
	runNpm,
	type NpmResult,
	type NpmRunner,
} from './npm.js';
export {registryFor} from './registry.js';
