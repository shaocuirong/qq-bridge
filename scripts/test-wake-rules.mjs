import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWakeRuleRuntime, normalizeWakeRules, safeWakeEvent, WAKE_TOOL_PROMPT_GROUPS } from '../src/wake-rules.js';
import { DEFAULT_WAKE_PROMPTS } from '../src/wake-prompts.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';
const rule = { id: 'event-wake', name: '群成员变化', enabled: true, keys: ['group:456'], events: ['message', 'notice:group_increase'], intervalMinutes: 1, cooldownSeconds: 10, prompt: '查看 {{key}}；事件 {{event}}；时间 {{time}}', reference: 'event' };
function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-wake-rules-'));
  try { run(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('events and schedules use scopes, cooldowns and pause without tool prerequisites', () => fixture(root => {
  let clock = 1_000_000, active = true; const sent = [];
  const runtime = createWakeRuleRuntime({ root, now: () => clock, isAllowed: key => key === 'group:456', isActive: () => active, dispatch: (key, context) => sent.push({ key, context }) });
  runtime.replace([rule]);
  runtime.event({ post_type: 'message', group_id: 999, user_id: 123 }); assert.equal(sent.length, 0);
  runtime.event({ post_type: 'message', group_id: 456, user_id: 123, raw_message: '你好', flag: 'must-not-leak', token: 'must-not-leak' });
  assert.equal(sent.length, 1); assert.ok(sent[0].context.prompt.includes('group:456'));
  assert.equal(sent[0].context.event.includes('must-not-leak'), false); assert.equal(Object.hasOwn(sent[0].context, 'tools'), false);
  runtime.event({ post_type: 'message', group_id: 456 }); assert.equal(sent.length, 1);
  clock += 10001; runtime.event({ post_type: 'notice', notice_type: 'group_increase', group_id: 456 }); assert.equal(sent.length, 2);
  clock += 50000; runtime.tick(); assert.equal(sent.length, 3); assert.equal(sent.at(-1).context.source, 'schedule');
  active = false; clock += 60000; runtime.tick(); runtime.event({ post_type: 'message', group_id: 456 }); assert.equal(sent.length, 3);
  active = true; runtime.tick(); assert.equal(sent.length, 3, '暂停期间不补跑');
  clock += 60000; runtime.tick(); assert.equal(sent.length, 4);
  assert.throws(() => runtime.replace([{ ...rule, keys: ['group:999'] }]), /范围/);
  assert.equal(runtime.view().rules[0].keys[0], 'group:456');
}));

test('saving another rule or scene prompt preserves existing timers and cooldowns', () => fixture(root => {
  let clock = 1_000_000; const sent = [];
  const runtime = createWakeRuleRuntime({ root, now: () => clock, isAllowed: () => true, isActive: () => true, dispatch: (...args) => sent.push(args) });
  runtime.replace([rule]); runtime.event({ post_type: 'message', group_id: 456 });
  const due = runtime.view().schedules[0].nextRunAt;
  clock += 1000;
  runtime.replace([rule, { ...rule, id: 'other', enabled: false }], { message: '新的消息唤醒 {{key}}' });
  assert.equal(runtime.view().schedules[0].nextRunAt, due);
  runtime.event({ post_type: 'message', group_id: 456 }); assert.equal(sent.length, 1);
  assert.equal(runtime.prompt('message', { key: 'group:456' }), '新的消息唤醒 group:456');
  clock += 59000; runtime.tick(); assert.equal(sent.length, 2);
  const context = sent[0][1];
  runtime.replace([{ ...rule, prompt: '改写后的任务' }]);
  assert.equal(runtime.isRuleActive(context.ruleId, 'group:456', context.revision), false, '改写后不投递旧上下文');
}));

test('legacy tool-linked rules migrate without retaining a tool selector or tool gate', () => fixture(root => {
  fs.mkdirSync(path.join(root, 'state'));
  fs.writeFileSync(path.join(root, 'state/tool-automations.json'), JSON.stringify({ version: 1, rules: [{ ...rule, tools: ['qq_memory_query'], prompt: '使用 {{tools}} 检查 {{event}}' }] }));
  const sent = [];
  const runtime = createWakeRuleRuntime({ root, isAllowed: () => true, isActive: () => true, dispatch: (...args) => sent.push(args) });
  assert.equal(Object.hasOwn(runtime.view().rules[0], 'tools'), false);
  runtime.event({ post_type: 'message', group_id: 456 }); assert.equal(sent.length, 1);
  assert.ok(sent[0][1].prompt.includes('当前已启用的工具'));
  runtime.replace(undefined, { proactiveCheck: '自定义主动机会 {{key}}' });
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'state/wake-rules.json')));
  assert.equal(saved.version, 2); assert.equal(saved.rules[0].tools, undefined);
  const reloaded = createWakeRuleRuntime({ root, isAllowed: () => true, isActive: () => true, dispatch() {} });
  assert.equal(reloaded.prompt('proactiveCheck', { key: 'group:456' }), '自定义主动机会 group:456');
  assert.equal(reloaded.view().prompts.find(p => p.id === 'message').text, DEFAULT_WAKE_PROMPTS.message);
}));

test('unknown scopes, triggers, schedules and prompt shapes are rejected atomically', () => fixture(root => {
  for (const patch of [{ keys: ['../456'] }, { intervalMinutes: 0.01 }, { cooldownSeconds: 0 }, { events: ['arbitrary:execute'] }, { prompt: '' }, { events: [], intervalMinutes: 0 }, { snapshotLimit: -1 }, { snapshotLimit: 101 }, { snapshotLimit: 1.5 }, { toolPromptGroups: null }, { toolPromptGroups: ['unknown'] }, { toolPromptGroups: 'memory' }, { toolPromptMode: 'unknown' }, { toolPromptMode: null }]) {
    assert.throws(() => normalizeWakeRules([{ ...rule, ...patch }]));
  }
  const sent = [];
  const runtime = createWakeRuleRuntime({ root, isAllowed: () => true, adminKey: () => 'private:123', isActive: () => true, dispatch: (...args) => sent.push(args) });
  runtime.replace([{ ...rule, events: ['notice:*', 'meta_event:heartbeat'] }]);
  assert.throws(() => runtime.replace(undefined, { unknown: 'bad' }));
  assert.throws(() => runtime.replace(undefined, { message: '' }));
  runtime.event({ post_type: 'notice', notice_type: 'group_increase' }); assert.equal(sent.length, 0, '归属不明的通知不广播');
  runtime.event({ post_type: 'meta_event', meta_event_type: 'heartbeat', status: { good: true } }); assert.equal(sent.length, 1);
  // 申请 flag 是 approve/reject 的一次性凭据，必须保留；令牌等其它字段仍然剔除。
  const requestEvent = safeWakeEvent({ post_type: 'request', request_type: 'friend', user_id: 1, flag: 'flag-x', accessToken: 'secret' });
  assert.equal(requestEvent.flag, 'flag-x');
  assert.equal(Object.hasOwn(requestEvent, 'accessToken'), false);
  assert.equal(safeWakeEvent({ post_type: 'notice', notice_type: 'group_increase', flag: 'not-a-request' }).flag, undefined);
}));

test('rules default to inheritance and preserve custom or restored modes across persistence', () => fixture(root => {
  const all = WAKE_TOOL_PROMPT_GROUPS.map(g => g.id);
  assert.deepEqual(normalizeWakeRules([rule])[0].toolPromptGroups, all);
  assert.equal(normalizeWakeRules([rule])[0].toolPromptMode, 'inherit');
  assert.equal(normalizeWakeRules([{ ...rule, toolPromptGroups: all }])[0].toolPromptMode, 'inherit');
  const sent = [];
  const runtime = createWakeRuleRuntime({ root, isAllowed: () => true, isActive: () => true, dispatch: (_, context) => sent.push(context) });
  const rules = [{ ...rule, toolPromptGroups: ['memory'] }, { ...rule, id: 'quiet-rule', toolPromptGroups: [] },
    { ...rule, id: 'custom-all', toolPromptMode: 'custom', toolPromptGroups: all },
    { ...rule, id: 'restored-rule', toolPromptMode: 'inherit', toolPromptGroups: ['memory'] }];
  runtime.replace(rules);
  runtime.event({ post_type: 'message', group_id: 456 });
  assert.deepEqual(sent.map(c => c.toolPromptGroups), [['memory'], [], all, ['memory']]);
  assert.deepEqual(sent.map(c => c.toolPromptMode), ['custom', 'custom', 'custom', 'inherit']);
  const reloaded = createWakeRuleRuntime({ root, isAllowed: () => true, isActive: () => true, dispatch() {} });
  assert.deepEqual(reloaded.view().rules, runtime.view().rules);
  reloaded.replace(undefined, { message: '仅编辑场景' });
  reloaded.replace(reloaded.view().rules.map(r => ({ ...r, enabled: false })));
  assert.deepEqual(reloaded.view().rules.map(r => r.toolPromptMode), ['custom', 'custom', 'custom', 'inherit']);
}));

test('event snapshots use the requested latest count, include cooldown arrivals and isolate targets/types', () => fixture(root => {
  let clock = 1_000_000;
  const runtime = createWakeRuleRuntime({ root, now: () => clock, isAllowed: () => true, adminKey: () => 'private:123', isActive: () => true,
    redact: text => text.replaceAll('known-secret', '[redacted]'), dispatch() {} });
  runtime.replace([{ ...rule, events: ['notice:group_increase'], snapshotLimit: 2 }]);
  for (let index = 1; index <= 4; index++) {
    runtime.event({ post_type: 'notice', notice_type: 'group_increase', group_id: 456, user_id: index, comment: 'known-secret', flag: 'never-store' });
    clock += 1;
  }
  runtime.event({ post_type: 'notice', notice_type: 'group_increase', group_id: 999, user_id: 900 });
  runtime.event({ post_type: 'message', group_id: 456, user_id: 901, raw_message: 'other event kind' });
  const snapshot = runtime.snapshot(rule.id, 'group:456');
  assert.deepEqual(snapshot.events.map(e => e.data.user_id), [3, 4]);
  assert.equal(snapshot.availableCount, 4); assert.equal(snapshot.requestedLimit, 2); assert.equal(snapshot.partial, true);
  assert.equal(JSON.stringify(snapshot).includes('known-secret'), false); assert.equal(JSON.stringify(snapshot).includes('never-store'), false);
  assert.equal(runtime.snapshot(rule.id, 'group:999'), null);
  runtime.replace([{ ...rule, snapshotLimit: 0 }]); assert.equal(runtime.snapshot(rule.id, 'group:456'), null);
  runtime.replace([{ ...rule, events: [], snapshotLimit: 100 }]);
  for (let index = 0; index < 50; index++) runtime.event({ post_type: 'message', group_id: 456, raw_message: '大'.repeat(800), user_id: index + 10 });
  const large = runtime.snapshot(rule.id, 'group:456');
  assert.ok(JSON.stringify(large).length <= 12000); assert.equal(large.partial, true);
  assert.equal(large.events.at(-1).data.user_id, 59);
}));

const requestRule = { id: 'request-apply', name: '申请处理', enabled: true, keys: [], events: ['request:friend', 'request:group'],
  intervalMinutes: 0, cooldownSeconds: 10, snapshotLimit: 4, prompt: '处理申请：{{event}}' };

test('rules can opt in to proactively seeking an opportunity', () => fixture(root => {
  assert.equal(normalizeWakeRules([rule])[0].proactive, false);
  assert.equal(normalizeWakeRules([{ ...rule, proactive: true }])[0].proactive, true);
  assert.equal(normalizeWakeRules([{ ...rule, proactive: 'yes' }])[0].proactive, false);
}));

test('request-only rules dispatch without a target session and carry the approval flag', () => fixture(root => {
  let clock = 1_000_000; const sent = [];
  const runtime = createWakeRuleRuntime({ root, now: () => clock, isAllowed: key => key === 'private:123',
    adminKey: () => 'private:123', isActive: () => true, dispatch: (key, context) => sent.push({ key, context }) });
  runtime.replace([requestRule]);
  // 好友申请的 user_id 是申请人，不能据此推导目标会话；它也不在白名单里。
  runtime.event({ post_type: 'request', request_type: 'friend', user_id: 999, comment: '我是小号', flag: 'flag-1', access_token: 'secret-token' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].key, 'private:123');
  assert.equal(sent[0].context.targetless, true);
  const friendPayload = JSON.parse(sent[0].context.event);
  assert.equal(friendPayload.flag, 'flag-1');
  assert.equal(friendPayload.user_id, 999);
  assert.equal(JSON.stringify(friendPayload).includes('secret-token'), false);
  assert.equal(runtime.isRuleActive(requestRule.id, 'private:123'), true);
  clock += 11_000;
  // 加群申请的目标群可能不在白名单/规则目标里，同样投递管理员会话。
  runtime.event({ post_type: 'request', request_type: 'group', group_id: 789, user_id: 999, sub_type: 'add', flag: 'flag-2' });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].key, 'private:123');
  assert.equal(JSON.parse(sent[1].context.event).flag, 'flag-2');
}));

test('target requirements follow the selected triggers', () => fixture(root => {
  assert.throws(() => normalizeWakeRules([{ ...requestRule, events: ['message'] }]), /目标会话/);
  assert.throws(() => normalizeWakeRules([{ ...requestRule, events: ['notice:group_increase'] }]), /群/);
  assert.throws(() => normalizeWakeRules([{ ...requestRule, events: ['notice:group_increase'], keys: ['private:123'] }]), /群/);
  assert.doesNotThrow(() => normalizeWakeRules([requestRule]));
  assert.doesNotThrow(() => normalizeWakeRules([{ ...requestRule, events: [], intervalMinutes: 5 }]));

  const sent = [];
  const runtime = createWakeRuleRuntime({ root, isAllowed: () => true, adminKey: () => 'private:123', isActive: () => true,
    dispatch: (key, context) => sent.push({ key, context }) });
  runtime.replace([{ ...requestRule, keys: ['group:456'], events: ['notice:group_increase'] }]);
  runtime.event({ post_type: 'notice', notice_type: 'group_increase', group_id: 999, user_id: 777 });
  assert.equal(sent.length, 0, '成员变更只认规则里选中的群');
  runtime.event({ post_type: 'notice', notice_type: 'group_increase', group_id: 456, user_id: 777 });
  assert.equal(sent.length, 1); assert.equal(sent[0].key, 'group:456');
}));

test('timed rules can use a random interval range and re-roll after each trigger', () => fixture(root => {
  let clock = 1_000_000, pick = 0;
  const sent = [];
  const runtime = createWakeRuleRuntime({ root, now: () => clock, random: () => pick, isAllowed: () => true,
    adminKey: () => 'private:123', isActive: () => true, dispatch: (key, context) => sent.push({ key, context }) });
  const scheduled = { ...requestRule, id: 'random-interval', events: [], intervalMinutes: 10, intervalMaxMinutes: 20 };
  runtime.replace([scheduled]);
  assert.equal(Date.parse(runtime.view().schedules[0].nextRunAt), clock + 10 * 60000, 'random=0 取下限');
  clock += 10 * 60000; runtime.tick(); assert.equal(sent.length, 1);
  pick = 1;
  clock += 10 * 60000; runtime.tick(); assert.equal(sent.length, 2);
  assert.equal(Date.parse(runtime.view().schedules[0].nextRunAt), clock + 20 * 60000, 'random=1 取上限');
  const reloaded = createWakeRuleRuntime({ root, now: () => clock, random: () => 0.5, isAllowed: () => true,
    adminKey: () => 'private:123', isActive: () => true, dispatch() {} });
  assert.equal(reloaded.view().rules[0].intervalMaxMinutes, 20);
  assert.equal(Date.parse(reloaded.view().schedules[0].nextRunAt), clock + 15 * 60000, '重启后按中位随机');
}));

test('random interval bounds are validated', () => {
  assert.throws(() => normalizeWakeRules([{ ...rule, intervalMinutes: 10, intervalMaxMinutes: 5 }]), /随机上限/);
  assert.throws(() => normalizeWakeRules([{ ...rule, intervalMinutes: 0, intervalMaxMinutes: 10 }]), /随机上限/);
  assert.throws(() => normalizeWakeRules([{ ...rule, intervalMaxMinutes: 43201 }]), /随机上限/);
  assert.equal(normalizeWakeRules([{ ...rule, intervalMinutes: 10, intervalMaxMinutes: 20 }])[0].intervalMaxMinutes, 20);
  assert.equal(normalizeWakeRules([rule])[0].intervalMaxMinutes, 0);
});

test('timed rules without targets dispatch to the admin session', () => fixture(root => {
  let clock = 1_000_000; const sent = [];
  const runtime = createWakeRuleRuntime({ root, now: () => clock, isAllowed: () => true, adminKey: () => 'private:123',
    isActive: () => true, dispatch: (key, context) => sent.push({ key, context }) });
  runtime.replace([{ ...requestRule, id: 'timed', name: '定时巡检', events: [], intervalMinutes: 1 }]);
  clock += 60_000; runtime.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].key, 'private:123');
  assert.equal(sent[0].context.source, 'schedule');
  assert.equal(sent[0].context.targetless, true);
}));

test('request snapshots stay visible to the admin target without a session key', () => fixture(root => {
  let clock = 1_000_000;
  const runtime = createWakeRuleRuntime({ root, now: () => clock, isAllowed: () => true, adminKey: () => 'private:123',
    isActive: () => true, dispatch() {} });
  runtime.replace([{ ...requestRule, events: ['request:friend'], snapshotLimit: 5 }]);
  runtime.event({ post_type: 'request', request_type: 'friend', user_id: 88, flag: 'f-1' });
  clock += 1_000;
  runtime.event({ post_type: 'request', request_type: 'friend', user_id: 99, flag: 'f-2' });
  const snapshot = runtime.snapshot(requestRule.id, 'private:123');
  assert.deepEqual(snapshot.events.map(e => e.data.user_id), [88, 99]);
  assert.equal(snapshot.events.at(-1).data.flag, 'f-2');
  assert.equal(runtime.snapshot(requestRule.id, 'private:999'), null);
}));

test('a targetless rule is refused when no admin private session is available', () => fixture(root => {
  const runtime = createWakeRuleRuntime({ root, isAllowed: () => true, isActive: () => true, dispatch() {} });
  assert.throws(() => runtime.replace([requestRule]), /管理员|私聊/);
}));

test('an event wake queued while busy survives without unread messages, and disabled rules do not revive', async () => {
  const h = await bridgeHarness({ config: { socialV2: { wake: { batchWindowMs: 60000 } } } });
  try {
    h.setMode('reserved2'); h.setReady(true);
    const key = 'group:456', st = h.getSocialV2State(key);
    const sid = await h.ensureSession(key);
    h.collectors.set(sid, { stub: true }); h.v2TurnStartAt.set(sid, Date.now());
    h.wakeRules.replace([{ ...rule, intervalMinutes: 0, events: ['notice:group_increase'], snapshotLimit: 2 }]);
    for (const user_id of [111, 222, 333]) h.wakeRules.event({ post_type: 'notice', notice_type: 'group_increase', group_id: 456, user_id });
    const prompt = h.buildWakePromptV2(key, 'wakeRule');
    const snapshotJson = prompt.match(/【事件快照，仅作上下文】([^\n]+)/)?.[1];
    assert.ok(snapshotJson); assert.deepEqual(JSON.parse(snapshotJson).events.map(e => e.data.user_id), [222, 333]);
    assert.equal(st.unread.length, 0); assert.equal(st.pendingWakeReasons[0].reason, 'wakeRule');
    h.collectors.delete(sid); h.v2TurnStartAt.delete(sid);
    h.sweepPendingWakeReasonsV2(); assert.ok(st.pendingWakeTimer, '没有未读消息也必须重排任务');
    clearTimeout(st.pendingWakeTimer); st.pendingWakeTimer = null;
    h.wakeRules.replace([{ ...rule, enabled: false }]);
    const before = h.calls.prompts.length;
    await h.sendWakePromptV2(key, 'wakeRule'); assert.equal(h.calls.prompts.length, before);
  } finally { await h.close(); }
});

test('bridge injects the proactive opportunity directive only when the rule opts in', async () => {
  const h = await bridgeHarness({ config: { socialV2: { wake: { batchWindowMs: 60000 } } } });
  try {
    h.setMode('reserved2'); h.setReady(true);
    h.wakeRules.replace([{ ...rule, id: 'quiet-rule', prompt: '处理成员变化', proactive: false }]);
    h.wakeRules.event({ post_type: 'notice', notice_type: 'group_increase', group_id: 456, user_id: 1 });
    assert.equal(h.buildWakePromptV2('group:456', 'wakeRule').includes('【主动找机会】'), false);
    h.wakeRules.replace([{ ...rule, id: 'active-rule', prompt: '处理成员变化', proactive: true }]);
    h.wakeRules.event({ post_type: 'notice', notice_type: 'group_increase', group_id: 456, user_id: 2 });
    assert.match(h.buildWakePromptV2('group:456', 'wakeRule'), /【主动找机会】/);
  } finally { await h.close(); }
});

test('bridge delivers request wakes into the owner session with the approval flag', async () => {
  const h = await bridgeHarness({ config: { socialV2: { wake: { batchWindowMs: 60000 } } } });
  try {
    h.setMode('reserved2'); h.setReady(true);
    assert.equal(h.wakeRules.view().adminKey, 'private:123');
    h.wakeRules.replace([requestRule]);
    h.wakeRules.event({ post_type: 'request', request_type: 'friend', user_id: 999, comment: '加一下', flag: 'flag-integration' });
    const prompt = h.buildWakePromptV2('private:123', 'wakeRule');
    assert.match(prompt, /flag-integration/);
    assert.match(prompt, /set_friend_add_request/);
    assert.match(prompt, /不绑定当前 QQ 会话|不绑定该会话/);
    // 申请人自己的会话不应收到这次申请唤醒。
    assert.equal(h.buildWakePromptV2('private:999', 'wakeRule').includes('flag-integration'), false);
    // 合批定时器清掉后走真实投递：管理员会话收到带 flag 的 prompt。
    const adminState = h.getSocialV2State('private:123');
    clearTimeout(adminState.pendingWakeTimer); adminState.pendingWakeTimer = null;
    await h.sendWakePromptV2('private:123', 'wakeRule');
    const delivered = h.calls.prompts.at(-1);
    assert.ok(delivered, '管理员会话应收到一次 DSH prompt');
    assert.match(JSON.stringify(delivered), /flag-integration/);
  } finally { await h.close(); }
});
