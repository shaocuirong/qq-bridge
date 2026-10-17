// Task 4 测试：通用动作端点的授权判定（纯函数版）。
//
// Ruling（见 ledger）：bridge.js 有顶层副作用，不能直接 import 做单测；
// 因此把六道闸的顺序抽成 src/qq-tool-groups.js 的 authorizeToolCall()，
// 端点只负责把布尔喂进去。HTTP 层保持薄，手工验收覆盖。
import assert from 'node:assert/strict';
import {
  authorizeToolCall, defaultConfig, NEVER_EXPOSED,
} from '../src/qq-tool-groups.js';

let pass = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}\n    ${e?.message ?? e}`); process.exitCode = 1; }
};

const base = {
  action: 'get_group_info',
  key: 'group:123',
  tokenOk: true,
  sessionAllowed: true,
  mode: 'reserved2',
  keyKindOk: true,
};

const on = (action) => {
  const cfg = defaultConfig();
  cfg.socialV2.toolGroups.groupInfo.enabled = true;
  cfg.socialV2.tools[action] = true;
  return cfg;
};

console.log('Task 4: /api/socialV2/tools/call 判定');

ok('正常：组开 + action 开 + reserved2 + 令牌有效 → 放行', () => {
  assert.deepEqual(authorizeToolCall({ ...base, cfg: on('get_group_info') }), { ok: true });
});

ok('令牌无效 → 403，且不泄露 action 是否存在（先判令牌）', () => {
  const r = authorizeToolCall({ ...base, action: '不存在的action', tokenOk: false, cfg: on('get_group_info') });
  assert.equal(r.status, 403);
  assert.match(r.error, /未授权/);
});

ok('非 reserved2 模式 → 403', () => {
  const r = authorizeToolCall({ ...base, mode: 'chat', cfg: on('get_group_info') });
  assert.equal(r.status, 403);
  assert.match(r.error, /reserved2/);
});

ok('会话不在允许范围 → 403', () => {
  const r = authorizeToolCall({ ...base, sessionAllowed: false, cfg: on('get_group_info') });
  assert.equal(r.status, 403);
  assert.match(r.error, /允许范围/);
});

ok('未知 action → 400', () => {
  const r = authorizeToolCall({ ...base, action: 'no_such_action', cfg: on('get_group_info') });
  assert.equal(r.status, 400);
  assert.match(r.error, /未知 action/);
});

ok('never 清单 action → 403 且点名（Review Focus 2）', () => {
  const cfg = defaultConfig();
  cfg.socialV2.toolGroups.credential.enabled = true;
  cfg.socialV2.tools.get_cookies = true;
  const r = authorizeToolCall({ ...base, action: 'get_cookies', cfg });
  assert.equal(r.status, 403);
  assert.match(r.error, /get_cookies/);
  assert.ok(NEVER_EXPOSED.includes('get_cookies'));
});

ok('组关 → 403', () => {
  const cfg = defaultConfig();
  cfg.socialV2.tools.get_group_info = true;
  const r = authorizeToolCall({ ...base, cfg });
  assert.equal(r.status, 403);
  assert.match(r.error, /未启用/);
});

ok('组开但 action 关 → 403', () => {
  const cfg = defaultConfig();
  cfg.socialV2.toolGroups.groupInfo.enabled = true;
  const r = authorizeToolCall({ ...base, cfg });
  assert.equal(r.status, 403);
  assert.match(r.error, /未启用/);
});

ok('key 类型与 action 不符 → 400（Review Focus 3）', () => {
  const r = authorizeToolCall({ ...base, keyKindOk: false, cfg: on('get_group_info') });
  assert.equal(r.status, 400);
  assert.match(r.error, /key 类型/);
});

if (pass !== 18) process.exitCode = 1;

// ── Final review 修复回归（C1/C2 + I3/I4/I5/I7/I8/I11）────────────────────────
const { validateToolTarget, auditToolParams, resolveToolAction, toolByName, TOOL_PARAMS, authorizeConsoleToolCall } = await import('../src/qq-tool-groups.js');
const { isReadOnlyAction } = await import('../src/tool-prompts.js');

const ctx = (over = {}) => ({
  action: 'set_group_kick', key: 'group:123', params: {},
  allowGroups: ['123'], allowPrivate: ['1761476025'], sessionUserIds: ['1761476025', '3401933371'],
  ...over,
});

ok('C1: params.group_id 必须是本会话的群，不能指向白名单外', () => {
  assert.equal(validateToolTarget(ctx({ params: { group_id: '999' } })).ok, false);
  assert.equal(validateToolTarget(ctx({ params: { group_id: '123' } })).ok, true);
});

ok('C1: params.user_id 必须在本会话参与者或允许列表内', () => {
  assert.equal(validateToolTarget(ctx({ params: { user_id: '555' } })).ok, false);
  assert.equal(validateToolTarget(ctx({ params: { user_id: '3401933371' } })).ok, true);
});

ok('I4: message_id 不在本会话可见集合 → 拒绝', () => {
  const c = ctx({ action: 'delete_msg', params: { message_id: '-99' }, sessionMessageIds: ['-1', '-2'] });
  assert.equal(validateToolTarget(c).ok, false);
  assert.equal(validateToolTarget({ ...c, params: { message_id: '-1' } }).ok, true);
});

ok('C2: 出站参数命中敏感特征 → 拒绝', () => {
  const re = /X2iy4UiUDpzbyX/;
  assert.equal(auditToolParams({ message: 'X2iy4UiUDpzbyX' }, re).ok, false);
  assert.equal(auditToolParams({ message: '正常聊天' }, re).ok, true);
});

ok('I3/I4: 读他人消息类工具改走 B 类（经桥接校验）', () => {
  for (const name of ['qq_get_msg', 'qq_fetch_ptt_text', 'qq_get_msg_emoji_likes', 'qq_set_typing'])
    assert.equal(toolByName(name).mode, 'B', `${name} 应为 B 类`);
});

ok('I7: qq_set_typing 需要 userId', () => {
  assert.ok(TOOL_PARAMS.qq_set_typing.userId);
});

ok('I8: qq_get_group_files 传 folderId 时选子目录 action', () => {
  assert.equal(resolveToolAction('qq_get_group_files', { folderId: 'f1' }), 'get_group_files_by_folder');
  assert.equal(resolveToolAction('qq_get_group_files', {}), 'get_group_root_files');
});

ok('I11: 一键只读不把写动作判成只读', () => {
  for (const a of ['modify_custom_face', 'get_share_link', 'get_ai_record', 'get_fileset_info', 'list_filesets'])
    assert.equal(isReadOnlyAction(a), false, `${a} 不应判为只读`);
  assert.equal(isReadOnlyAction('get_group_info'), true);
});
ok('控制台试调用不需要会话令牌，但 never/开关仍然生效', () => {
  assert.equal(authorizeConsoleToolCall({ cfg: on('get_group_info'), action: 'get_group_info' }).ok, true);
  assert.equal(authorizeConsoleToolCall({ cfg: on('get_group_info'), action: 'get_cookies' }).status, 403);
  assert.equal(authorizeConsoleToolCall({ cfg: defaultConfig(), action: 'get_group_info' }).status, 403);
  assert.equal(authorizeConsoleToolCall({ cfg: on('get_group_info'), action: 'nope' }).status, 400);
});

const NL = String.fromCharCode(10);
console.log(pass === 18 ? NL + '✓ 18/18 passed' : NL + '✗ ' + pass + '/18 passed');
if (pass !== 18) process.exitCode = 1;
