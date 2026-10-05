// Builds dist/chrome and dist/firefox from one source tree.
//   node scripts/build.mjs           build both
//   node scripts/build.mjs --watch   rebuild on change
//   node scripts/build.mjs --zip     build and pack both into dist/*.zip
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const watch = process.argv.includes('--watch');
const zip = process.argv.includes('--zip');

const X_HOSTS = ['https://x.com/*', 'https://twitter.com/*', 'https://mobile.x.com/*', 'https://mobile.twitter.com/*'];

function manifest(target) {
  const m = {
    manifest_version: 3,
    name: 'Clever Filter for X',
    short_name: 'Clever Filter',
    version: pkg.version,
    description: 'Checks posts on X with a decision model and hides, bookmarks or likes them by your rules.',
    icons: { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png', 128: 'icons/128.png' },
    action: {
      default_title: 'Clever Filter',
      default_popup: 'popup.html',
      default_icon: { 16: 'icons/16.png', 32: 'icons/32.png' },
    },
    options_ui: { page: 'options.html', open_in_tab: true },
    permissions: ['storage', 'declarativeNetRequestWithHostAccess'],
    host_permissions: [
      ...X_HOSTS,
      'https://api.typesafe.ai/*',
      'http://127.0.0.1/*',
      'http://localhost/*',
    ],
    // Your own server: asked for in Settings when you enter its address.
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    content_scripts: [
      {
        matches: X_HOSTS,
        js: ['content.js'],
        css: ['content.css'],
        run_at: 'document_idle',
      },
    ],
  };
  if (target === 'chrome') {
    m.background = { service_worker: 'background.js' };
    m.minimum_chrome_version = '121';
  } else {
    m.background = { scripts: ['background.js'] };
    m.browser_specific_settings = {
      gecko: {
        id: 'clever-filter@hasanselcuk',
        strict_min_version: '128.0',
        data_collection_permissions: { required: ['websiteContent'] },
      },
    };
  }
  return m;
}

const entries = {
  background: 'src/background/index.ts',
  content: 'src/content/index.ts',
  options: 'src/options/index.ts',
  popup: 'src/popup/index.ts',
};

const STATIC = ['options.html', 'popup.html', 'ui.css', 'options.css', 'popup.css', 'content.css', 'icons'];

function writeStatic() {
  for (const target of ['chrome', 'firefox']) {
    const out = join(root, 'dist', target);
    mkdirSync(out, { recursive: true });
    for (const f of STATIC) cpSync(join(root, 'static', f), join(out, f), { recursive: true });
    writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest(target), null, 2) + '\n');
  }
}

const copyToFirefox = {
  name: 'copy-to-firefox',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length) return;
      cpSync(join(root, 'dist/chrome'), join(root, 'dist/firefox'), {
        recursive: true,
        filter: (src) => !src.endsWith('manifest.json'),
      });
      writeStatic();
      if (watch) console.log(`[${new Date().toLocaleTimeString()}] built`);
    });
  },
};

const options = {
  absWorkingDir: root,
  entryPoints: entries,
  outdir: 'dist/chrome',
  bundle: true,
  format: 'iife',
  target: ['chrome121', 'firefox128'],
  sourcemap: watch ? 'inline' : false,
  logLevel: 'warning',
  plugins: [copyToFirefox],
};

rmSync(join(root, 'dist'), { recursive: true, force: true });

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('Watching for changes…');
} else {
  await esbuild.build(options);
  if (zip) {
    for (const target of ['chrome', 'firefox']) {
      const file = join(root, 'dist', `clever-filter-${target}-${pkg.version}.zip`);
      execFileSync('zip', ['-qr', file, '.'], { cwd: join(root, 'dist', target) });
      console.log(`Packed ${file}`);
    }
  }
  console.log('Built dist/chrome and dist/firefox');
}
