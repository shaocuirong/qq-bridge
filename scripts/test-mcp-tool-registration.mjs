// Task 6 测试：MCP 侧工具套件的参数规格与 action 解析。
// （注册期过滤本身由 test-qq-tool-groups.mjs 覆盖；这里锁死"工具→参数→action"的映射。）
import assert from 'node:assert/strict';
import {
  GROUPS, TOOL_PARAMS, resolveToolAction, actionParamsFrom, toolByName,
  toolsToRegister, defaultConfig,
} from '../src/qq-tool-groups.js';

let pass = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}\n    ${e?.message ?? e}`); process.exitCode = 1; }
};

const independent = GROUPS.flatMap((g) => g.independentTools);

console.log('Task 6: MCP 工具套件注册');

ok('每个独立工具都有参数规格', () => {
  for (const t of independent) assert.ok(TOOL_PARAMS[t.name], `${t.name} 缺 TOOL_PARAMS`);
});

ok('描述长度 ≤ 200（token 预算约束）', () => {
  const all = [...independent, ...GROUPS.map((g) => g.channelTool).filter(Boolean)];
  for (const t of all) assert.ok(t.description.length <= 200, `${t.name} 描述 ${t.description.length} 字`);
});

ok('resolveToolAction 只返回该工具声明过的 action', () => {
  for (const t of independent) {
    const resolved = resolveToolAction(t.name, {});
    assert.ok(t.actions.includes(resolved), `${t.name} → ${resolved} 不在 ${t.actions}`);
  }
});

ok('多 action 工具按参数分流', () => {
  assert.equal(resolveToolAction('qq_get_group_profile', {}), 'get_group_info');
  assert.equal(resolveToolAction('qq_get_group_profile', { detail: true }), 'get_group_detail_info');
  assert.equal(resolveToolAction('qq_get_friend_list', { grouped: true }), 'get_friends_with_category');
  assert.equal(resolveToolAction('qq_forward_msg', { groupId: '1' }), 'forward_group_single_msg');
  assert.equal(resolveToolAction('qq_forward_msg', { userId: '1' }), 'forward_friend_single_msg');
  assert.equal(resolveToolAction('qq_can_send', { voice: true }), 'can_send_record');
  assert.equal(resolveToolAction('qq_list_friend_requests', { kind: 'unidirectional' }), 'get_unidirectional_friend_list');
});

ok('actionParamsFrom 转 snake_case 且丢掉未知键', () => {
  assert.deepEqual(
    actionParamsFrom({ key: 'group:1', token: 't', messageId: '9', userId: '2', bogus: 1 }),
    { message_id: '9', user_id: '2' },
  );
});

ok('toolByName 能找到全部独立工具并带上所属组', () => {
  for (const t of independent) {
    const found = toolByName(t.name);
    assert.ok(found, `${t.name} 未索引`);
    assert.ok(GROUPS.some((g) => g.id === found.group));
  }
});

ok('默认配置 → 不注册任何工具（Review Focus 1）', () => {
  assert.deepEqual(toolsToRegister(defaultConfig()), []);
});

ok('开组 + 单个 action → 只注册覆盖它的工具（Review Focus 1）', () => {
  const cfg = defaultConfig();
  cfg.socialV2.toolGroups.groupInfo.enabled = true;
  cfg.socialV2.tools.get_group_info = true;
  const names = toolsToRegister(cfg).map((t) => t.name);
  assert.deepEqual(names, ['qq_get_group_profile']);
});

console.log(pass === 8 ? '\n✓ 8/8 passed' : `\n✗ ${pass}/8 passed`);
if (pass !== 8) process.exitCode = 1;
