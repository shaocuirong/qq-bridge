import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';
const source = (text = '我最近在学 Python，卡在爬虫这里') => ({ qq: '111', name: '小张', text, time: Date.now() });
const fact = { qq: '111', name: '小张', kind: 'topic', text: '最近在学 Python，聊过爬虫问题', source_id: '1' };

async function fixture(run, { output = JSON.stringify([fact]), beforeResult, autoExtract = true } = {}) {
  const h = await bridgeHarness({ config: {
    slang: { enabled: false },
    personMemory: { enabled: true, autoExtract, extractMinMessages: 100 },
    socialV2: { proactive: { enabled: false }, sticker: { enabled: false } },
  } });
  h.setMode('reserved2');
  const prompt = h.api.sessions.prompt;
  h.api.sessions.prompt = async (params) => {
    const accepted = await prompt(params);
    beforeResult?.(h);
    // 故意在 prompt 接收回执返回前完成，复现快速 turn/end 的竞态。
    const waiters = h.learnerWaiters.get(params.sessionId) ?? [];
    const waiter = waiters.shift();
    if (!waiters.length) h.learnerWaiters.delete(params.sessionId);
    assert.ok(waiter, '投递前必须已注册学习结果等待者');
    clearTimeout(waiter.timer);
    waiter.resolve(output);
    return accepted;
  };
  const records = () => JSON.parse(fs.readFileSync(path.join(h.temp, 'state/persons.json'), 'utf8'));
  try { await run(h, records); } finally { await h.close(); }
}

test('手动学习绕过自动门槛，快速完成也能保存候选与证据', async () => fixture(async (h, records) => {
  h.personWindows.set(KEY, [source()]);
  const result = await h.runPersonExtraction(KEY, { force: true });
  assert.equal(result.status, 'completed');
  assert.equal(result.added, 1);
  assert.equal(result.analyzed, 1);
  assert.equal(h.personWindows.get(KEY).length, 0);
  const saved = records()[0].facts[0];
  assert.equal(saved.status, 'candidate');
  assert.equal(saved.source, 'auto');
  assert.equal(saved.evidence[0].text, source().text);
  assert.equal(h.learnerWaiters.size, 0);
}));

test('合法空数组消费素材，格式错误保留素材并报告失败', async () => {
  for (const output of ['[]', '我已分析完毕', '[{"content":"学 Python"}]']) {
    await fixture(async (h) => {
      h.personWindows.set(KEY, [source()]);
      const result = await h.runPersonExtraction(KEY, { force: true });
      assert.equal(result.status, output === '[]' ? 'empty' : 'failed');
      assert.equal(h.personWindows.get(KEY).length, output === '[]' ? 0 : 1);
      assert.equal(h.learnerWaiters.size, 0);
    }, { output });
  }
});

test('提取期间窗口发生裁剪，新到消息仍全部保留', async () => fixture(async (h) => {
  h.personWindows.set(KEY, [source()]);
  const result = await h.runPersonExtraction(KEY, { force: true });
  assert.equal(result.added, 1);
  assert.equal(h.personWindows.get(KEY).length, 100);
  assert.equal(h.personWindows.get(KEY)[0].text, '新消息0');
}, { beforeResult(h) { h.personWindows.set(KEY, Array.from({ length: 100 }, (_, i) => source(`新消息${i}`))); } }));

test('重启后手动学习可用群聊持久化消息，自动开关不影响手动操作', async () => fixture(async (h, records) => {
  h.appendSocialV2Message(KEY, '小张', source().text, source().text, false, false, 'm1', [], '111', []);
  h.appendSocialV2Message(KEY, '我', '机器人自己的话', '机器人自己的话', false, false, 'm2', [], '999', []);
  h.getSocialV2State(KEY).recentMessages.at(-1).isSelf = true;
  assert.equal((await h.runPersonExtraction(KEY)).status, 'skipped');
  const result = await h.runPersonExtraction(KEY, { force: true });
  assert.equal(result.analyzed, 1);
  assert.equal(result.added, 1);
  assert.equal(records()[0].id, '111');
}, { autoExtract: false }));

test('投递被拒会清理等待者并保留素材', async () => fixture(async (h) => {
  h.personWindows.set(KEY, [source()]);
  h.api.sessions.prompt = async () => ({ result: { ok: false, error: { code: 'rejected', message: 'fixture' } } });
  const result = await h.runPersonExtraction(KEY, { force: true });
  assert.equal(result.status, 'failed');
  assert.equal(h.personWindows.get(KEY).length, 1);
  assert.equal(h.learnerWaiters.size, 0);
}));

test('手动学习 HTTP 回执包含实际结果，无素材时明确提示', async () => fixture(async (h) => {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/persons/extract`;
  const request = () => fetch(url, { method: 'POST', headers: {
    'content-type': 'application/json', 'x-console-token': 'fixture-console-token',
  }, body: JSON.stringify({ key: KEY }) }).then((r) => r.json());
  try {
    const empty = await request();
    assert.equal(empty.ok, false);
    assert.match(empty.error, /素材不足/);
    h.personWindows.set(KEY, [source()]);
    const result = await request();
    assert.equal(result.ok, true);
    assert.equal(result.added, 1);
    assert.equal(result.results[0].status, 'completed');
    h.setReady(false);
    assert.equal((await request()).ok, false);
  } finally { await new Promise((resolve) => server.close(resolve)); }
}));

test('人物与黑话使用独立的工作区、会话、持久化记录和用量归属', async () => fixture(async (h) => {
  const slang = await h.ensureSlangLearnerSession();
  const person = await h.ensurePersonLearnerSession();
  assert.notEqual(person, slang);
  const read = (name) => JSON.parse(fs.readFileSync(path.join(h.temp, 'state', name), 'utf8'));
  assert.equal(read('slang-session.json').sessionId, slang);
  assert.equal(read('person-session.json').sessionId, person);
  const slangWorkspace = h.calls.workspaces.find((w) => w.path.endsWith('slang-agent'));
  const personWorkspace = h.calls.workspaces.find((w) => w.path.endsWith('person-agent'));
  assert.ok(slangWorkspace && personWorkspace);
  assert.notEqual(personWorkspace.workspaceId, slangWorkspace.workspaceId);
  assert.ok(h.calls.workspaceRenames.some((w) => w.workspaceId === personWorkspace.workspaceId && w.title === 'QQ 人物印象学习'));
  assert.equal(h.learnerSessionKeys.get(person), 'internal:人物学习');
  assert.equal(h.learnerSessions.has(person), true);
  h.personWindows.set(KEY, [source()]);
  await h.runPersonExtraction(KEY, { force: true });
  assert.equal(h.calls.prompts.at(-1).sessionId, person);
  assert.equal(h.calls.sent.length, 0, '后台学习不能发送 QQ');
}));

test('人物会话并发初始化只创建一次，内存丢失后复用已保存会话', async () => fixture(async (h) => {
  const sessions = await Promise.all([h.ensurePersonLearnerSession(), h.ensurePersonLearnerSession()]);
  assert.equal(sessions[0], sessions[1]);
  assert.equal(h.calls.created.length, 1);
  assert.equal(await h.ensurePersonLearnerSession(), sessions[0]);
  // 模拟进程重启只丢失内存，而保留独立会话记录。
  const file = path.join(h.temp, 'state/person-session.json');
  const saved = fs.readFileSync(file);
  h.invalidatePersonLearnerSession();
  fs.writeFileSync(file, saved);
  assert.equal(await h.ensurePersonLearnerSession(), sessions[0]);
  assert.equal(h.calls.created.length, 1);
}));

test('人物任务不会等待黑话队列，人物任务之间仍保持串行', async () => fixture(async (h) => {
  let releaseSlang;
  const blockedSlang = h.queueSlangTask(() => new Promise((resolve) => { releaseSlang = resolve; }));
  const order = [];
  let releasePerson;
  const first = h.queuePersonTask(async () => {
    order.push('start');
    await new Promise((resolve) => { releasePerson = resolve; });
    order.push('end');
  });
  const second = h.queuePersonTask(() => order.push('next'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['start']);
  releasePerson();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['start', 'end', 'next']);
  releaseSlang();
  await blockedSlang;
}));

test('人物 preset 与会话重建不影响黑话会话', async () => fixture(async (h) => {
  const slang = await h.ensureSlangLearnerSession();
  const first = await h.ensurePersonLearnerSession();
  h.cfg.personMemory.learnerPreset = 'qq-chat-v2';
  const second = await h.ensurePersonLearnerSession();
  assert.notEqual(second, first);
  assert.equal(h.calls.created.at(-1).agentPreset, 'qq-chat-v2');
  assert.equal(await h.ensureSlangLearnerSession(), slang);
  h.invalidateSlangLearnerSession();
  assert.equal(await h.ensurePersonLearnerSession(), second);
}));
