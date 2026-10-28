#!/usr/bin/env node
import React from 'react';
import {render} from 'ink';
import meow from 'meow';
import App from './app.js';

const cli = meow(
	`
	Usage
	  $ chamoji [options]

	Options
		--config  Path to configuration file
		--format  Output format (markdown, json, html)

	Examples
	  $ chamoji --config=chamoji.config.json --format=markdown
`,
	{
		importMeta: import.meta,
		flags: {
			config: {
				type: 'string'
			},
			format: {
				type: 'string',
				default: 'markdown'
			},
		},
	}
);

render(
	<App
		config={cli.flags.config}
		format={cli.flags.format as 'markdown' | 'json' | 'html'}
	/>
);
