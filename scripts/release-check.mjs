import { execFileSync } from 'node:child_process';

const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run release checks through npm run release:check');
const options = { stdio: 'inherit', env: { ...process.env, WM_AUTO_INSTALL_SKILL: '0' } };
for (const task of ['check', 'test', 'build']) execFileSync(process.execPath, [npm, 'run', task], options);
execFileSync(process.execPath, ['scripts/check-package.mjs'], options);
console.log('Release checks passed. A new package version on main is published by GitHub Actions.');
