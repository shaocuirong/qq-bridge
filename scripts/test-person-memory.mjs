// 人物档案（按 QQ 号跨群共享的印象/话题）自检：模型、裁剪、隐私过滤、注入块、提取解析。
// 不联网、不启动桥接、不读写真实 state/。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PERSON_FACT_KIND,
  PERSON_FACT_SOURCE,
  PERSON_FACT_STATUS,
  PERSON_MAX_FACTS,
  addPersonFact,
  bestName,
  buildPersonContext,
  buildPersonExtractionPrompt,
  capPersonRecords,
  findPerson,
  formatPersonCard,
  loadPersons,
  mergePersonContent,
  formatPersonRecord,
  looksSensitiveFact,
  normalizePersonRecord,
  normalizeQQ,
  parsePersonExtractionJson,
  removePersonFact,
  savePersons,
  searchPersons,
  setPersonFactStatus,
  upsertPerson,
} from '../src/person-memory.js';

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`✅ ${name}`);
}

// 1. QQ 号规范化：只接受纯数字
{
  assert.equal(normalizeQQ('123456'), '123456');
  assert.equal(normalizeQQ(123456), '123456');
  assert.equal(normalizeQQ(' 998 '), '998');
  assert.equal(normalizeQQ('abc'), null);
  assert.equal(normalizeQQ('12x34'), null);
  assert.equal(normalizeQQ(''), null);
  assert.equal(normalizeQQ('0000'), null);
  assert.equal(normalizeQQ('1234567890123'), null, '超过 12 位不是 QQ 号');
  ok('normalizeQQ 只接受 1~12 位纯数字');
}

// 2. 隐私过滤：手机号/邮箱/卡号/密码类不记
{
  assert.equal(looksSensitiveFact('喜欢猫'), false);
  assert.equal(looksSensitiveFact('在准备考研'), false);
  assert.equal(looksSensitiveFact('手机是 13800138000'), true);
  assert.equal(looksSensitiveFact('邮箱 a.b@example.com'), true);
  assert.equal(looksSensitiveFact('身份证 110101199003071234'), true);
  assert.equal(looksSensitiveFact('银行卡 6222021234567890123'), true);
  assert.equal(looksSensitiveFact('他的密码是 abc'), true);
  assert.equal(looksSensitiveFact('卡号 6222021234567890'), true, '长数字一律不记（可能是卡号/单号）');
  ok('looksSensitiveFact 拦掉明显隐私/凭据内容');
}

// 3. normalizePersonRecord：非法 QQ 直接丢，敏感事实丢，字段限长
{
  assert.equal(normalizePersonRecord({ id: 'not-a-qq' }), null);
  const p = normalizePersonRecord({
    id: '10001',
    names: ['张三', { name: '小张' }, ''],
    groups: [{ id: 'group:123', name: '演示群' }],
    facts: [
      { text: '喜欢猫', status: 'confirmed', source: 'ai' },
      { text: '手机 13800138000' },
      { text: 'x'.repeat(500) },
    ],
  });
  assert.equal(p.id, '10001');
  assert.deepEqual(p.names.map((n) => n.name), ['张三', '小张']);
  assert.equal(p.groups[0].id, 'group:123');
  assert.equal(p.facts.length, 2, '敏感事实必须被丢弃');
  assert.equal(p.facts[0].status, PERSON_FACT_STATUS.CONFIRMED);
  assert.ok(p.facts[1].text.length <= 120);
  ok('normalizePersonRecord 清洗昵称/群/事实并丢弃敏感内容');
}

// 4. upsertPerson：按 QQ 号认人（跨群同一人），昵称与群各自累积
{
  let records = [];
  let r = upsertPerson(records, '10001', { name: '张三', groupId: 'group:1', groupName: 'A群' });
  records = r.records;
  assert.equal(r.created, true);
  r = upsertPerson(records, '10001', { name: '小张', groupId: 'group:2', groupName: 'B群' });
  assert.equal(r.created, false, '同一个 QQ 号在不同群必须是同一条档案');
  records = r.records;
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].groups.map((g) => g.id).sort(), ['group:1', 'group:2']);
  // 两个名字计数相同，bestName 按最近使用时间打破平局；让「张三」计数更高，
  // 避免测试依赖两次 upsert 是否落在同一毫秒（此前会随机返回「小张」）。
  records[0].names.find((n) => n.name === '张三').count = 2;
  assert.equal(bestName(records[0]), '张三');
  assert.equal(bestName({ names: [
    { name: '旧名', count: 1, lastAt: '2026-01-01T00:00:00.000Z' },
    { name: '新名', count: 1, lastAt: '2026-01-02T00:00:00.000Z' }
  ] }), '新名');
  assert.equal(findPerson(records, '10001')?.id, '10001');
  assert.equal(findPerson(records, '99999'), null);
  ok('upsertPerson 按 QQ 号跨群合并为同一条档案');
}

// 5. addPersonFact：去重累加、AI 写入直接确认、候选可升级、敏感丢弃
{
  let records = upsertPerson([], '10001', { name: '张三' }).records;
  const person = records[0];
  const first = addPersonFact(person, { text: '喜欢猫', kind: PERSON_FACT_KIND.TRAIT, status: PERSON_FACT_STATUS.CANDIDATE, source: PERSON_FACT_SOURCE.AUTO, evidence: [{ key: 'group:1', text: '我家猫又胖了' }] });
  assert.equal(first.created, true);
  assert.equal(first.fact.status, PERSON_FACT_STATUS.CANDIDATE);
  const again = addPersonFact(person, { text: '喜欢猫', status: PERSON_FACT_STATUS.CANDIDATE, source: PERSON_FACT_SOURCE.AUTO });
  assert.equal(again.created, false, '同一条事实不重复添加');
  assert.equal(again.fact.count, 2);
  const promoted = addPersonFact(person, { text: '喜欢猫', status: PERSON_FACT_STATUS.CONFIRMED, source: PERSON_FACT_SOURCE.AI });
  assert.equal(promoted.fact.status, PERSON_FACT_STATUS.CONFIRMED, 'AI 明确写入应把候选升级为已确认');
  assert.equal(promoted.fact.source, PERSON_FACT_SOURCE.AI);
  const blocked = addPersonFact(person, { text: '手机 13800138000' });
  assert.equal(blocked.blocked, true);
  assert.equal(person.facts.length, 1);
  ok('addPersonFact 去重/升级/拦隐私');

  assert.equal(setPersonFactStatus(person, promoted.fact.id, PERSON_FACT_STATUS.REJECTED)?.status, PERSON_FACT_STATUS.REJECTED);
  assert.equal(setPersonFactStatus(person, 'nope', PERSON_FACT_STATUS.CONFIRMED), null);
  assert.ok(removePersonFact(person, promoted.fact.id));
  assert.equal(person.facts.length, 0);
  assert.equal(removePersonFact(person, 'nope'), null);
  ok('setPersonFactStatus / removePersonFact 行为正确');
}

// 6. 单个人的事实上限：已确认的最后才被裁掉
{
  const person = upsertPerson([], '10002', { name: '李四' }).records[0];
  addPersonFact(person, { text: '已确认的事实', status: PERSON_FACT_STATUS.CONFIRMED, source: PERSON_FACT_SOURCE.AI });
  for (let i = 0; i < PERSON_MAX_FACTS + 10; i += 1) {
    addPersonFact(person, { text: `候选事实${i}`, status: PERSON_FACT_STATUS.CANDIDATE, source: PERSON_FACT_SOURCE.AUTO });
  }
  assert.equal(person.facts.length, PERSON_MAX_FACTS);
  assert.ok(person.facts.some((f) => f.text === '已确认的事实'), '裁剪不能丢掉已确认的事实');
  ok(`单个人事实按上限 ${PERSON_MAX_FACTS} 裁剪且保留已确认项`);
}

// 7. capPersonRecords：优先保留有已确认事实的档案
{
  const withFacts = upsertPerson([], '10001', { name: 'A' }).records[0];
  addPersonFact(withFacts, { text: '喜欢猫', status: PERSON_FACT_STATUS.CONFIRMED, source: PERSON_FACT_SOURCE.AI });
  const empty = upsertPerson([], '10002', { name: 'B' }).records[0];
  const { records, dropped } = capPersonRecords([empty, withFacts], 1);
  assert.equal(dropped, 1);
  assert.equal(records[0].id, '10001');
  ok('capPersonRecords 优先保留有已确认事实的档案');
}

// 8. load/save 往返 + 文件不存在视为空库 + 损坏抛错不静默清库
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'person-memory-'));
  const file = path.join(dir, 'persons.json');
  assert.deepEqual(loadPersons(file), [], '文件不存在 ⇒ 空库');

  const records = upsertPerson([], '10001', { name: '张三', groupId: 'group:1', groupName: 'A群' }).records;
  addPersonFact(records[0], { text: '喜欢猫', status: PERSON_FACT_STATUS.CONFIRMED, source: PERSON_FACT_SOURCE.AI });
  const saved = savePersons(file, records);
  assert.equal(saved.dropped, 0);
  const loaded = loadPersons(file);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].facts[0].text, '喜欢猫');

  fs.writeFileSync(file, '{ this is not json', 'utf8');
  assert.throws(() => loadPersons(file), /解析失败/, '损坏的档案库必须抛错，不能当空库');
  const quarantined = fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'));
  assert.equal(quarantined.length, 1, '损坏原文必须另存隔离文件');
  fs.rmSync(dir, { recursive: true, force: true });
  ok('loadPersons/savePersons 往返、空库、损坏隔离');
}

// 9. buildPersonContext：只注入本会话出现的人；不含证据、群名；无已确认事实的人不出现
{
  const a = upsertPerson([], '10001', { name: '张三', groupId: 'group:1', groupName: '私密A群' }).records[0];
  addPersonFact(a, { text: '喜欢猫', status: PERSON_FACT_STATUS.CONFIRMED, source: PERSON_FACT_SOURCE.AI, evidence: [{ key: 'group:1', text: '我家猫真胖', time: 1 }] });
  addPersonFact(a, { text: '待确认的猜测', status: PERSON_FACT_STATUS.CANDIDATE, source: PERSON_FACT_SOURCE.AUTO });
  const b = upsertPerson([a], '10002', { name: '李四' }).records[1];

  const ctx = buildPersonContext([a, b], [{ qq: '10001', name: '小张' }, { qq: '10002', name: '李四' }, { qq: '10003', name: '没档案的人' }], {});
  assert.ok(ctx.includes('小张（QQ 10001）：喜欢猫'), '应使用本会话里的称呼');
  assert.ok(!ctx.includes('待确认的猜测'), '候选事实不得注入');
  assert.ok(!ctx.includes('我家猫真胖'), '证据原文不得注入');
  assert.ok(!ctx.includes('私密A群'), '群名不得注入');
  assert.ok(!ctx.includes('张三'), '不应把别群的群名片当成本群称呼');
  assert.ok(!ctx.includes('李四'), '没有已确认事实的人不出现');
  assert.equal(buildPersonContext([a], [], {}), '');
  ok('buildPersonContext 只注入本会话出现且有已确认事实的人，且不含证据/群名');
}

// 10. formatPersonCard（给 AI）：不含 evidence
{
  const p = upsertPerson([], '10001', { name: '张三', groupId: 'group:1', groupName: 'A群' }).records[0];
  addPersonFact(p, { text: '喜欢猫', status: PERSON_FACT_STATUS.CONFIRMED, source: PERSON_FACT_SOURCE.AI, evidence: [{ key: 'group:1', text: '原文摘录', time: 1 }] });
  addPersonFact(p, { text: '候选', status: PERSON_FACT_STATUS.CANDIDATE, source: PERSON_FACT_SOURCE.AUTO });
  const card = formatPersonCard(p);
  assert.equal(card.qq, '10001');
  assert.deepEqual(card.facts.map((f) => f.text), ['喜欢猫']);
  assert.equal(card.candidates, 1);
  assert.equal(card.groupCount, 1);
  assert.equal(JSON.stringify(card).includes('原文摘录'), false, 'AI 卡片不得含证据原文');
  assert.equal(JSON.stringify(card).includes('A群'), false, 'AI 卡片不得含群名');
  ok('formatPersonCard 不含证据与群名');
}

// 11. searchPersons：QQ/昵称/事实都能搜
{
  const a = upsertPerson([], '10001', { name: '张三' }).records[0];
  addPersonFact(a, { text: '喜欢猫', status: PERSON_FACT_STATUS.CONFIRMED, source: PERSON_FACT_SOURCE.AI });
  const records = upsertPerson([a], '20002', { name: '李四' }).records;
  assert.deepEqual(searchPersons(records, '100').map((p) => p.id), ['10001']);
  assert.deepEqual(searchPersons(records, '李四').map((p) => p.id), ['20002']);
  assert.deepEqual(searchPersons(records, '喜欢猫').map((p) => p.id), ['10001']);
  assert.equal(searchPersons(records, '').length, 2);
  ok('searchPersons 支持 QQ / 昵称 / 事实搜索');
}

// 12. 提取 prompt 与解析
{
  const prompt = buildPersonExtractionPrompt(
    [{ qq: '10001', name: '张三', text: '我家猫又胖了' }],
    [{ qq: '10001', name: '张三', facts: ['喜欢猫'] }],
  );
  assert.ok(prompt.includes('qq="10001"'), 'prompt 必须给出说话人的 QQ 号');
  assert.ok(prompt.includes('已知档案'), 'prompt 必须带上已知档案避免重复');
  assert.ok(prompt.includes('不可信文本'), 'prompt 必须保留注入防护说明');
  assert.ok(prompt.includes('隐私'), 'prompt 必须写明禁止记录隐私');

  const parsed = parsePersonExtractionJson('根据 [1] 的分析：\n[{"qq":"10001","name":"张三","kind":"trait","text":"喜欢猫","source_id":"1"},{"qq":"abc","text":"非法QQ"},{"qq":"10002","text":"喜欢狗","kind":"怪kind"}]');
  assert.equal(parsed.length, 2, '非法 QQ 号的条目必须被丢掉');
  assert.equal(parsed[0].qq, '10001');
  assert.equal(parsed[0].kind, 'trait');
  assert.equal(parsed[1].kind, 'fact', '未知 kind 回退为 fact');
  assert.deepEqual(parsePersonExtractionJson('没有任何 JSON'), []);
  assert.deepEqual(parsePersonExtractionJson('[]', { strict: true }), []);
  assert.throws(() => parsePersonExtractionJson('没有任何 JSON', { strict: true }), /有效 JSON/);
  assert.throws(() => parsePersonExtractionJson('[{"content":"学 Python"}]', { strict: true }), /无效条目/);
  assert.match(prompt, /topic：/);
  assert.match(prompt, /话题不必长期稳定/);
  assert.match(prompt, /多条一致表现/);
  ok('buildPersonExtractionPrompt / parsePersonExtractionJson');
}

// 合并是完整内容的程序汇总，不改写原始事实，也不能把候选带进模型视图。
{
  const p = upsertPerson([], '10001', { name: '张三', groupId: '1' }).person;
  addPersonFact(p, { text: '喜欢猫', kind: 'trait', status: 'confirmed' });
  addPersonFact(p, { text: '最近在学 Python', kind: 'topic', status: 'confirmed' });
  addPersonFact(p, { text: '计划参加马拉松', kind: 'topic', status: 'candidate' });
  addPersonFact(p, { text: '已拒绝的猜测', status: 'rejected' });
  assert.equal(p.content, '喜欢猫；最近在学 Python；计划参加马拉松');
  assert.equal(formatPersonRecord(p).content, p.content);
  assert.equal(formatPersonRecord(p).contentByStatus.candidate, '计划参加马拉松');
  assert.equal(formatPersonCard(p).content, '喜欢猫；最近在学 Python');
  const ids = p.facts.map((f) => f.id);
  const grouped = mergePersonContent(p);
  assert.deepEqual(p.facts.map((f) => f.id), ids, '合并不得删除或替换原条目');
  assert.equal(grouped.includes('已拒绝'), false);
  const candidate = p.facts.find((f) => f.status === 'candidate');
  setPersonFactStatus(p, candidate.id, 'confirmed');
  assert.equal(formatPersonCard(p).content, grouped);
  removePersonFact(p, candidate.id);
  assert.equal(p.content, '喜欢猫；最近在学 Python');
  ok('同一人的印象和话题合为一份完整内容，审核与删除自动更新');
}
{
  const p = upsertPerson([], '10001').person;
  for (let i = 0; i < 10; i++) addPersonFact(p, { text: `话题${i}：${'具体内容'.repeat(20)}`, kind: 'topic', status: 'confirmed' });
  const merged = mergePersonContent(p);
  assert.ok(merged.length > 800, '合并内容不能受单条 120 字上限截断');
  assert.ok(merged.includes('话题0') && merged.includes('话题9'));
  assert.equal(mergePersonContent({ facts: [...p.facts, p.facts[0]] }), merged, '完全重复内容只展示一次');
  assert.equal(mergePersonContent({ facts: [{ text: '喜欢猫', status: 'confirmed' }, { text: '不喜欢猫', status: 'confirmed' }] }), '喜欢猫；不喜欢猫', '程序不能擅自推断和改写矛盾内容');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'person-merged-'));
  try {
    const file = path.join(dir, 'persons.json');
    savePersons(file, [p]);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[0].content, merged);
    assert.equal(loadPersons(file)[0].content, merged);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  ok('合并内容完整保存并可恢复，去重不丢不同表述');
}

console.log(`\n🎉 人物档案逻辑测试通过（${passed} 项）`);
