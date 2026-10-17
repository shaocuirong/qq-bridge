// 源码注释陷阱守卫。
//
// 背景（真实踩过）：好几个回归脚本为了"只看可执行代码"，用的是最朴素的块注释剥离
//   src.replace(/\/\*[\s\S]*?\*\//g, '')
// 它对**行注释里出现的 `/*` 序列**毫无抵抗力：一句
//   // 与 /api/send/* 的 agent 通道分开
// 里的 `/*` 会被当成块注释开头，于是从那一行一直吞到**后面第一个 `*/`**。
// 实测这一句让 bridge.js 的 6061~7782 行（1721 行真实代码）在剥离后凭空消失——
// 而依赖它的断言会**静默地**变成"看不到了所以通过/失败"，比直接报错危险得多
// （我自己就因此在 /api/persons 端点附近被误导过一次）。
//
// 这个文件把那类写法钉死在登记期：任何被朴素剥离器读过的源码，行注释里不得出现 `/*`/`*/`，
// 且剥离后不得出现跨 80 行的"块注释"（正常 JSDoc 不会那么长）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 会被「朴素块注释剥离器」读取的源码（新增此类脚本时请同步这里）。 */
const SCANNED = [
  'src/bridge.js',
  'src/mcp-snowluma-safe.js',
  'scripts/setup-dsh.mjs',
  'plugins/qq-mode-console/lib/index.js',
  'plugins/qq-agent-presets/qq-tool-restrict.mjs',
];

/** 与测试脚本里用的剥离规则一字不差，才能复现同一个陷阱。 */
const naiveStrip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '');

for (const rel of SCANNED) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) {
    console.log(`  ⏭  跳过（不存在）：${rel}`);
    continue;
  }
  const src = fs.readFileSync(file, 'utf8');

  const offenders = src
    .split(/\r?\n/)
    .map((line, i) => ({ line, no: i + 1 }))
    .filter(({ line }) => /\/\/.*\/\*/.test(line) || /\/\/.*\*\//.test(line))
    .map(({ line, no }) => `${rel}:${no} ${line.trim().slice(0, 70)}`);
  assert.deepEqual(
    offenders, [],
    `行注释里出现了 /* 或 */：朴素块注释剥离器会从它开始吞掉后面一大段真实代码。`
    + `请改写成不带 \`/*\` 的措辞（例如「/api/send 系列」）。\n${offenders.join('\n')}`,
  );

  const stripped = naiveStrip(src);
  const re = /\/\*[\s\S]*?\*\//g;
  const overlong = [];
  let match;
  while ((match = re.exec(src))) {
    const lines = match[0].split(/\r?\n/).length;
    if (lines > 80) overlong.push(`${rel}: 第 ${src.slice(0, match.index).split(/\r?\n/).length} 行起，块注释吞掉 ${lines} 行`);
  }
  assert.deepEqual(overlong, [], `剥离后的"块注释"跨度过大，说明有语句被误判成注释：\n${overlong.join('\n')}`);
}

console.log(`🎉 源码注释陷阱守卫通过（${SCANNED.length} 个文件：行注释无 /*，无超长"块注释"）`);
