#!/usr/bin/env node
// 刷新 _snowluma-catalog.json（SnowLuma OneBot action 目录的离线快照）。
//
// 背景：仓库里这份快照长期无人维护，也无人引用，于是静默落后于版本
// （2026-10-17 实测：本地 190 条 / 只读 77，线上 1.14.22 是 198 / 80）。
// 本脚本把"手工抄 action 参数名"这件事变成一条命令，并给出与桥接工具面的差额。
//
// 数据源（按顺序尝试，全部无需 CDN 也能离线工作）：
//   1. 本地 node_modules 里已安装的 @snowluma/mcp（读 dist/generated/catalog.js）
//   2. unpkg / jsdelivr / esm.sh 上的同名文件（需要外网）
//
// 用法：
//   node scripts/refresh-snowluma-catalog.mjs              # 重新生成 _snowluma-catalog.json
//   node scripts/refresh-snowluma-catalog.mjs --check      # 只比对，有漂移则退出码 1（给 CI/审计用）
//   node scripts/refresh-snowluma-catalog.mjs --stdout     # 打印，不落盘
//   node scripts/refresh-snowluma-catalog.mjs --gaps       # 生成后打印「只读但桥接未暴露」的清单
//   node scripts/refresh-snowluma-catalog.mjs --version 1.14.22
//
// 输出格式保持仓库既有形状（1 空格缩进的数组），每条只留 {name, readOnly, summary, params}：
// params 是"参数名字符串数组"，够写 zod schema 用；完整 JSON Schema 请查官方 get_action。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '_snowluma-catalog.json');
const BRIDGE_MCP = path.join(ROOT, 'src', 'mcp-snowluma-safe.js');
const PKG = '@snowluma/mcp';

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const opt = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const MODE = has('--check') ? 'check' : has('--stdout') ? 'stdout' : 'write';
const VERSION = opt('--version', 'latest');

// ── 1. 取目录 ────────────────────────────────────────────────────────────────

/** 从 catalog.js 的源码里抠出 `export const ACTIONS = [...]` 的数组字面量。 */
function parseCatalogSource(code) {
  const cut = code.indexOf('export const CATEGORIES');
  const head = cut >= 0 ? code.slice(0, cut) : code;
  const start = head.indexOf('[');
  if (start < 0) throw new Error('catalog.js 里没找到 ACTIONS 数组');
  let body = head.slice(start).trim();
  if (body.endsWith(';')) body = body.slice(0, -1).trim();
  if (!body.endsWith(']')) throw new Error('ACTIONS 数组没有被正确闭合');
  return JSON.parse(body);
}

function localCatalogPath() {
  // 允许在没装依赖时也跑：先看常见位置
  const guesses = [
    path.join(ROOT, 'node_modules', PKG, 'dist', 'generated', 'catalog.js'),
    path.join(process.cwd(), 'node_modules', PKG, 'dist', 'generated', 'catalog.js'),
  ];
  return guesses.find((p) => fs.existsSync(p)) ?? null;
}

async function fetchText(url) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  return { text, resolved: res.url || url };
}

// 顺序很重要：**远端优先、本地兜底**。
// 反过来（本地优先）会踩本仓库的老坑：node_modules 里躺着 @snowluma/mcp@1.14.20，
// 而运行中的 SnowLuma 是 1.14.22 —— 本地优先就永远刷回 195 条，快照继续静默落后。
async function loadActions() {
  const local = localCatalogPath();
  const errors = [];

  if (!has('--local')) {
    const urls = [
      `https://unpkg.com/${PKG}@${VERSION}/dist/generated/catalog.js`,
      `https://cdn.jsdelivr.net/npm/${PKG}@${VERSION}/dist/generated/catalog.js`,
      `https://esm.sh/${PKG}@${VERSION}/dist/generated/catalog.js`,
    ];
    for (const url of urls) {
      try {
        const { text, resolved } = await fetchText(url);
        const actions = parseCatalogSource(text);
        if (!Array.isArray(actions) || actions.length === 0) throw new Error('空目录');
        const m = /@(\d+\.\d+\.\d+)/.exec(resolved);
        return { actions, from: resolved, version: m ? m[1] : VERSION };
      } catch (error) {
        errors.push(`${url} → ${error?.message ?? error}`);
      }
    }
  }

  if (local) {
    const version = readLocalVersion();
    if (VERSION !== 'latest' && version !== VERSION) {
      throw new Error(`无法获取指定目录 ${VERSION}；本地只有 ${version}，拒绝把快照降级。\n${errors.join('\n')}`);
    }
    const notes = [];
    if (VERSION !== 'latest' && version !== VERSION) notes.push(`要的是 ${VERSION}，本地是 ${version}`);
    if (errors.length) notes.push('远端取不到，已回退本地');
    if (notes.length) console.error(`⚠ ${notes.join('；')}`);
    return { actions: parseCatalogSource(fs.readFileSync(local, 'utf8')), from: local, version };
  }

  throw new Error(`取不到 action 目录（没有外网，也没装 ${PKG}）：\n  ${errors.join('\n  ')}`);
}

function readLocalVersion() {
  for (const base of [ROOT, process.cwd()]) {
    const p = path.join(base, 'node_modules', PKG, 'package.json');
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8')).version ?? 'unknown';
    } catch {}
  }
  return 'local';
}

/** 全量目录 → 仓库快照格式。keep 只保留稳定字段，避免每次刷新都产生无意义 diff。 */
function toSnapshot(actions) {
  return actions.map((a) => ({
    name: String(a.name),
    readOnly: a.readOnly === true,
    summary: String(a.summary ?? ''),
    params: Array.isArray(a.params) ? a.params.map((p) => String(p?.name ?? p)) : [],
    parameters: Array.isArray(a.params) ? a.params.filter((p) => p && typeof p === 'object') : [],
    inputSchema: a.inputSchema ?? null,
    invariants: a.invariants ?? [],
    category: a.category ?? '',
  }));
}

const serialize = (snapshot) => `${JSON.stringify(snapshot, null, 1)}\n`;

// ── 2. 与既有快照比对 ────────────────────────────────────────────────────────

function diffSnapshots(prev, next) {
  const before = new Map((prev ?? []).map((a) => [a.name, a]));
  const after = new Map(next.map((a) => [a.name, a]));
  const added = next.filter((a) => !before.has(a.name)).map((a) => a.name);
  const removed = (prev ?? []).filter((a) => !after.has(a.name)).map((a) => a.name);
  const changed = [];
  for (const [name, b] of before) {
    const a = after.get(name);
    if (!a) continue;
    const fields = [];
    if (a.readOnly !== b.readOnly) fields.push(`readOnly ${b.readOnly}→${a.readOnly}`);
    if (a.summary !== b.summary) fields.push('summary');
    if (a.params.join(',') !== b.params.join(',')) fields.push(`params [${b.params}]→[${a.params}]`);
    if (JSON.stringify(a.inputSchema) !== JSON.stringify(b.inputSchema)) fields.push('inputSchema');
    if (JSON.stringify(a.parameters) !== JSON.stringify(b.parameters)) fields.push('parameters');
    if (fields.length) changed.push(`${name}: ${fields.join('; ')}`);
  }
  return { added, removed, changed };
}

// ── 3. 桥接工具面 vs 只读 action ─────────────────────────────────────────────

// 40 个 qq_* 工具里，真正落到 OneBot action 的只有这几个；其余全打桥接自己的 /api/socialV2/*。
const TOOL_ACTIONS = {
  qq_status: ['get_login_info', 'get_status'],
  qq_list_groups: ['get_group_list'],
  qq_get_group_members: ['get_group_member_list'],
  qq_get_group_history: ['get_group_msg_history'],
};

function bridgeToolNames() {
  try {
    const src = fs.readFileSync(BRIDGE_MCP, 'utf8');
    return [...src.matchAll(/server\.tool\(\s*\n?\s*'([a-z_]+)'/g)].map((m) => m[1]).sort();
  } catch {
    return [];
  }
}

// ── 目录自带的 readOnly 字段不能全信 ─────────────────────────────────────────
//
// 2026-10-17 用 1.14.22 实测：`send_ark_share` / `send_group_ark_share` / `share_peer` /
// `share_group_ex` 四个**会真的把 Ark 卡片发进会话**的 action 都被标成 readOnly: true。
// 谁要是"按 readOnly 过滤出一个安全集合"直接当工具面用，就等于把发消息能力挂成了只读工具。
// 所以任何基于 readOnly 的自动化都必须再过一遍名字启发式，冲突项单独列出来人工确认。
const WRITE_NAME_RE = /^(send_|share_|set_|delete_|del_|add_|create_|upload_|download_|move_|rename_|clean_|mark_|click_|trans_|bot_|_del|_send|_set|_mark)/;

function readOnlyConflicts(snapshot) {
  return snapshot.filter((a) => a.readOnly && WRITE_NAME_RE.test(a.name));
}

function printGaps(snapshot) {
  const tools = bridgeToolNames();
  const covered = new Set(Object.values(TOOL_ACTIONS).flat());
  const readOnly = snapshot.filter((a) => a.readOnly);
  const rest = readOnly.filter((a) => !covered.has(a.name));

  console.log('');
  console.log('── 桥接工具面 vs SnowLuma 只读 action ──────────────────────');
  console.log(`快照：${snapshot.length} 个 action（只读 ${readOnly.length}）`);
  console.log(`桥接注册的工具：${tools.length} 个（其中落到裸 action 的 ${Object.keys(TOOL_ACTIONS).length} 个）`);
  for (const [tool, actions] of Object.entries(TOOL_ACTIONS)) {
    const mark = tools.includes(tool) ? '✓' : '✗ 已不存在';
    console.log(`  ${mark} ${tool} → ${actions.join(', ')}`);
  }
  console.log(`只读但没有对应工具：${rest.length} 个`);

  const conflicts = readOnlyConflicts(snapshot);
  if (conflicts.length) {
    console.log(`\n⚠ readOnly 与名字语义冲突（${conflicts.length} 个，别当只读用）：`);
    for (const a of conflicts) console.log(`  ${a.name} — ${a.summary || '(无摘要)'}`);
  }

  const byCategory = new Map();
  for (const a of rest) {
    const key = guessCategory(a.name);
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key).push(a);
  }
  for (const [cat, list] of [...byCategory].sort((x, y) => y[1].length - x[1].length)) {
    console.log(`\n[${cat}] ${list.length}`);
    for (const a of list) {
      const params = a.params.length ? ` (${a.params.join(', ')})` : '';
      console.log(`  ${a.name}${params} — ${a.summary || '(无摘要)'}`);
    }
  }
}

/** 快照里没有 category 字段（保持与旧文件一致），报告里按名字粗分一下组。 */
function guessCategory(name) {
  if (/qzone/.test(name)) return '空间';
  if (/album/.test(name)) return '群相册';
  if (/group_file|folder|fileset|flash/.test(name)) return '群文件/闪传';
  if (/essence|todo|notice|admin|tag|silk|sign|title/.test(name)) return '群管理';
  if (/custom_face|emoji|sys_face|face/.test(name)) return '表情';
  if (/forward|msg|message|history|record|ptt/.test(name)) return '消息';
  if (/friend|stranger|profile|dress|like/.test(name)) return '好友/资料';
  if (/group/.test(name)) return '群信息';
  return '其它';
}

// ── 4. main ─────────────────────────────────────────────────────────────────

const { actions, from, version } = await loadActions();
const snapshot = toSnapshot(actions);

let prev = null;
try {
  prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
} catch {}

const diff = diffSnapshots(prev, snapshot);
if (MODE === 'write' && diff.removed.length && !has('--allow-removed')) {
  throw new Error(`目录将删除 ${diff.removed.length} 个动作，拒绝自动覆盖。确认版本后用 --allow-removed 显式接受。`);
}
const text = serialize(snapshot);

console.log(`来源：${from}`);
console.log(`版本：${version}｜action ${snapshot.length} 个（只读 ${snapshot.filter((a) => a.readOnly).length}）`);

if (MODE === 'check') {
  if (!prev) {
    console.error(`✗ ${path.relative(ROOT, OUT)} 不存在或不是合法 JSON`);
    process.exit(1);
  }
  const drift = diff.added.length + diff.removed.length + diff.changed.length;
  if (!drift) {
    console.log('✓ 快照与当前版本一致');
    process.exit(0);
  }
  console.error(`✗ 快照已过期：新增 ${diff.added.length} / 删除 ${diff.removed.length} / 变更 ${diff.changed.length}`);
  for (const n of diff.added) console.error(`  + ${n}`);
  for (const n of diff.removed) console.error(`  - ${n}`);
  for (const n of diff.changed) console.error(`  ~ ${n}`);
  console.error('  运行 node scripts/refresh-snowluma-catalog.mjs 更新');
  process.exit(1);
}

if (MODE === 'stdout') {
  process.stdout.write(text);
} else {
  fs.writeFileSync(OUT, text, 'utf8');
  const rel = path.relative(ROOT, OUT);
  const bits = [];
  if (diff.added.length) bits.push(`+${diff.added.length}`);
  if (diff.removed.length) bits.push(`-${diff.removed.length}`);
  if (diff.changed.length) bits.push(`~${diff.changed.length}`);
  console.log(`✓ 已写入 ${rel}${bits.length ? `（${bits.join(' ')}）` : '（无变化）'}`);
  for (const n of diff.added) console.log(`  + ${n}`);
  for (const n of diff.removed) console.log(`  - ${n}`);
  for (const n of diff.changed) console.log(`  ~ ${n}`);
}

if (has('--gaps')) printGaps(snapshot);
