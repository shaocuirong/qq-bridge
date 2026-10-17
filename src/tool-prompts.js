// 每组「提示词逻辑编写区」的存储与注入块拼装。
//
// 设计见 docs/design/QQ_TOOL_SUITES_PLAN.md §8：
//   - 落 state/tool-prompts.json，可热更新（改完不需要重启 DSH）
//   - 每组上限 MAX_GROUP_CHARS，注入总上限 MAX_TOTAL_CHARS
//   - 只注入"启用且组内至少一个 action 开"的组（由调用方传 activeGroups）
//
// 这里全是纯函数 + 少量文件 IO；不做鉴权（鉴权在 bridge 的接口层）。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { GROUPS, defaultPromptOf, actionEnabled, isNeverExposed, toolForAction, legacyToolEnabled } from './qq-tool-groups.js';
import { legacyToolsOfGroup } from './qq-tool-groups.js';
import { actionCatalog, actionReadOnly } from './tool-catalog.js';
import { suiteInputSchema } from './mcp-tool-suites.js';
import { defaultToolProtocol, resolveToolPrompt } from './tool-protocols.js';

export const MAX_GROUP_CHARS = 8000;
export const MAX_TOTAL_CHARS = 32000;
const TRUNCATED_SUFFIX = '\n…（已截断）';

export function promptsFilePath(root) {
  return path.join(root, 'state', 'tool-prompts.json');
}

/** 读文件；坏文件/不存在一律回退空对象（不抛，避免把桥接打挂）。 */
export function readPrompts(root) {
  try {
    const raw = fs.readFileSync(promptsFilePath(root), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function persist(root, prompts) {
  const file = promptsFilePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(prompts, null, 1)}\n`, 'utf8');
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
  return prompts;
}

/**
 * 补齐缺失组并落盘。幂等：已存在的组（含用户改过的文本）一律保留。
 * 首次启动会写入 16 组的默认文案。
 */
export function ensureDefaults(root, groups = GROUPS) {
  const current = readPrompts(root);
  let changed = false;
  const out = {};
  for (const g of groups) {
    const original = current[g.id];
    const existing = resolveToolPrompt(g, original);
    if (original?.protocolVersion !== 2) changed = true;
    if (existing && typeof existing === 'object' && typeof existing.text === 'string') {
      out[g.id] = {
        text: existing.text,
        enabled: existing.enabled !== false,
        updatedAt: Number.isFinite(existing.updatedAt) ? existing.updatedAt : Date.now(),
        protocolVersion: 2,
      };
    } else {
      out[g.id] = { text: defaultToolProtocol(g.id), enabled: true, updatedAt: Date.now(), protocolVersion: 2 };
      changed = true;
    }
  }
  return changed || Object.keys(current).length !== Object.keys(out).length ? persist(root, out) : out;
}

/**
 * 写一组的提示词。超长直接抛错且**不落盘**（调用方据此返回 400）。
 */
export function writePrompt(root, groupId, { text, enabled } = {}) {
  if (!GROUPS.some((g) => g.id === groupId)) {
    throw new Error(`未知的工具组：${groupId}`);
  }
  const value = String(text ?? '');
  if (value.length > MAX_GROUP_CHARS) {
    throw new Error(`提示词过长：${value.length} 字符，上限 ${MAX_GROUP_CHARS}`);
  }
  const current = readPrompts(root);
  const prev = current[groupId] ?? {};
  const next = {
    ...current,
    [groupId]: {
      text: value,
      enabled: enabled === undefined ? prev.enabled !== false : enabled === true,
      updatedAt: Date.now(),
      protocolVersion: 2,
    },
  };
  return persist(root, next);
}

/**
 * 拼注入块。纯函数：
 *   - 只取 activeGroups 里、且 enabled !== false、且 text 非空的组
 *   - 按 activeGroups 顺序累加
 *   - 超 MAX_TOTAL_CHARS 截断并加标记
 */
export function composePromptBlock(prompts, activeGroups) {
  const parts = [];
  for (const id of activeGroups ?? []) {
    const group = GROUPS.find(g => g.id === id);
    const entry = group ? resolveToolPrompt(group, prompts?.[id]) : prompts?.[id];
    if (!entry || entry.enabled === false) continue;
    const text = String(entry.text ?? '').trim();
    if (!text) continue;
    const label = GROUPS.find((g) => g.id === id)?.label ?? id;
    parts.push(`【${label}】\n${text}`);
  }
  const full = parts.join('\n\n');
  if (full.length <= MAX_TOTAL_CHARS) return full;
  return full.slice(0, Math.max(0, MAX_TOTAL_CHARS - TRUNCATED_SUFFIX.length)) + TRUNCATED_SUFFIX;
}

/** 与桥接限流使用同一份目录及写操作纠错。 */
export function isReadOnlyAction(action) {
  return actionReadOnly(action);
}

/** 读离线快照，给控制台抽屉提供 summary 与参数名（快照缺失时返回空表，不抛）。 */
export function loadCatalogMeta(root) {
  return actionCatalog(root);
}

/** 供控制台展示：每组当前文本 + 默认文本 + 该组动作及其开关状态。 */
export function promptsView(root, cfg) {
  return toolGroupsView(cfg, readPrompts(root), loadCatalogMeta(root));
}

/** 纯视图构造，控制台 API 与离线 fixture 共用；读取页面不会写运行状态。 */
export function toolGroupsView(cfg, prompts = {}, meta = actionCatalog()) {
  return GROUPS.map((g) => ({
    id: g.id,
    label: g.label,
    risk: g.risk,
    maxChars: MAX_GROUP_CHARS,
    text: resolveToolPrompt(g, prompts[g.id]).text,
    enabled: prompts[g.id]?.enabled !== false,
    defaultText: defaultToolProtocol(g.id),
    groupEnabled: cfg?.socialV2?.toolGroups?.[g.id]?.enabled === true,
    // 原有 40 个桥接工具（不是 OneBot action）：开关是旧的 camelCase flag，缺省即开。
    legacyTools: legacyToolsOfGroup(g.id).map((t) => ({
      name: t.name,
      flag: t.flag,
      description: t.description,
      configured: t.flag ? cfg?.socialV2?.tools?.[t.flag] !== false : true,
      enabled: legacyToolEnabled(cfg, t),
    })),
    mcpTools: [
      ...g.independentTools.map(t => ({ ...t, kind: 'independent' })),
      ...(g.channelTool ? [{ ...g.channelTool, kind: 'channel', actions: g.actions.filter(a => !isNeverExposed(a) && !g.independentTools.some(t => t.actions.includes(a))) }] : []),
    ].filter(t => t.actions.length).map(t => ({
      ...t, enabled: t.actions.some(a => actionEnabled(cfg, a)),
      enabledActions: t.actions.filter(a => actionEnabled(cfg, a)),
      inputSchema: suiteInputSchema({ ...t, actions: t.actions.some(a => actionEnabled(cfg, a)) ? t.actions.filter(a => actionEnabled(cfg, a)) : t.actions }),
    })),
    actions: g.actions.map((a) => ({
      action: a,
      summary: meta.get(a)?.summary ?? '',
      params: meta.get(a)?.params ?? [],
      parameters: meta.get(a)?.parameters ?? [],
      inputSchema: meta.get(a)?.inputSchema ?? null,
      invariants: meta.get(a)?.invariants ?? [],
      tool: toolForAction(a)?.name ?? null,
      toolKind: toolForAction(a)?.kind ?? null,
      enabled: cfg ? actionEnabled(cfg, a) : false,
      configured: cfg?.socialV2?.tools?.[a] === true,
      supported: !isNeverExposed(a) && !!toolForAction(a),
      never: isNeverExposed(a),
      readOnly: isReadOnlyAction(a),
    })),
  }));
}
