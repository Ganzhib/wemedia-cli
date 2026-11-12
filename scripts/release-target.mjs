import { readFile } from 'node:fs/promises';

const { name, version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
const response = await fetch(url);
if (!response.ok && response.status !== 404) {
  throw new Error(`Could not check npm version: HTTP ${response.status}`);
}

const tag = version.includes('-') ? version.split('-')[1].split('.')[0] : 'latest';
console.log(`publish=${response.status === 404}`);
console.log(`tag=${tag}`);
