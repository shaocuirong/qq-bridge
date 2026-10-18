// 全局协议保留在 preset persona；工具组私有协议独立存放并按配置内联。
import fs from 'node:fs';
import { GROUPS, actionEnabled, legacyToolEnabled, slangContextEnabled } from './qq-tool-groups.js';

const DIRECTORY = new URL('../prompts/tools/', import.meta.url);
export function defaultToolProtocol(groupId) {
  const group = GROUPS.find(g => g.id === groupId);
  if (!group) throw new Error(`未知工具组：${groupId}`);
  try { return fs.readFileSync(new URL(`${groupId}.md`, DIRECTORY), 'utf8').trim(); }
  catch { return group.defaultPrompt || ''; }
}

export function activeToolGroups(cfg) {
  return GROUPS.filter(g => g.risk !== 'never'
    // 黑话组是纯 legacy 提示词组：组开关必须同时控制【黑话】协议是否注入。
    // 其它 legacy 组（send/wake 等）的协议另有独立运行路径，保持原行为不变。
    && (g.id !== 'slang' || slangContextEnabled(cfg))
    && (g.actions.some(a => actionEnabled(cfg, a)) || (g.legacyTools ?? []).some(t => legacyToolEnabled(cfg, t)))
  ).map(g => g.id);
}

export function resolveToolPrompt(group, entry) {
  const standard = defaultToolProtocol(group.id);
  if (!entry || typeof entry.text !== 'string') return { text: standard, enabled: true, protocolVersion: 2 };
  if (entry.protocolVersion === 2) return entry;
  // 旧版每组只有一段用法备注。迁移时补上抽离出的协议，并保留管理员原有备注。
  const custom = entry.text.trim() && entry.text.trim() !== group.defaultPrompt?.trim();
  return { ...entry, protocolVersion: 2, text: standard + (custom ? `\n\n【管理员补充】\n${entry.text}` : '') };
}
