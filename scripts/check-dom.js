'use strict';
// 开发期自检：app.js 里 $( 'id' ) 引用的元素必须在 index.html 里真的存在，
// 否则拼错一个 id 会在加载时抛错、整个渲染脚本直接死掉。

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'src', 'renderer', 'app.js'), 'utf8');

const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const used = [...new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]))];
const missing = used.filter((i) => !ids.has(i));

console.log(`HTML 里 id 共 ${ids.size} 个，app.js 引用 ${used.length} 个`);
if (missing.length) {
  console.error('❌ 找不到的 id：' + missing.join(', '));
  process.exit(1);
}
console.log('✅ 所有 $() 引用的 id 都存在');

// 外观控件数量：主题按钮 3 个、色块 7 个
const themeOpts = (html.match(/data-theme-opt=/g) || []).length;
const swatches = (html.match(/data-accent=/g) || []).length;
console.log(`主题按钮 ${themeOpts} 个，色块 ${swatches} 个`);
if (themeOpts !== 3 || swatches < 4) {
  console.error('❌ 外观控件数量不对');
  process.exit(1);
}

// 变量化的颜色：正文里不该再出现硬编码的十六进制色（变量定义块除外）
const css = fs.readFileSync(path.join(root, 'src', 'renderer', 'styles.css'), 'utf8')
  .replace(/:root[\s\S]*?\n\}\n/g, '')
  .replace(/\[data-theme='(dark|light)'\] \{[\s\S]*?\n\}\n/g, '');
const hex = [...new Set([...css.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0].toLowerCase()))]
  // #fff 是 --on-accent 的兜底值，#06281c 是绿勾上的字色，都是有意为之
  .filter((c) => !['#fff', '#06281c'].includes(c));
console.log(hex.length ? '⚠️ 正文里还有硬编码颜色：' + hex.join(', ') : '✅ 变量块之外没有硬编码颜色');
