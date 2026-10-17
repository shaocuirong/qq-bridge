/* 独立唤醒管理页；现有唤醒文案与事件/定时规则共用 /api/wake-rules。 */
(() => {
  const host = document.getElementById('wakeManager');
  if (!host) return;
  const state = { rules: [], prompts: [], eventTypes: [], references: {}, schedules: [], targets: [], draft: null, busy: false, promptId: 'message', builtinOpen: false };
  const promptDrafts = new Map();
  const el = (tag, text, cls) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  };
  const button = (text, onClick, cls) => {
    const node = el('button', text, cls); node.type = 'button'; node.onclick = onClick; return node;
  };
  const field = (labelText, input) => { const label = el('label', labelText, 'wm-field'); label.append(input); return label; };
  const checkbox = (labelText, checked, change) => {
    const input = el('input'); input.type = 'checkbox'; input.checked = checked;
    input.onchange = () => change(input.checked);
    const label = el('label', undefined, 'wm-check'); label.append(input, document.createTextNode(labelText)); return label;
  };
  const status = el('div', '', 'wm-status'); status.id = 'wakeManagerStatus'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const content = el('div');
  const toolbar = el('div', undefined, 'wm-toolbar');
  toolbar.append(el('p', '现有消息唤醒和主动机会继续按原参数运行。自定义规则补充事件和定时任务，共用同一套队列与限频。', 'meta'), button('刷新', load));
  host.replaceChildren(toolbar, status, content);
  const report = (text, failed = false) => { status.textContent = text; status.className = `wm-status ${failed ? 'err' : 'ok'}`; };
  async function request(url, method, body) {
    const result = await api(url, method, body);
    if (result?.ok === false) throw new Error(result.error || '请求失败');
    return result;
  }
  async function load() {
    try {
      const [view, runtime] = await Promise.all([request('/api/wake-rules'), request('/api/status')]);
      Object.assign(state, view);
      state.targets = [...(runtime.allowGroups || []).map(id => `group:${id}`), ...(runtime.allowPrivate || []).map(id => `private:${id}`)];
      render(); report('');
    } catch (error) { report(`读取唤醒配置失败：${error.message}`, true); }
  }
  async function persist(patch, message) {
    if (state.busy) return false;
    state.busy = true; render();
    try {
      Object.assign(state, await request('/api/wake-rules', 'POST', patch));
      report(message); return true;
    } catch (error) { report(`保存失败：${error.message}`, true); return false; }
    finally { state.busy = false; render(); }
  }
  function render() {
    content.replaceChildren();
    renderBuiltin(); renderRules();
    if (state.draft) renderEditor();
    if (state.busy) content.querySelectorAll('button,input,select,textarea').forEach(node => { node.disabled = true; });
  }
  function renderBuiltin() {
    const card = el('details', undefined, 'wm-panel'); card.id = 'wakeBuiltin'; card.open = state.builtinOpen;
    card.ontoggle = () => { state.builtinOpen = card.open; };
    card.append(el('summary', '现有唤醒提示词 · 消息回复、主动机会等六类场景'), el('p', '默认内容来自当前唤醒代码。这里只修改醒来后的任务文案，触发概率、安静时长和限频在下方单独保存。', 'meta'));
    const select = el('select'); select.id = 'wakePromptSelect';
    for (const item of state.prompts) { const option = el('option', item.label); option.value = item.id; option.selected = item.id === state.promptId; select.append(option); }
    select.onchange = () => { state.promptId = select.value; render(); };
    card.append(field('唤醒场景', select));
    const item = state.prompts.find(p => p.id === state.promptId);
    if (item) {
      const value = promptDrafts.get(item.id) ?? item.text;
      const textarea = el('textarea'); textarea.id = 'wakeBuiltinPrompt'; textarea.rows = 8; textarea.maxLength = 8000; textarea.value = value;
      textarea.oninput = () => { promptDrafts.set(item.id, textarea.value); };
      card.append(field('本场景提示词', textarea));
      const actions = el('div', undefined, 'wm-toolbar');
      actions.append(button('保存场景提示词', async () => {
        if (await persist({ prompts: { [item.id]: promptDrafts.get(item.id) ?? item.text } }, '场景提示词已保存，下一轮唤醒生效。')) { promptDrafts.delete(item.id); render(); }
      }), button('恢复原有默认内容', () => { promptDrafts.set(item.id, item.defaultText); render(); }));
      card.append(actions);
    }
    content.append(card);
  }
  function newRule(schedule) {
    state.draft = { id: crypto.randomUUID(), name: schedule ? '新的定时任务' : '新的事件唤醒', enabled: false, keys: [],
      events: schedule ? [] : ['message'], intervalMinutes: schedule ? 30 : 0, cooldownSeconds: 60, snapshotLimit: 10, reference: null,
      prompt: state.references[schedule ? 'proactive' : 'message'] || '结合 {{event}} 与会话 {{key}} 判断是否需要行动。' };
    render(); document.getElementById('wakeRuleEditor').scrollIntoView({ block: 'start' });
  }
  function renderRules() {
    const panel = el('div', undefined, 'wm-panel'); panel.id = 'wakeRuleList';
    const heading = el('div', undefined, 'wm-toolbar');
    heading.append(el('h3', `自定义事件与定时任务（${state.rules.length}）`), button('新增事件唤醒', () => newRule(false)), button('新增定时任务', () => newRule(true)));
    panel.append(heading);
    if (state.active === false) panel.append(el('p', '当前二代 AI 未运行或已暂停，规则暂不触发。恢复后定时任务重新计时。', 'meta'));
    if (!state.rules.length) panel.append(el('p', '还没有自定义规则。原有的消息唤醒和主动机会仍然正常工作。', 'wm-empty'));
    for (const rule of state.rules) {
      const row = el('article', undefined, 'wm-rule'); row.dataset.wakeRule = rule.id;
      const info = el('div');
      info.append(el('h4', rule.name));
      const triggers = rule.events.map(id => state.eventTypes.find(e => e.id === id)?.label || id);
      if (rule.intervalMinutes) triggers.push(`每 ${rule.intervalMinutes} 分钟`);
      info.append(el('p', triggers.join(' · '), 'meta'), el('p', rule.keys.join('、'), 'meta'));
      info.append(el('p', `事件快照：${rule.snapshotLimit ?? 1} 条`, 'meta'));
      const next = state.schedules.find(s => s.id === rule.id)?.nextRunAt;
      if (next) info.append(el('p', '下次定时检查：' + new Date(next).toLocaleString('zh-CN', { hour12: false }), 'meta'));
      const actions = el('div', undefined, 'wm-rule-actions');
      actions.append(checkbox(rule.enabled ? '已启用' : '未启用', rule.enabled, enabled => persist({ rules: state.rules.map(r => r.id === rule.id ? { ...r, enabled } : r) }, '规则开关已保存。')),
        button('编辑', () => { state.draft = structuredClone(rule); render(); document.getElementById('wakeRuleEditor').scrollIntoView({ block: 'start' }); }));
      row.append(info, actions); panel.append(row);
    }
    content.append(panel);
  }
  function renderEditor() {
    const draft = state.draft;
    const editor = el('div', undefined, 'wm-panel'); editor.id = 'wakeRuleEditor';
    editor.append(el('h3', '编辑唤醒规则'));
    const name = el('input'); name.id = 'wakeRuleName'; name.value = draft.name; name.maxLength = 80;
    name.oninput = () => { draft.name = name.value; };
    editor.append(field('规则名称', name), checkbox('启用这条规则', draft.enabled, enabled => { draft.enabled = enabled; }));
    const targets = el('fieldset', undefined, 'wm-options'); targets.append(el('legend', '目标会话'));
    for (const key of [...new Set([...state.targets, ...draft.keys])]) {
      targets.append(checkbox(key.startsWith('group:') ? `群聊 ${key.slice(6)}` : `私聊 ${key.slice(8)}`, draft.keys.includes(key), checked => {
        draft.keys = draft.keys.filter(k => k !== key); if (checked) draft.keys.push(key);
      }));
    }
    if (!state.targets.length) targets.append(el('p', '请先在访问与安全中添加白名单会话。', 'meta'));
    editor.append(targets);
    const events = el('fieldset', undefined, 'wm-options'); events.id = 'wakeRuleEvents'; events.append(el('legend', '事件触发'));
    for (const item of state.eventTypes) {
      const check = checkbox(item.label, draft.events.includes(item.id), checked => {
        draft.events = draft.events.filter(e => e !== item.id); if (checked) draft.events.push(item.id);
      });
      check.querySelector('input').dataset.wakeEvent = item.id; events.append(check);
    }
    editor.append(events, el('p', '收到消息规则按所选目标的每条来信触发，再经过冷却与合批；不替代 AI 已设定的 @、关键词等现有条件。', 'meta'));
    const timing = el('div', undefined, 'wm-fields');
    const interval = el('input'); interval.id = 'wakeRuleInterval'; interval.type = 'number'; interval.min = '0'; interval.max = '43200'; interval.value = draft.intervalMinutes;
    interval.oninput = () => { draft.intervalMinutes = Number(interval.value); };
    const cooldown = el('input'); cooldown.id = 'wakeRuleCooldown'; cooldown.type = 'number'; cooldown.min = '10'; cooldown.max = '86400'; cooldown.value = draft.cooldownSeconds;
    cooldown.oninput = () => { draft.cooldownSeconds = Number(cooldown.value); };
    timing.append(field('定时间隔（分钟，0 表示关闭）', interval), field('同一会话触发冷却（秒）', cooldown)); editor.append(timing);
    const snapshotLimit = el('input'); snapshotLimit.id = 'wakeRuleSnapshotLimit'; snapshotLimit.type = 'number'; snapshotLimit.min = '0'; snapshotLimit.max = '100'; snapshotLimit.step = '1'; snapshotLimit.value = draft.snapshotLimit ?? 1;
    snapshotLimit.oninput = () => { draft.snapshotLimit = Number(snapshotLimit.value); };
    editor.append(field('事件快照条数（0 不附加历史，最多 100 条）', snapshotLimit), el('p', '唤醒时拉取本会话最近的匹配事件，按时间顺序提供；纯定时任务可读取本会话各类近期事件。记录从桥接启动后开始保留，较大快照还受字数预算限制。', 'meta'));
    const reference = el('select'); reference.id = 'wakeRuleReference';
    for (const [id, label] of [['', '不额外注入参考'], ['message', '消息回复参考（当前文案）'], ['proactive', '主动机会参考（当前文案）'], ['event', '上游事件处理参考']]) {
      const option = el('option', label); option.value = id; option.selected = id === (draft.reference || ''); reference.append(option);
    }
    reference.onchange = () => { draft.reference = reference.value || null; render(); };
    editor.append(field('可选参考提示词', reference));
    if (draft.reference) {
      const preview = el('details', undefined, 'wm-reference'); preview.append(el('summary', '查看将注入的参考内容'), el('pre', state.references[draft.reference] || ''));
      preview.append(button('将参考内容放入编辑框', () => { draft.prompt = state.references[draft.reference]; draft.reference = null; render(); })); editor.append(preview);
    }
    const prompt = el('textarea'); prompt.id = 'wakeRulePrompt'; prompt.rows = 8; prompt.maxLength = 8000; prompt.value = draft.prompt;
    prompt.oninput = () => { draft.prompt = prompt.value; };
    editor.append(field('本规则提示词', prompt), el('p', '可用变量：{{key}} 当前会话、{{event}} 事件数据、{{time}} 触发时间、{{reason}} 触发原因。定时任务从保存开始计时，暂停期间不补跑。', 'meta'));
    const actions = el('div', undefined, 'wm-toolbar');
    actions.append(button('保存规则', async () => {
      const rules = state.rules.some(r => r.id === draft.id) ? state.rules.map(r => r.id === draft.id ? draft : r) : [...state.rules, draft];
      if (await persist({ rules }, '唤醒规则已保存并生效。')) { state.draft = null; render(); }
    }), button('取消编辑', () => { state.draft = null; render(); }));
    if (state.rules.some(r => r.id === draft.id)) actions.append(button('删除规则', async () => {
      if (await persist({ rules: state.rules.filter(r => r.id !== draft.id) }, '规则已删除。')) { state.draft = null; render(); }
    }, 'danger'));
    editor.append(actions); content.append(editor);
  }
  load();
})();
