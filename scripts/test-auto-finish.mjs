import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';
async function fixture(run, context = {}) {
  const h = await bridgeHarness({ config: { socialV2: {
    wake: { maxWakePerMinute: 0, maxWakePerHour: 0, preSleepWaitEnabled: true, preSleepWaitMs: 300000 },
    proactive: { enabled: false }, sticker: { enabled: false }, context,
  } } });
  h.setMode('reserved2');
  const st = h.getSocialV2State(KEY);
  let seq = 0;
  const append = (text) => h.appendSocialV2Message(KEY, '小张', text, text, false, false, `m${++seq}`, [], '111', []);
  const finish = (kind = 'completed', sid = h.state.sessions[KEY]) => h.finalizeWakeTurnV2(KEY, sid, { kind });
  try { await run({ h, st, append, finish }); } finally { await h.close(); }
}

test('正常回合自动确认展示水位，不调用模型提醒也不要求五分钟观察', async () => fixture(async ({ h, st, append, finish }) => {
  append('你好');
  await h.sendWakePromptV2(KEY, 'question');
  const triggers = JSON.stringify(st.wakeConfig.triggers);
  assert.equal(finish(), true);
  assert.equal(st.unread.length, 0);
  assert.equal(st.lastReadThroughSeq, 1);
  assert.equal(h.pendingWakeKeys.has(KEY), false);
  assert.equal(JSON.stringify(st.wakeConfig.triggers), triggers);
  assert.equal(st.wakeConfig.confirmedBy, 'default', '自动确认不能破坏默认配置热更新');
  assert.equal(h.calls.prompts.length, 1, '收尾不能再消耗一个模型回合');
  assert.equal(h.calls.created.length, 1, '收尾不能轮换会话');
  assert.equal(Boolean(st.pendingWakeTimer), false);
  assert.equal(finish(), false, '重复结束事件不能重复处理');
}));

test('新到消息和快照未展示页仍保留未读，只有取得进展才安排继续处理', async () => fixture(async ({ h, st, append, finish }) => {
  append('第一页');
  append('第二页');
  await h.sendWakePromptV2(KEY, 'question');
  append('回合中新增');
  finish();
  assert.deepEqual(Array.from(st.unread, (m) => m.seq), [2, 3]);
  assert.equal(st.lastReadThroughSeq, 1);
  assert.ok(st.pendingWakeTimer);
  assert.equal(h.calls.prompts.length, 1);
}, { wakeMessageLimit: 1, wakeRecentLimit: 0 }));

test('失败和取消回合不确认已读，也不触发提醒循环', async () => {
  for (const kind of ['failed', 'cancelled']) await fixture(async ({ h, st, append, finish }) => {
    append('需要重试的消息');
    await h.sendWakePromptV2(KEY, 'question');
    finish(kind);
    assert.equal(st.unread.length, 1);
    assert.equal(st.lastReadThroughSeq, 0);
    assert.equal(h.pendingWakeKeys.has(KEY), false);
    assert.equal(Boolean(st.pendingWakeTimer), false);
    assert.equal(h.calls.prompts.length, 1);
  });
});

test('模型显式设置的有限睡眠和已读范围由程序保留', async () => fixture(async ({ h, st, append, finish }) => {
  append('本轮仍保留未读');
  await h.sendWakePromptV2(KEY, 'question');
  const until = new Date(Date.now() + 600000).toISOString();
  st.wakeConfig.infinite = false;
  st.wakeConfig.sleepUntil = until;
  st.wakeConfig.confirmedBy = 'set_wake_config';
  st.wakeConfig.triggers = { atMention: true, probability: 0.07 };
  h.wakeConfigUpdatedKeys.add(KEY);
  finish();
  assert.equal(st.unread.length, 1, '显式确认水位不能被程序扩展');
  assert.equal(st.wakeConfig.sleepUntil, until);
  assert.equal(st.wakeConfig.triggers.probability, 0.07);
  assert.equal(st.wakeConfig.confirmedBy, 'set_wake_config');
  assert.ok(st.sleepTimer);
  assert.equal(h.wakeConfigUpdatedKeys.has(KEY), false);
}));

test('无工具收尾也能修复无任何触发条件的配置', async () => fixture(async ({ h, st, append, finish }) => {
  append('你好');
  await h.sendWakePromptV2(KEY, 'question');
  st.wakeConfig.infinite = true;
  st.wakeConfig.sleepUntil = null;
  st.wakeConfig.mode = 'diving';
  st.wakeConfig.triggers = {};
  finish();
  assert.equal(st.unread.length, 0);
  assert.ok(st.wakeConfig.triggers.atMention || st.wakeConfig.triggers.anyMessage || st.wakeConfig.sleepUntil);
  assert.equal(h.calls.prompts.length, 1);
}));

test('没有展示凭据的消息不会被自动清理或无限重新唤醒', async () => fixture(async ({ h, st, append, finish }) => {
  append('尚未展示');
  await h.sendWakePromptV2(KEY, 'question');
  finish();
  assert.equal(st.unread.length, 1);
  assert.equal(Boolean(st.pendingWakeTimer), false);
}, { inlineWakeMessages: false }));

test('旧会话、模式切换和暂停都不能把当前新消息标成已读', async () => fixture(async ({ h, st, append, finish }) => {
  append('当前会话的消息');
  await h.sendWakePromptV2(KEY, 'question');
  assert.equal(finish('completed', 'retired-session'), false);
  h.setMode('chat');
  assert.equal(finish(), false);
  h.setMode('reserved2');
  h.socialV2.paused = true;
  finish();
  assert.equal(st.unread.length, 1);
  assert.equal(st.lastReadThroughSeq, 0);
  assert.equal(h.calls.prompts.length, 1);
}));

test('生产结束分支使用程序收尾，源码不再包含模型收尾提醒', () => {
  const source = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  assert.match(source, /finalizeWakeTurnV2\(key, frame.sessionId, ended.reason\)/);
  assert.doesNotMatch(source, /buildWakeReminderPromptV2|未设置唤醒条件，发送提醒|你还没有完成回合收尾/);
});
