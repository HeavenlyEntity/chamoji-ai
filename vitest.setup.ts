import {mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

// No test may reach GitHub as the person running it. gh reads its login from
// GH_CONFIG_DIR or a token variable, so point it at an empty directory and
// drop the tokens: a real gh call then fails as signed out instead of
// creating a release on whatever repo the tests run in.
const config = path.join(tmpdir(), 'chamoji-tests-gh-signed-out');
mkdirSync(config, {recursive: true});
process.env.GH_CONFIG_DIR = config;
for (const name of [
	'GH_TOKEN',
	'GITHUB_TOKEN',
	'GH_ENTERPRISE_TOKEN',
	'GITHUB_ENTERPRISE_TOKEN',
]) {
	delete process.env[name];
}
