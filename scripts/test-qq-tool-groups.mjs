// Task 1 测试：工具组注册表。
// 运行：node scripts/test-qq-tool-groups.mjs   （失败退出码 1，风格与 scripts/test-*.mjs 一致）
import fs from 'node:fs';
import assert from 'node:assert/strict';

const REG = new URL('../src/qq-tool-groups.js', import.meta.url);
const CAT = new URL('../_snowluma-catalog.json', import.meta.url);

let pass = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (error) { console.log(`  ✗ ${name}\n    ${error?.message ?? error}`); process.exitCode = 1; }
};

const {
  GROUPS, NEVER_EXPOSED, groupOfAction, actionsOfGroup, isNeverExposed,
  actionEnabled, toolsToRegister, normalizeToolGroups, defaultConfig, ALL_LEGACY_TOOLS,
} = await import(REG);

const catalog = JSON.parse(fs.readFileSync(CAT, 'utf8'));
const catalogNames = catalog.map((a) => a.name).sort();

console.log('Task 1: 工具组注册表');

ok('16 个组，组 id 唯一', () => {
  assert.equal(GROUPS.length, 19);
  assert.equal(new Set(GROUPS.map((g) => g.id)).size, 19);
});

ok('action 并集 = 目录 198 个，且无重复', () => {
  const all = GROUPS.flatMap((g) => g.actions);
  assert.equal(new Set(all).size, all.length, '组间存在重复 action');
  assert.deepEqual([...all].sort(), catalogNames);
});

ok('每个 action 都能反查到唯一组', () => {
  for (const name of catalogNames) assert.ok(groupOfAction(name), `${name} 没有归属组`);
});

ok('never 组（credential / placeholder）没有任何工具', () => {
  for (const g of GROUPS.filter((x) => x.risk === 'never')) {
    assert.equal(g.independentTools.length, 0, `${g.id} 不应有独立工具`);
    assert.equal(g.channelTool, null, `${g.id} 不应有通道工具`);
  }
});

ok('原有 40 个桥接工具全部归组，且不重名', () => {
  assert.equal(ALL_LEGACY_TOOLS.length, 40);
  assert.equal(new Set(ALL_LEGACY_TOOLS.map((t) => t.name)).size, 40);
  for (const t of ALL_LEGACY_TOOLS) assert.ok(GROUPS.some((g) => g.id === t.group), `${t.name} 的组不存在`);
  for (const g of ['memory', 'slang', 'wake']) assert.ok(GROUPS.some((x) => x.id === g) && GROUPS.find((x) => x.id === g).actions.length === 0, `${g} 应为纯旧工具组`);
});

ok('默认 cfg → 新增工具注册数为 0', () => {
  assert.deepEqual(toolsToRegister(defaultConfig()), []);
  assert.deepEqual(toolsToRegister({}), []);
});

ok('开 groupInfo + 单个 action → 只出对应独立工具，不出其它组通道', () => {
  const cfg = defaultConfig();
  cfg.socialV2.toolGroups.groupInfo.enabled = true;
  cfg.socialV2.tools.get_group_info = true;
  const tools = toolsToRegister(cfg);
  const names = tools.map((t) => t.name);
  assert.deepEqual(names, ['qq_get_group_profile']);
  assert.equal(tools[0].kind, 'independent');
  assert.equal(tools[0].mode, 'A');
});

ok('组开但组内 action 全关 → 通道工具也不注册', () => {
  const cfg = defaultConfig();
  cfg.socialV2.toolGroups.groupAdmin.enabled = true;
  assert.deepEqual(toolsToRegister(cfg), []);
});

ok('组开 + 一个写 action 开 → 通道工具出现，白名单只含已启用 action', () => {
  const cfg = defaultConfig();
  cfg.socialV2.toolGroups.groupAdmin.enabled = true;
  cfg.socialV2.tools.set_group_kick = true;
  const channel = toolsToRegister(cfg).find((t) => t.kind === 'channel');
  assert.equal(channel.name, 'qq_group_admin_invoke');
  assert.deepEqual(channel.actions, ['set_group_kick']);
});

ok('never 清单中的 action 即使组开 + action 开也不启用（Review Focus 2）', () => {
  const cfg = defaultConfig();
  cfg.socialV2.toolGroups.groupAdmin.enabled = true;
  cfg.socialV2.tools.set_group_anonymous = true;
  assert.equal(isNeverExposed('set_group_anonymous'), true);
  assert.equal(actionEnabled(cfg, 'set_group_anonymous'), false);
  assert.ok(!toolsToRegister(cfg).some((t) => t.actions.includes('set_group_anonymous')));
});

ok('旧 flag 不影响新 action 判定（Review Focus 5）', () => {
  const cfg = defaultConfig();
  cfg.socialV2.tools.sendMessage = true; // 旧 flag，对应桥接工具而非 action
  cfg.socialV2.toolGroups.send.enabled = true;
  assert.equal(actionEnabled(cfg, 'send_group_msg'), false);
});

ok('normalizeToolGroups 只接受布尔，非布尔回落 false，且保留其它组', () => {
  const current = normalizeToolGroups(undefined, undefined);
  assert.equal(Object.keys(current).length, 19);
  assert.equal(Object.values(current).every((v) => v.enabled === false), true);

  const next = normalizeToolGroups(
    { ...current, groupInfo: { enabled: true } },
    { groupAdmin: { enabled: 1 }, album: { enabled: 'yes' }, qzone: { enabled: true } },
  );
  assert.equal(next.groupInfo.enabled, true);
  assert.equal(next.qzone.enabled, true);
  assert.equal(next.groupAdmin.enabled, false);
  assert.equal(next.album.enabled, false);
});

console.log(pass === 12 ? `\n✓ 12/12 passed` : `\n✗ ${pass}/12 passed`);
if (pass !== 12) process.exitCode = 1;
