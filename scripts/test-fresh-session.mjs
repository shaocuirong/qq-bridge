// 「一轮一会话」（socialV2.context.freshSessionPerWake）+ 唤醒自愈回归。
//
// 一轮一会话解决的是成本滚雪球：一个会话聊到底时，每轮都要把「整段历史 + 全部工具调用」重发一遍，
// 冷群里缓存一过期就全按 cacheMiss 计价，而且历史只增不减。改成每次回复新开会话后，
// 单轮成本 ≈ 一条提示词 + 一条回复，上下文改由提示词里的已读/未读快照承担。
//
// 唤醒自愈解决的是「有的会话再也不回复」：桥接把「有回合在跑」当作不能唤醒的依据，而那次回合的
// turn/end 可能永远收不到（重启在回合中途、断线、轮换时退订旧会话）——标记永远挂着，
// 之后每次唤醒都被暂存，而暂存只在回合结束事件到来时补发。所以：
//   ①「生成中」带租约，超时强制解除；②每分钟一次兜底轮询补发积压的唤醒。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';

async function fixture(run, context = {}) {
  const h = await bridgeHarness({
    config: {
      socialV2: {
        // 关掉唤醒限频，把合批窗口压到最小、并把「生成中」租约压到 1 分钟（默认 5 分钟），
        // 让测试里的连续唤醒/租约过期都能在秒级跑到。
        wake: { maxWakePerMinute: 0, maxWakePerHour: 0, batchWindowMs: 1000, busyLeaseMs: 60000 },
        proactive: { enabled: false },
        sticker: { enabled: false },
        wait: { minMs: 50, minQuietAfterNewMs: 50 },
        context,
      },
    },
  });
  h.setMode('reserved2');
  const st = h.getSocialV2State(KEY);
  let seq = 0;
  const wake = (h2 = h) => h2.deliverPrompt(KEY, '(wake path rebuilds this)', { wakeReason: 'question' });
  const append = (text) => h.appendSocialV2Message(KEY, 'fixture-person', text, text, false, false, `fixture-msg-${++seq}`, [], '789', []);
  try { await run({ h, st, append, wake }); } finally { await h.close(); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('每次唤醒都新开会话，并把上一轮会话归档', async () => {
  await fixture(async ({ h, append, wake }) => {
    append('第一条');
    await wake();
    const first = h.state.sessions[KEY];
    assert.ok(first, '第一次唤醒应建立会话');

    append('第二条');
    await wake();
    const second = h.state.sessions[KEY];
    assert.ok(second, '第二次唤醒应建立会话');
    assert.notEqual(second, first, '第二次唤醒必须换一个新会话（不带上文）');

    assert.equal(h.calls.created.length, 2, '应创建两个 DSH 会话');
    assert.equal(h.calls.prompts.length, 2);
    assert.equal(h.calls.prompts[0].sessionId, first);
    assert.equal(h.calls.prompts[1].sessionId, second);
    // 归档是 fire-and-forget（stopRetiredSessionWork 内部异步），给它一个 tick
    await sleep(20);
    assert.ok(h.calls.archived.includes(first), '旧会话必须被归档，否则会在 DSH 里一直堆着');
    assert.ok(h.calls.cancelled.includes(first), '归档前先停掉 DSH 侧可能残留的排队任务');
  });
}, { timeout: 30000 });

test('轮换不动社交状态：未读、已读水位、令牌、bootstrap 标记都保留', async () => {
  await fixture(async ({ h, st, append, wake }) => {
    append('要保留的未读');
    const tokenBefore = st.agentToken;
    const unreadBefore = st.unread.length;
    const seqBefore = st.lastUnreadSeq;
    st.bootstrapSent = true;

    await wake();
    await sleep(20);
    append('再一条');
    await wake();

    assert.equal(st.agentToken, tokenBefore, 'agentToken 必须保留：它写在提示词里，换了 AI 手上的令牌就失效');
    assert.equal(st.bootstrapSent, true, 'bootstrapSent 不能被轮换重置（否则下次消息又走一次 bootstrap 唤醒）');
    assert.ok(st.unread.length >= unreadBefore, '未读队列不能被清空（模型可能还没处理完）');
    assert.ok(st.lastUnreadSeq >= seqBefore, '未读水位不能被回退');
    assert.ok(h.state.sessions[KEY], '轮换后仍应有一个当前会话');
  });
}, { timeout: 30000 });

test('关掉 freshSessionPerWake 就回到老行为：同一会话复用', async () => {
  await fixture(async ({ h, append, wake }) => {
    append('第一条');
    await wake();
    const first = h.state.sessions[KEY];
    append('第二条');
    await wake();
    assert.equal(h.state.sessions[KEY], first, '关闭开关时必须复用同一个会话');
    assert.equal(h.calls.created.length, 1, '关闭开关时不应反复建会话');
    assert.equal(h.calls.prompts[0].sessionId, h.calls.prompts[1].sessionId);
  }, { freshSessionPerWake: false });
}, { timeout: 30000 });

test('closed-agent 与 internal: 会话永不轮换', async () => {
  await fixture(async ({ h }) => {
    assert.equal(h.cfg.socialV2.context.freshSessionPerWake, true, '默认应开启一轮一会话');
    assert.equal(h.freshSessionEnabledFor(KEY), true, '群聊/私聊应轮换');
    assert.equal(h.freshSessionEnabledFor('internal:黑话学习'), false, '内部会话（黑话学习/研究）保持连续');
    h.setMode('closed-agent');
    assert.equal(h.freshSessionEnabledFor('private:123'), false, 'closed-agent（管理员运维）保持连续');
  });
}, { timeout: 30000 });

test('上一轮仍在生成时不轮换（不能把进行中的回合连带停掉）', async () => {
  await fixture(async ({ h, append, wake }) => {
    append('第一条');
    await wake();
    const first = h.state.sessions[KEY];
    assert.ok(first);
    // 模拟「回合还在跑」：turn/start 之后 collectors / v2TurnStartAt 里就有它
    h.collectors.set(first, { stub: true });
    append('第二条');
    await wake();
    assert.equal(h.state.sessions[KEY], first, '回合进行中必须沿用同一会话');
    assert.equal(h.calls.created.length, 1, '不应在回合进行中新建会话');
    assert.equal(h.calls.prompts[1].sessionId, first);
    h.collectors.delete(first);
    append('第三条');
    await wake();
    assert.notEqual(h.state.sessions[KEY], first, '回合结束后应恢复轮换');
  });
}, { timeout: 30000 });

test('卡住的会话能自愈：假繁忙解除 + 兜底轮询补发积压唤醒（线上故障回归）', async () => {
  await fixture(async ({ h, st, append, wake }) => {
    append('在吗');
    await wake();
    const sid = h.state.sessions[KEY];
    assert.ok(sid);

    // 复现线上故障：会话被误判为「正在生成」（turn/start 收到了、turn/end 永远没来）。
    // 走生产路径 sendWakePromptV2 才会命中「会话繁忙 → 暂存」这一分支。
    h.collectors.set(sid, { stub: true });
    h.pendingWakeKeys.delete(KEY);
    append('@bot 说话');
    await h.sendWakePromptV2(KEY, 'question');
    assert.equal(h.calls.prompts.length, 1, '假繁忙期间不应再投递 prompt');
    assert.ok((st.pendingWakeReasons ?? []).length > 0, '唤醒原因被暂存');

    // 兜底轮询在「仍然忙」时不能强行投递（否则会打断真回合）
    h.sweepPendingWakeReasonsV2();
    await sleep(1500);
    assert.equal(h.calls.prompts.length, 1, '真忙时兜底轮询也要克制');

    // 租约到期：把「生成中」的时间戳推到过期（生产里就是等 busyLeaseMs 过去）。
    // 注意这里**故意保留** collectors：真实的假繁忙就是"collector 还在、turn/end 永远不来"。
    h.v2TurnStartAt.set(sid, Date.now() - 10 * 60 * 1000);

    // 兜底轮询把积压的唤醒重新排上 → 消息终于被转发给 DSH（合批窗口 1s）
    h.sweepPendingWakeReasonsV2();
    for (let i = 0; i < 100 && h.calls.prompts.length < 2; i += 1) await sleep(50);
    assert.ok(h.calls.prompts.length >= 2, '积压的唤醒必须被补发出去');
    assert.equal((st.pendingWakeReasons ?? []).length, 0, '补发后暂存队列应清空');
    assert.equal(h.collectors.has(sid), false, '过期标记必须被清掉，否则下次还会被当成忙');
  });
}, { timeout: 30000 });

test('回合结束后的投影、工具和迟到文本不会把会话重新标成繁忙', async () => {
  await fixture(async ({ h, st, append, wake }) => {
    append('第一条');
    await wake();
    const sid = h.state.sessions[KEY];
    h.collectSessionTurnEvent(sid, { type: 'turn/start', data: { turn: 1 } });
    assert.equal(h.isConversationBusyV2(KEY, st), true);
    const ended = h.collectSessionTurnEvent(sid, {
      type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } },
    });
    assert.equal(ended.turn, 1);
    // pumpMux 的正常结束收尾。
    h.collectors.delete(sid);
    h.v2TurnStartAt.delete(sid);
    h.disarmSessionBusyLease(sid);
    for (const type of ['model/selection', 'token/usage', 'tool/result', 'assistant/message', 'assistant/chunk', 'turn/end']) {
      h.collectSessionTurnEvent(sid, { type, data: { turn: 1 } });
      assert.equal(h.isConversationBusyV2(KEY, st), false, `${type} 不能制造假繁忙`);
      assert.equal(h.collectors.has(sid), false);
      assert.equal(h.sessionBusyLeaseTimers.has(sid), false);
    }
    append('下一条');
    await h.sendWakePromptV2(KEY, 'private');
    assert.equal(h.calls.prompts.length, 2, '下一条消息应立即投递');
  });
});

test('真实在途唤醒的租约过期会一起解除 pendingWakeKeys 并补投', async () => {
  await fixture(async ({ h, st, append }) => {
    append('第一条');
    await h.sendWakePromptV2(KEY, 'question');
    const sid = h.state.sessions[KEY];
    h.collectSessionTurnEvent(sid, { type: 'turn/start', data: { turn: 1 } });
    assert.equal(h.pendingWakeKeys.has(KEY), true);
    append('第二条');
    await h.sendWakePromptV2(KEY, 'question');
    assert.equal(h.calls.prompts.length, 1);
    assert.equal(h.isConversationBusyV2(KEY, st), true);
    h.armSessionBusyLease(sid, 1000);
    for (let i = 0; i < 80 && h.calls.prompts.length < 2; i++) await sleep(50);
    assert.equal(h.calls.prompts.length, 2, '不应被独立的 30 分钟 pending 标记继续挡住');
    assert.equal(h.collectors.has(sid), false);
  });
});

test('有限睡眠在繁忙期间到期，无未读消息也会补发 timeout', async () => {
  await fixture(async ({ h, st, wake }) => {
    await wake();
    const sid = h.state.sessions[KEY];
    h.collectSessionTurnEvent(sid, { type: 'turn/start', data: { turn: 1 } });
    st.wakeConfig.infinite = false;
    st.wakeConfig.sleepUntil = new Date(Date.now() - 1000).toISOString();
    h.setupSleepTimerV2(KEY);
    assert.equal(st.pendingWakeReasons[0].reason, 'timeout');
    assert.equal(st.unread.length, 0);
    h.v2TurnStartAt.set(sid, Date.now() - 120000);
    h.sweepPendingWakeReasonsV2();
    for (let i = 0; i < 50 && h.calls.prompts.length < 2; i++) await sleep(50);
    assert.equal(h.calls.prompts.length, 2);
    assert.equal(st.lastWakeReason, 'timeout');
  });
});

test('有限睡眠按真实期限调度，超过 Node 上限才分段续期', async () => {
  await fixture(async ({ h, st }) => {
    st.wakeConfig.infinite = false;
    st.wakeConfig.sleepUntil = new Date(Date.now() + 300000).toISOString();
    h.setupSleepTimerV2(KEY);
    assert.ok(st.sleepTimer._idleTimeout > 290000, '五分钟睡眠不应每 100 秒续期');
    st.wakeConfig.sleepUntil = new Date(Date.now() + 2 ** 31 + 60000).toISOString();
    h.setupSleepTimerV2(KEY);
    assert.equal(st.sleepTimer._idleTimeout, 2 ** 31 - 1, '远未来定时器不能溢出成 1ms');
    assert.equal(h.calls.prompts.length, 0);
  });
});

test('兜底轮询不会复活已被处理掉的旧唤醒', async () => {
  await fixture(async ({ h, st, append, wake }) => {
    append('第一条');
    await wake();
    const sid = h.state.sessions[KEY];
    h.collectors.set(sid, { stub: true });
    h.pendingWakeKeys.delete(KEY);
    append('第二条');
    await h.sendWakePromptV2(KEY, 'question');
    assert.ok((st.pendingWakeReasons ?? []).length > 0, '应有一条积压唤醒');
    // AI 在那一轮里其实已经把未读处理完了（unread 清空），此时旧唤醒不该再复活
    st.unread.length = 0;
    h.collectors.delete(sid);
    h.v2TurnStartAt.delete(sid);
    h.pendingWakeKeys.delete(KEY);
    h.sweepPendingWakeReasonsV2();
    await sleep(1500);
    assert.equal((st.pendingWakeReasons ?? []).length, 0, '已处理的唤醒应被丢弃');
    assert.equal(Boolean(st.pendingWakeTimer), false, '不应为已处理的消息排下一次唤醒');
    assert.equal(h.calls.prompts.length, 1, '不应为已处理的消息再唤醒一次');
  });
}, { timeout: 30000 });

test('新会话的提示词里带着已读/未读快照（这就是替代原上下文的机制）', async () => {
  await fixture(async ({ h, append, wake }) => {
    append('你好呀');
    append('在吗');
    await wake();
    const text = h.calls.prompts[0].content[0].text;
    assert.ok(text.includes('【本次消息快照】'), '提示词必须内联快照');
    assert.ok(text.includes('readThroughSeq'), '快照必须带已读水位，模型才知道自己读到哪了');
    assert.ok(/你好呀|在吗/.test(text), '快照必须带未读消息原文');
    assert.ok(text.includes('qq_mark_read'), '提示词必须说明如何用已读标记收尾');
  });
}, { timeout: 30000 });

test('开启时默认给更多最近消息（新会话要靠这些接上话头）', async () => {
  await fixture(async ({ h }) => {
    assert.equal(h.cfg.socialV2.context.wakeRecentLimit, 10);
    assert.equal(h.cfg.socialV2.context.wakeMaxChars, 9000);
  });
}, { timeout: 30000 });

test('显式配置优先于「新会话模式的推荐默认」', async () => {
  await fixture(async ({ h }) => {
    assert.equal(h.cfg.socialV2.context.wakeRecentLimit, 3);
    assert.equal(h.cfg.socialV2.context.wakeMaxChars, 4000);
  }, { wakeRecentLimit: 3, wakeMaxChars: 4000 });
}, { timeout: 30000 });
