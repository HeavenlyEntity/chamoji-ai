#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import process from 'node:process';
import {run} from './run.js';
import {createUpdateCheck} from './update-check.js';

const {version} = JSON.parse(
	readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {version: string};

process.exitCode = await run(process.argv.slice(2), {
	cwd: process.cwd(),
	stdout: text => process.stdout.write(text),
	stderr: text => process.stderr.write(text),
	updateCheck: createUpdateCheck({
		current: version,
		env: process.env,
		stderrIsTTY: Boolean(process.stderr.isTTY),
		scriptPath: process.argv[1] ?? '',
		cwd: process.cwd(),
	}),
});
