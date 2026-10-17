// 对真实页面的分组渲染函数做离线检查，不连接生产服务。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
const extract = (name) => {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function render(tab, query = '') {
  const people = [
    { qq: '111', names: [{ name: '小张' }], facts: [
      { id: '1', text: '喜欢猫', status: 'candidate' },
      { id: '2', text: '在学 Python', status: 'candidate' },
      { id: '3', text: '喜欢跑步', status: 'confirmed' },
    ] },
    { qq: '222', names: [{ name: '小李' }], facts: [{ id: '4', text: '养狗', status: 'candidate' }] },
  ];
  const boxes = new Map();
  const ctx = vm.createContext({
    personActiveTab: tab, esc,
    document: { getElementById(id) { if (!boxes.has(id)) boxes.set(id, { innerHTML: '' }); return boxes.get(id); } },
    personFilteredPeople: () => people.filter((p) => !query || p.qq === query),
    personDisplayName: (p) => p.names[0].name,
    personRowHtmlForPeople: (p) => `<tr>${p.qq}</tr>`,
    personRowHtmlForFact: (p, f) => `<tr data-fact="${f.id}">${esc(f.text)}</tr>`,
    bindPersonActions() {}, updatePersonSelectAll() {},
  });
  vm.runInContext(['personFactRows', 'personMergedContent', 'renderPersonPanel'].map(extract).join('\n') + '\nrenderPersonPanel();', ctx);
  return { html: boxes.get(tab === 'candidate' ? 'personListCandidate' : 'personListConfirmed').innerHTML, ctx };
}

test('候选按人显示一份完整内容，原审核条目仍在详情中', () => {
  const { html } = render('candidate');
  assert.equal((html.match(/data-person-group="111"/g) || []).length, 1);
  assert.equal((html.match(/data-person-group="222"/g) || []).length, 1);
  assert.match(html, /喜欢猫；在学 Python/);
  assert.match(html, /<details>/);
  for (const id of ['1', '2', '4']) assert.match(html, new RegExp(`data-fact="${id}"`));
  assert.doesNotMatch(html, /喜欢跑步/);
});

test('已确认视图与搜索不混入其它人或候选', () => {
  const { html } = render('confirmed', '111');
  assert.match(html, /喜欢跑步/);
  assert.doesNotMatch(html, /喜欢猫|养狗|data-person-group="222"/);
  const candidate = render('candidate', '111').html;
  assert.match(candidate, /共 1 人，2 条/);
  assert.doesNotMatch(candidate, /养狗/);
});
