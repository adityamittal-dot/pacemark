// Builds the downloadable packages into dist/:
//   dist/pacemark-extension/            unpacked Chrome extension (load it from chrome://extensions)
//   dist/pacemark-extension-vX.Y.Z.zip  the same, zipped for a release or the Chrome Web Store
//   dist/pacemark-app-vX.Y.Z.zip        the offline reader: unzip and open index.html
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const dist = join(root, "dist");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "extension/manifest.json"), "utf8"));

if (manifest.version !== version) {
  console.error(`Version mismatch: package.json is ${version}, extension/manifest.json is ${manifest.version}.`);
  process.exit(1);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);

// Extension = extension/ + the reader app (without the web-only install files).
const ext = join(dist, "pacemark-extension");
cpSync(join(root, "extension"), ext, { recursive: true });
cpSync(join(root, "app"), join(ext, "reader"), {
  recursive: true,
  filter: src => !/(sw\.js|manifest\.webmanifest)$/.test(src)
});

const app = join(dist, "pacemark-app");
cpSync(join(root, "app"), app, { recursive: true });

const zip = (dir, name) => {
  if (!existsSync(dir)) throw new Error(`missing ${dir}`);
  execFileSync("zip", ["-qr", join(dist, name), "."], { cwd: dir });
  console.log("  dist/" + name);
};
console.log(`Built Pacemark ${version}:`);
console.log("  dist/pacemark-extension/");
zip(ext, `pacemark-extension-v${version}.zip`);
zip(app, `pacemark-app-v${version}.zip`);
