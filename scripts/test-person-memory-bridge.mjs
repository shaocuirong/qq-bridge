// 人物档案的**桥接集成**回归（走真实 HTTP 端点 + 真实 prompt 投递，全离线）。
//
// 为什么不能只做 person-memory.js 的单元测试：单元测试证明不了接线正确 ——
// 端点里少写一句 savePersonStore()、把 status 写成 candidate、或让证据原文混进注入块，
// 纯函数测试都会全绿，而线上表现是"AI 记不住人""AI 读到了别群的聊天原文"。
//
// 这里用一个虚拟网关 + VM 里的 bridge.js（scripts/audit-bridge-harness.mjs）跑完整链路：
//   群消息 → 记住"谁在说话" → AI 用 qq_person_note 写印象 → 查询 → 控制台可见证据
//   → 下一次投递的 prompt 里出现【人物印象】（且**不含**证据原文/别群名）。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const CONSOLE_TOKEN = 'fixture-console-token';
const AGENT_KEY = 'group:456';

function groupEvent(text, { userId = 111, nickname = '小张', card = '小张' } = {}) {
  return {
    self_id: 999,
    user_id: userId,
    group_id: 456,
    message_id: Math.floor(Math.random() * 1e6) + 1,
    message: [{ type: 'text', data: { text } }],
    sender: { user_id: userId, nickname, card },
  };
}

let passed = 0;
const ok = (name) => { passed += 1; console.log(`✅ ${name}`); };

const h = await bridgeHarness({ config: { socialV2: { enabled: true } } });
let server;
try {
  h.setMode('reserved2');
  h.setReady(true);
  // harness 的 main() 不会自己起控制台服务（它不真连网关），按既有测试的做法显式起。
  server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const endpoint = async (path, { method = 'GET', body, agentToken } = {}) => {
    const headers = { 'x-console-token': CONSOLE_TOKEN };
    // x-agent-call 是「这次调用来自智能体」的声明（桥接据此强制要求有效会话令牌）；
    // 控制台调用绝不能带它，否则会被集中关卡当成"漏传令牌的智能体"拒掉。
    if (agentToken) { headers['x-agent-token'] = agentToken; headers['x-agent-call'] = '1'; }
    if (body) headers['content-type'] = 'application/json';
    const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, body: json };
  };

  // 1. 群里有人说了一句话 → 桥接要记住"这个会话里谁在说话"（注入目标）与学习窗口。
  await h.handleIncoming('group', 456, groupEvent('我家猫又胖了'), h.cfg);
  const st = h.getSocialV2State(AGENT_KEY);
  const agentToken = st.agentToken;
  assert.ok(agentToken && agentToken.length >= 8, '会话应当有 agent token');
  ok('群消息进入桥接后拿到会话 agent token');

  // 2. AI 主动写一条印象（直接生效）——走真实端点。
  const note = await endpoint('/api/socialV2/person/note', {
    method: 'POST',
    agentToken,
    body: { key: AGENT_KEY, qq: '111', text: '喜欢猫，养了一只叫豆豆的橘猫', kind: 'trait' },
  });
  assert.equal(note.status, 200, `写印象应当成功，实际 ${note.status} ${JSON.stringify(note.body)}`);
  assert.equal(note.body.ok, true);
  assert.equal(note.body.target.qq, '111');
  assert.equal(note.body.created, true);
  assert.deepEqual(note.body.person.facts.map((f) => f.text), ['喜欢猫，养了一只叫豆豆的橘猫']);
  ok('qq_person_note 端点写入印象并直接生效');

  // 3. 查询：不带 q 只看本会话出现的人；带 q 是全库检索（跨群印象的用法）。
  const querySession = await endpoint(`/api/socialV2/person/query?key=${encodeURIComponent(AGENT_KEY)}`, { agentToken });
  assert.equal(querySession.status, 200);
  assert.equal(querySession.body.scope, 'session');
  assert.equal(querySession.body.people.length, 1);
  assert.equal(querySession.body.people[0].qq, '111');
  assert.equal(querySession.body.people[0].content, '喜欢猫，养了一只叫豆豆的橘猫');
  assert.equal(JSON.stringify(querySession.body).includes('我家猫又胖了'), false, 'AI 视图不得含证据原文');
  const queryLibrary = await endpoint(`/api/socialV2/person/query?key=${encodeURIComponent(AGENT_KEY)}&q=${encodeURIComponent('喜欢猫')}`, { agentToken });
  assert.equal(queryLibrary.body.scope, 'library');
  assert.equal(queryLibrary.body.people[0].qq, '111', '全库检索应当按印象内容命中这个人');
  ok('qq_person_query 会话内/全库两种口径都可用');

  // 4. 控制台可见（含证据原文与来源会话），并标记为可写。
  const admin = await endpoint('/api/persons');
  assert.equal(admin.status, 200);
  assert.equal(admin.body.writable, true, '正常路径下档案库应当可写');
  const person = admin.body.entries.find((p) => p.qq === '111');
  assert.ok(person, '控制台应当能看到这条档案');
  assert.equal(person.content, '喜欢猫，养了一只叫豆豆的橘猫');
  assert.equal(person.facts[0].status, 'confirmed');
  assert.equal(person.facts[0].source, 'ai');
  // 控制台视图带 evidence 字段（AI 主动写的这条没有语境证据，自动提取的才有）；
  // 关键不变量是**反向**的：AI 视图里连 evidence 字段都不该出现（下面第 5 步再钉一次）。
  assert.ok(Array.isArray(person.facts[0].evidence), '控制台视图应带 evidence 字段');
  assert.equal(JSON.stringify(note.body.person).includes('evidence'), false, 'AI 写印象的回执不得带 evidence');
  assert.equal(admin.body.counts.confirmed, 1);
  ok('控制台 /api/persons 能看到档案、证据字段与统计');

  // 5. 下一次投递的 prompt 必须带上【人物印象】，且**不含**证据原文。
  await h.deliverPrompt(AGENT_KEY, '在聊什么', {});
  const sent = h.calls.prompts.at(-1);
  assert.ok(sent, '应当有一次 prompt 投递');
  const promptText = (sent.content || []).map((c) => c.text || '').join('\n');
  assert.match(promptText, /【人物印象】/);
  assert.match(promptText, /喜欢猫/);
  assert.match(promptText, /小张（QQ 111）/, '应当用本会话里的称呼');
  assert.ok(!promptText.includes('我家猫又胖了'), '证据原文绝不能进 AI 上下文');
  assert.equal(promptText.includes('evidence'), false, '注入块不得带 evidence 字段');
  ok('注入块含印象、不含证据原文');

  // 6. 隐私内容必须被拒（这是"跨群注入"场景下的硬边界）。
  const privacy = await endpoint('/api/socialV2/person/note', {
    method: 'POST', agentToken, body: { key: AGENT_KEY, qq: '111', text: '手机是 13800138000' },
  });
  assert.equal(privacy.status, 400, '隐私内容必须被拒绝');
  assert.match(String(privacy.body?.error || ''), /隐私/);
  ok('隐私内容被端点拒绝');

  // 7. 认不出人时必须拒绝并给出候选，而不是猜一个人写上去。
  const unknown = await endpoint('/api/socialV2/person/note', {
    method: 'POST', agentToken, body: { key: AGENT_KEY, name: '根本不存在的名字', text: '不知道是谁' },
  });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.candidates?.[0]?.qq, '111');
  ok('认不出人时拒绝并返回候选，不瞎猜');

  // 8. 智能体通道不得触碰控制台管理面（删人/改别人档案）。
  const agentAdmin = await endpoint('/api/persons/111', { method: 'DELETE', agentToken, body: {} });
  assert.equal(agentAdmin.status, 403, '智能体不得调用 /api/persons 管理面');
  const stillThere = await endpoint('/api/persons');
  assert.equal(stillThere.body.entries.length, 1, '被拒的删除不能生效');
  ok('智能体无法删除/管理人物档案');

  // 9. 分级审核语义：候选不进上下文，确认后才注入。
  const manual = await endpoint('/api/persons/222', {
    method: 'POST', body: { name: '小李', text: '在准备考研', kind: 'topic' },
  });
  assert.equal(manual.status, 200);
  const factId = manual.body.person.facts.at(-1).id;
  const restore = await endpoint(`/api/persons/222/facts/${encodeURIComponent(factId)}`, {
    method: 'POST', body: { status: 'candidate' },
  });
  assert.equal(restore.status, 200);
  assert.equal(restore.body.person.facts.find((f) => f.id === factId).status, 'candidate');

  // 先让 222 在本会话"说过话"，否则它根本不在注入目标里（那会掩盖"候选被注入"的真问题）。
  await h.handleIncoming('group', 456, groupEvent('这周要刷两套真题', { userId: 222, nickname: '小李', card: '小李' }), h.cfg);
  await h.deliverPrompt(AGENT_KEY, '再看看', {});
  const prompt2 = (h.calls.prompts.at(-1).content || []).map((c) => c.text || '').join('\n');
  assert.ok(!prompt2.includes('在准备考研'), '候选印象不得注入 AI 上下文');
  const confirm = await endpoint(`/api/persons/222/facts/${encodeURIComponent(factId)}`, {
    method: 'POST', body: { status: 'confirmed' },
  });
  assert.equal(confirm.status, 200);
  await h.deliverPrompt(AGENT_KEY, '再看一次', {});
  const prompt3 = (h.calls.prompts.at(-1).content || []).map((c) => c.text || '').join('\n');
  assert.match(prompt3, /在准备考研/, '确认后应当注入');
  ok('候选不注入、确认后才注入');

  const supplement = await endpoint('/api/persons/111', {
    method: 'POST', body: { name: '小张', text: '最近在学 Python', kind: 'topic' },
  });
  assert.equal(supplement.status, 200);
  assert.equal(supplement.body.person.content, '喜欢猫，养了一只叫豆豆的橘猫；最近在学 Python');
  assert.equal(supplement.body.person.facts.length, 2, '合并内容不能删除原条目');
  assert.equal((await endpoint('/api/persons')).body.entries.filter((p) => p.qq === '111').length, 1);
  ok('新印象与话题自动汇入同一人的合并内容');

  console.log(`\n🎉 人物档案桥接集成测试通过（${passed} 项）`);
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await h.close();
}
