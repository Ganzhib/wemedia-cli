import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const metadata = JSON.parse(await readFile("package.json", "utf8"));
const output = "site-dist";
await rm(output, { recursive: true, force: true });
await cp("site", output, { recursive: true });
const schema = JSON.parse(execFileSync(process.execPath, ['dist/wm.js', 'schema', '--json'], { encoding: 'utf8', env: { ...process.env, WM_AUTO_INSTALL_SKILL: '0' } }));
await writeFile(join(output, 'catalog.json'), JSON.stringify({ version: metadata.version, platforms: schema.data.platforms }));
for (const name of ["index.html", "app.js"]) {
  const path = join(output, name);
  const content = (await readFile(path, "utf8"))
    .replaceAll("{{PACKAGE_NAME}}", metadata.name)
    .replaceAll("{{VERSION}}", metadata.version);
  await writeFile(path, content);
}
// Tie HTML to its exact assets so a cached old script cannot operate a new page structure.
let index = await readFile(join(output, 'index.html'), 'utf8');
for (const asset of ['app.js', 'styles.css']) {
  const content = await readFile(join(output, asset));
  const digest = createHash('sha256').update(content).digest('hex').slice(0, 12);
  const file = asset.replace('.', `.${digest}.`);
  await writeFile(join(output, file), content);
  index = index.replace(`"./${asset}"`, `"./${file}"`);
}
await writeFile(join(output, 'index.html'), index);
await mkdir(join(output, "examples"), { recursive: true });
await cp("examples", join(output, "examples"), { recursive: true });
await cp("skills/wm", join(output, "skill"), { recursive: true });
await writeFile(join(output, ".nojekyll"), "");
console.log(`Built GitHub Pages for ${metadata.name}@${metadata.version}`);
