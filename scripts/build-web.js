'use strict';

/**
 * 生成 Android/iOS 用的 Web 资源目录（www/）。
 *
 * renderer 的界面代码原样复用，只多注入一个 bridge.js：
 * 桌面端由 Electron preload 提供 window.api，WebView 里由它提供。
 */

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'renderer');
const OUT = path.join(ROOT, 'www');
const pkg = require(path.join(ROOT, 'package.json'));

function rimraf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

rimraf(OUT);
fs.mkdirSync(OUT, { recursive: true });

for (const f of ['app.js', 'quick-parse.js', 'styles.css']) {
  fs.copyFileSync(path.join(SRC, f), path.join(OUT, f));
}

let html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
if (!html.includes('<script src="bridge.js"></script>')) {
  html = html.replace(
    '<script src="quick-parse.js"></script>',
    '<script src="bridge.js"></script>\n  <script src="quick-parse.js"></script>'
  );
}
fs.writeFileSync(path.join(OUT, 'index.html'), html, 'utf8');

fs.copyFileSync(path.join(ROOT, 'assets', 'icon-256.png'), path.join(OUT, 'icon.png'));

esbuild.buildSync({
  entryPoints: [path.join(ROOT, 'src', 'web', 'bridge.js')],
  bundle: true,
  outfile: path.join(OUT, 'bridge.js'),
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  legalComments: 'none',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
});

console.log(`[web] 已生成 ${path.relative(ROOT, OUT)}/（bridge.js 已注入 index.html）`);
