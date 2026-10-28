import React, { useState, useEffect } from 'react';
import { Text, Box } from 'ink';
import fs from 'fs/promises';

import { getGitTags } from './utils/gitUtils.js';
import { getReleaseData, Release } from './utils/changelogGenerator.js';
import { DEFAULT_GROUP_CONFIG, type GroupConfig } from './config/defaultGroupConfig.js';

interface AppProps {
	config?: string;
	format: 'markdown' | 'json' | 'html';
}

export default function App({ config, format }: AppProps) {
	const [loading, setLoading] = useState(true);
	const [changelogOutput, setChangelogOutput] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [repositoryURL, setRepositoryURL] = useState<string | undefined>(undefined);
	const [groupConfig, setGroupConfig] = useState<GroupConfig>(DEFAULT_GROUP_CONFIG);
	const [packageVersion, setPackageVersion] = useState<string | undefined>(undefined);

	useEffect(() => {
		(async () => {
			// Load custom grouping configuration if provided.
			if (config) {
				try {
					const configData = await fs.readFile(config, 'utf-8');
					const parsed = JSON.parse(configData);
					if (Array.isArray(parsed)) {
						setGroupConfig(parsed);
					}
				} catch (err) {
					console.error('Error loading configuration file, using default settings.');
				}
			}

			try {
				// Load package.json for package version and repository URL.
				const packageJsonRaw = await fs.readFile('package.json', 'utf-8');
				const packageData = JSON.parse(packageJsonRaw);
				setPackageVersion(packageData.version);
				if (packageData.repository) {
					if (typeof packageData.repository === 'string') {
						setRepositoryURL(packageData.repository);
					} else if (packageData.repository.url) {
						setRepositoryURL(
							packageData.repository.url.replace(/^git\+/, '').replace(/\.git$/, '')
						);
					}
				}
			} catch (err) {
				console.warn('Could not load package.json.');
			}

			try {
				// Fetch Git tags.
				const allTags = await getGitTags();
				if (allTags.length === 0) {
					throw new Error('No valid version tags found.');
				}
				let filteredTags = allTags;
				if (packageVersion) {
					const versionTag = allTags.find((t: string) => t === packageVersion || t === `v${packageVersion}`);
					if (versionTag) {
						const idx = allTags.indexOf(versionTag);
						filteredTags = allTags.slice(idx);
					}
				}

				// Generate release data for each tag.
				const releases: Release[] = [];
				for (let i = 0; i < filteredTags.length; i++) {
					const tag = filteredTags[i];
					const previousTag = filteredTags[i + 1]; // may be undefined
					const releaseData = await getReleaseData(
						tag ?? '',
						previousTag ?? '',
						JSON.stringify(groupConfig ?? []),
						repositoryURL ?? ''
					);
					releases.push(releaseData);
				}

				// Build output based on requested format.
				if (format === 'json') {
					setChangelogOutput(JSON.stringify(releases, null, 2));
				} else if (format === 'html') {
					let html = `<html>
  <head>
    <title>Chamoji Changelog</title>
    <meta charset="utf-8"/>
    <style>
      body { font-family: sans-serif; line-height: 1.6; }
      h1, h2, h3 { margin-bottom: 0.2em; }
      ul { list-style-type: disc; margin-left: 20px; }
    </style>
  </head>
  <body>
    <h1>Changelog</h1>\n`;
					for (const release of releases) {
						html += `<a name="${release.tag}"></a>
    <h2>${release.tag} (${release.date})</h2>\n`;
						for (const groupItem of groupConfig) {
							const commits = release.groups[groupItem.group];
							if (commits && commits.length > 0) {
								html += `<h3>${groupItem.label}</h3>\n<ul>\n`;
								for (const commit of commits) {
									const formattedMessage = commit.message.replace(/#(\d+)/g, (_m: string, p1: string) =>
										repositoryURL
											? `[#${p1}](${repositoryURL}/issues/${p1})`
											: `#${p1}`
									);
									const commitLink = repositoryURL
										? `<a href="${repositoryURL}/commit/${commit.hash}">${commit.hash}</a>`
										: commit.hash;
									html += `  <li>${formattedMessage} [ [${commitLink}] ]</li>\n`;
								}
								html += `</ul>\n`;
							}
						}
					}
					html += `</body>\n</html>`;
					setChangelogOutput(html);
				} else {
					// Default: Markdown output.
					let md = '# Changelog\n\n';
					for (const release of releases) {
						md += `<a name="${release.tag}"></a>\n`;
						md += `## ${release.tag} (${release.date})\n\n`;
						for (const groupItem of groupConfig) {
							const commits = release.groups[groupItem.group];
							if (commits && commits.length > 0) {
								md += `### ${groupItem.label}\n\n`;
								for (const commit of commits) {
									const formattedMessage = commit.message.replace(/#(\d+)/g, (_m: string, p1: string) =>
										repositoryURL
											? `[#${p1}](${repositoryURL}/issues/${p1})`
											: `#${p1}`
									);
									const commitLink = repositoryURL
										? `<a href="${repositoryURL}/commit/${commit.hash}">${commit.hash}</a>`
										: commit.hash;
									md += `  <li>${formattedMessage} [ [${commitLink}] ]</li>\n`;
								}
							}
						}
					}
				}
			} catch (err) {
				console.error('Error generating changelog:', err);
				setError('Error generating changelog.');
			} finally {
				setLoading(false);
			}
		})();
	}, [config, format, repositoryURL, groupConfig, packageVersion]);

	return (
		<Box>
			{loading ? (
				<Text>Loading...</Text>
			) : error ? (
				<Text color="red">{error}</Text>
			) : (
				<Text>{changelogOutput}</Text>
			)}
		</Box>
	);
}
