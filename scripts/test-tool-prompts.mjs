// Task 2 测试：提示词存储与注入块。
// 运行：node scripts/test-tool-prompts.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const MOD = new URL('../src/tool-prompts.js', import.meta.url);
const { GROUPS, defaultConfig, toolForAction } = await import(new URL('../src/qq-tool-groups.js', import.meta.url));

let pass = 0, total = 0;
const ok = (name, fn) => {
  total++;
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (error) { console.log(`  ✗ ${name}\n    ${error?.message ?? error}`); process.exitCode = 1; }
};

const {
  MAX_GROUP_CHARS, MAX_TOTAL_CHARS, promptsFilePath,
  ensureDefaults, readPrompts, writePrompt, writePromptSelection, composePromptBlock, promptsView,
} = await import(MOD);

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qq-prompts-'));

console.log('Task 2: 提示词存储');

ok('空目录 → 补齐 19 组，含 text/enabled/updatedAt', () => {
  const root = tmp();
  const prompts = ensureDefaults(root);
  assert.equal(Object.keys(prompts).length, 19);
  for (const g of GROUPS) {
    assert.equal(typeof prompts[g.id].text, 'string');
    assert.equal(prompts[g.id].enabled, true);
    assert.equal(typeof prompts[g.id].updatedAt, 'number');
  }
  assert.ok(fs.existsSync(promptsFilePath(root)));
});

ok('再次补齐是幂等的（不覆盖用户文本）', () => {
  const root = tmp();
  ensureDefaults(root);
  writePrompt(root, 'groupInfo', { text: '自定义文案' });
  const again = ensureDefaults(root);
  assert.equal(again.groupInfo.text, '自定义文案');
  assert.equal(readPrompts(root).groupInfo.text, '自定义文案');
});

ok('超过 MAX_GROUP_CHARS 抛错，且文件未被改写（Review Focus 4）', () => {
  const root = tmp();
  ensureDefaults(root);
  const before = readPrompts(root).groupInfo.text;
  assert.throws(() => writePrompt(root, 'groupInfo', { text: 'x'.repeat(MAX_GROUP_CHARS + 1) }), new RegExp(String(MAX_GROUP_CHARS)));
  assert.equal(readPrompts(root).groupInfo.text, before);
});

ok('composePromptBlock 只含传入的启用组（Review Focus 4）', () => {
  const root = tmp();
  const prompts = ensureDefaults(root);
  const block = composePromptBlock(prompts, ['groupInfo']);
  assert.ok(block.includes(prompts.groupInfo.text.trim().slice(0, 10)));
  assert.ok(!block.includes(prompts.groupAdmin.text.trim().slice(0, 10)));
});

ok('enabled:false 的组不注入', () => {
  const root = tmp();
  ensureDefaults(root);
  writePrompt(root, 'groupInfo', { text: '不该出现', enabled: false });
  const block = composePromptBlock(readPrompts(root), ['groupInfo']);
  assert.ok(!block.includes('不该出现'));
});

ok('批量选择只改注入开关，保留正文；空选择、重新启用及非法输入均正确', () => {
  const root = tmp();
  ensureDefaults(root); writePrompt(root, 'memory', { text: '保留自定义记忆协议' });
  writePromptSelection(root, ['memory']);
  const selected = readPrompts(root);
  assert.equal(selected.memory.text, '保留自定义记忆协议');
  assert.equal(selected.wake.enabled, false);
  assert.equal(composePromptBlock(selected, ['memory', 'wake']), '【记忆与人物】\n保留自定义记忆协议');
  const before = fs.readFileSync(promptsFilePath(root), 'utf8');
  for (const bad of [null, 'memory', ['unknown'], [null]]) assert.throws(() => writePromptSelection(root, bad));
  assert.equal(fs.readFileSync(promptsFilePath(root), 'utf8'), before);
  writePromptSelection(root, []); assert.equal(composePromptBlock(readPrompts(root), ['memory', 'wake']), '');
  writePromptSelection(root, ['memory']); assert.equal(readPrompts(root).memory.text, '保留自定义记忆协议');
});

ok('总长超 MAX_TOTAL_CHARS 时截断并标记（Review Focus 4）', () => {
  const prompts = {};
  for (const g of GROUPS) prompts[g.id] = { text: 'y'.repeat(MAX_GROUP_CHARS), enabled: true, updatedAt: 1 };
  const block = composePromptBlock(prompts, GROUPS.map((g) => g.id));
  assert.ok(block.length <= MAX_TOTAL_CHARS + 32, `实际 ${block.length}`);
  assert.ok(block.endsWith('（已截断）'), block.slice(-20));
});
ok('抽屉数据：每个 action 带 summary / params / 所属工具', () => {
  const root = tmp();
  const cfg = defaultConfig();
  cfg.socialV2.toolGroups.groupInfo.enabled = true;
  cfg.socialV2.tools.get_group_info = true;
  const view = promptsView(root, cfg);
  const gi = view.find((g) => g.id === 'groupInfo');
  const info = gi.actions.find((a) => a.action === 'get_group_info');
  assert.ok(info.summary && info.summary.length > 0, 'summary 为空');
  assert.ok(Array.isArray(info.params), 'params 不是数组');
  assert.equal(info.tool, 'qq_get_group_profile');
  assert.equal(info.enabled, true);
  const kick = view.find((g) => g.id === 'groupAdmin').actions.find((a) => a.action === 'set_group_kick');
  assert.equal(kick.tool, 'qq_group_admin_invoke');
  assert.equal(kick.readOnly, false);
});

ok('每组带 legacyTools，旧 flag 缺省即开', () => {
  const root = tmp();
  const cfg = defaultConfig();
  const view = promptsView(root, cfg);
  const all = view.flatMap((g) => g.legacyTools);
  assert.equal(all.length, 41);
  assert.equal(all.filter(t => t.flag !== 'sendVoice' && t.flag !== 'setStickerRemark').every(t => t.enabled === true), true);
  assert.equal(all.find(t => t.name === 'qq_send_voice').enabled, false);
  assert.equal(all.find(t => t.name === 'qq_set_sticker_remark').enabled, false);
  cfg.socialV2.tools.sendMessage = false;
  const again = promptsView(root, cfg).flatMap((g) => g.legacyTools).find((t) => t.name === 'qq_send_message');
  assert.equal(again.enabled, false);
});

ok('toolForAction：独立工具优先，其余落到通道工具', () => {
  assert.deepEqual(toolForAction('get_group_info'), { kind: 'independent', name: 'qq_get_group_profile' });
  assert.deepEqual(toolForAction('set_group_kick'), { kind: 'channel', name: 'qq_group_admin_invoke' });
  assert.equal(toolForAction('no_such_action'), null);
});

const NL = String.fromCharCode(10);
console.log(NL + (pass === total ? '✓ ' : '✗ ') + pass + '/' + total + ' passed');
if (pass !== total) process.exitCode = 1;
