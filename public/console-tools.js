/* MCP 管理页：工具、底层动作、参数和提示词各有明确入口。依赖主控制台的 api()。 */
(() => {
  const host = document.getElementById('tsGroups');
  if (!host) return;
  const state = { groups: [], group: 'all', tab: 'tools', query: '', selected: null, key: '', busy: false, automations: { rules: [], eventTypes: [], references: {} }, automationDraft: null };
  const promptDrafts = new Map();
  const callDrafts = new Map();
  const el = (tag, text, cls) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  };
  const button = (text, callback) => {
    const node = el('button', text); node.type = 'button';
    node.addEventListener('click', callback); return node;
  };
  const pill = text => el('span', text, 'tm-pill');
  const toolbar = el('div', undefined, 'tm-toolbar');
  const search = el('input'); search.id = 'tmSearch'; search.type = 'search';
  search.placeholder = '搜索工具名、动作、参数或说明'; search.setAttribute('aria-label', search.placeholder);
  toolbar.append(search, button('刷新配置', () => load()), el('a', 'SnowLuma API 文档'));
  const docs = toolbar.lastChild; docs.href = 'https://snowluma.github.io/zh/docs/api'; docs.target = '_blank'; docs.rel = 'noreferrer';
  const summary = el('div', '', 'meta'); summary.id = 'tmSummary';
  const notice = el('div', '开关保存后立即影响调用权限；新增工具、动作和参数 schema 需重启 DSH 后挂载。这里显示配置状态，未检测 DSH 当前工具清单。提示词保存后立即生效。', 'tm-notice');
  const status = el('div', '', 'tm-status'); status.id = 'tmStatus'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const layout = el('div', undefined, 'tm-layout');
  const groups = el('nav', undefined, 'tm-groups'); groups.setAttribute('aria-label', '工具分组');
  const main = el('div', undefined, 'tm-main'); layout.append(groups, main);
  host.replaceChildren(toolbar, summary, notice, status, layout);

  const report = (text, failed = false) => { status.textContent = text; status.className = `tm-status ${failed ? 'err' : 'ok'}`; };
  async function request(url, method, body) {
    const result = await api(url, method, body);
    if (result?.ok === false) throw new Error(result.error || '请求失败');
    return result;
  }
  async function load() {
    try {
      const [result, automations] = await Promise.all([request('/api/socialV2/tool-prompts'), request('/api/tool-automations')]);
      state.groups = result.groups || []; state.automations = automations; render();
    } catch (error) { report(`加载失败：${error.message}`, true); }
  }
  async function save(patch, success = '配置已保存；请重启 DSH 刷新工具清单。') {
    if (state.busy) return;
    state.busy = true; render();
    try {
      await request('/api/socialV2/config', 'POST', patch);
      await load(); report(success);
    } catch (error) { report(`保存失败：${error.message}；原配置未改变。`, true); }
    finally { state.busy = false; render(); }
  }
  function toggle(text, checked, callback, disabled = false) {
    const label = el('label', undefined, 'tm-toggle');
    const input = el('input'); input.type = 'checkbox'; input.checked = checked;
    input.disabled = disabled || state.busy;
    input.addEventListener('change', () => callback(input.checked));
    label.append(input, document.createTextNode(text)); return label;
  }
  function matches(item) { return !state.query || JSON.stringify(item).toLowerCase().includes(state.query); }
  function activeGroups() { return state.groups.filter(g => state.group === 'all' || g.id === state.group); }
  function render() {
    const core = state.groups.flatMap(g => g.legacyTools || []);
    const suite = state.groups.flatMap(g => g.mcpTools || []);
    const actions = state.groups.flatMap(g => g.actions);
    summary.textContent = `${core.length} 个基础工具 · ${suite.length} 个扩展工具（已配置 ${suite.filter(t => t.enabled).length}）· ${actions.length} 个底层动作`;
    groups.replaceChildren();
    for (const g of [{ id: 'all', label: '全部分组' }, ...state.groups]) {
      const item = button(g.label, () => { state.group = g.id; state.selected = null; render(); });
      item.setAttribute('aria-pressed', String(state.group === g.id)); item.dataset.group = g.id;
      if (g.actions) item.append(el('span', `${(g.legacyTools || []).length + (g.mcpTools || []).length} 工具 · ${g.actions.filter(a => a.enabled).length}/${g.actions.length} 动作已配置`, 'tm-count'));
      groups.append(item);
    }
    main.replaceChildren();
    const current = state.groups.find(g => g.id === state.group);
    const heading = el('div', undefined, 'tm-heading'); heading.append(el('h3', current?.label || '全部工具'));
    if (current?.mcpTools?.length) heading.append(toggle('扩展组开关', current.groupEnabled, enabled => save({ toolGroups: { [current.id]: { enabled } } })));
    main.append(heading);
    if (current) {
      const actionsBar = el('div', undefined, 'tm-actions');
      const readonly = current.actions.filter(a => a.readOnly && a.supported);
      if (readonly.length) actionsBar.append(button('启用本组只读动作', () => save({ toolGroups: { [current.id]: { enabled: true } }, tools: Object.fromEntries(readonly.map(a => [a.action, true])) })));
      main.append(actionsBar);
    }
    const tabs = el('div', undefined, 'tm-tabs');
    for (const [id, label] of [['tools', '工具清单'], ['actions', '动作目录'], ['prompts', '私有提示词'], ['wake', '事件与定时唤醒']]) {
      const tab = button(label, () => { state.tab = id; state.selected = null; render(); });
      tab.setAttribute('aria-pressed', String(state.tab === id)); tab.dataset.tab = id; tabs.append(tab);
    }
    main.append(tabs);
    if (state.tab === 'prompts') { renderPrompts(); return; }
    if (state.tab === 'wake') { renderAutomations(); return; }
    const grid = el('div', undefined, 'tm-grid');
    for (const g of activeGroups()) {
      if (state.tab === 'tools') {
        for (const t of g.legacyTools || []) {
          if (!matches(t)) continue;
          const card = el('article', undefined, 'tm-card'); card.dataset.tool = t.name;
          card.append(pill('基础工具'), pill(g.label), el('h4', t.name), el('p', t.description));
          card.append(toggle(t.enabled ? '已配置启用' : '未启用', t.configured, enabled => save({ tools: { [t.flag]: enabled } }), !t.flag));
          if (!t.flag) card.append(el('p', '由运行模式管理，无独立开关。'));
          else if (t.configured && !t.enabled) card.append(el('p', '功能总开关未开启，或该工具需要显式授权。'));
          else card.append(el('p', `开关：${t.flag}；同名开关的工具一起生效。`));
          grid.append(card);
        }
        for (const t of g.mcpTools || []) {
          if (!matches({ ...t, label: g.label })) continue;
          const card = el('article', undefined, 'tm-card'); card.dataset.tool = t.name;
          card.append(pill(t.kind === 'channel' ? '组合工具' : '独立工具'), pill(g.label), el('h4', t.name), el('p', t.description));
          card.append(el('p', `${t.enabled ? '已配置' : '未配置'} · ${t.enabledActions.length}/${t.actions.length} 个动作`));
          const open = button('参数与动作', () => { state.selected = { group: g.id, tool: t.name, action: t.enabledActions[0] || t.actions[0] }; render(); main.querySelector('.tm-detail')?.scrollIntoView({ block: 'start' }); });
          card.append(open); grid.append(card);
        }
      } else {
        for (const a of g.actions) {
          if (!matches(a)) continue;
          const card = el('article', undefined, 'tm-card'); card.dataset.action = a.action;
          card.append(pill(a.readOnly ? '只读' : '写操作'), el('h4', a.action), el('p', a.summary));
          card.append(el('p', a.never ? '永久排除' : a.supported ? `承载工具：${a.tool}` : '未映射到扩展工具；不能通过此目录启用'));
          if (a.supported) card.append(button('查看参数', () => { state.selected = { group: g.id, tool: a.tool, action: a.action }; render(); }));
          grid.append(card);
        }
      }
    }
    main.append(grid.childElementCount ? grid : el('div', '没有匹配项。可切换分组或清空搜索。', 'tm-empty'));
    if (state.selected) renderDetail();
    if (state.busy) host.querySelectorAll('button,input[type=checkbox]').forEach(n => { n.disabled = true; });
  }
  function renderPrompts() {
    const global = el('a', '编辑全局提示词 → 人格与角色'); global.href = '#persona';
    main.append(global, el('p', '以下协议只在对应工具组有可用工具时内联；关闭注入可单独停用该组私有提示词。', 'meta'));
    for (const g of activeGroups().filter(g => g.defaultText || g.text)) {
      const card = el('div', undefined, 'tm-card tm-prompt');
      const draft = promptDrafts.get(g.id) ?? { text: g.text, enabled: g.enabled };
      const title = el('h4', g.label); const textarea = el('textarea'); textarea.rows = 7; textarea.maxLength = g.maxChars;
      textarea.value = draft.text; textarea.setAttribute('aria-label', `${g.label}调用提示词`);
      const count = el('span', `${textarea.value.length}/${g.maxChars}`, 'meta');
      textarea.oninput = () => { draft.text = textarea.value; promptDrafts.set(g.id, draft); count.textContent = `${textarea.value.length}/${g.maxChars} · 未保存`; };
      const enabled = toggle('注入此组提示词', draft.enabled, checked => { draft.enabled = checked; promptDrafts.set(g.id, draft); });
      const bar = el('div', undefined, 'tm-actions');
      bar.append(button('保存提示词', async () => {
        if (state.busy) return;
        state.busy = true;
        try {
          const result = await request('/api/socialV2/tool-prompts', 'POST', { group: g.id, text: draft.text, enabled: draft.enabled });
          promptDrafts.delete(g.id); state.groups = result.groups; report('提示词已保存，下次生成提示词时生效。');
        } catch (error) { report(`保存失败：${error.message}`, true); }
        finally { state.busy = false; render(); }
      }), button('恢复默认到编辑框', () => { draft.text = g.defaultText; promptDrafts.set(g.id, draft); render(); }), count);
      card.append(title, enabled, textarea, bar); main.append(card);
    }
  }
  function renderAutomations() {
    main.append(el('p', '每条规则可关联一个或多个工具，并分别选择消息/通知/申请唤醒与定时任务。只有选定工具仍启用、目标仍在白名单且二代 AI 未暂停时才会触发。', 'meta'));
    const list = el('div', undefined, 'tm-grid');
    for (const rule of state.automations.rules) {
      if (state.group !== 'all') {
        const group = state.groups.find(g => g.id === state.group);
        const names = [...(group.legacyTools || []), ...(group.mcpTools || [])].map(t => t.name);
        if (!rule.tools.some(t => names.includes(t))) continue;
      }
      const card = el('article', undefined, 'tm-card');
      card.append(el('h4', rule.name), el('p', rule.tools.join('、')),
        el('p', `${rule.events.length} 类事件 · 定时 ${rule.intervalMinutes ? rule.intervalMinutes + ' 分钟' : '关闭'}`),
        toggle('启用此规则', rule.enabled, enabled => saveAutomationRules(state.automations.rules.map(r => r.id === rule.id ? { ...r, enabled } : r))),
        button('编辑规则', () => { state.automationDraft = structuredClone(rule); render(); }));
      list.append(card);
    }
    main.append(list, button('新增工具唤醒规则', () => {
      state.automationDraft = { id: crypto.randomUUID(), name: '新的工具唤醒', enabled: false, tools: [], keys: [], events: ['message'], intervalMinutes: 0, cooldownSeconds: 60, reference: 'message', prompt: '结合 {{event}} 与当前会话 {{key}}，按选定工具的私有协议判断是否需要行动。' };
      render();
    }));
    const draft = state.automationDraft; if (!draft) return;
    const editor = el('div', undefined, 'tm-card tm-detail'); editor.id = 'tmAutomationEditor';
    const field = (text, input) => { const label = el('label', text); label.append(input); editor.append(label); return input; };
    editor.append(el('h3', '工具唤醒规则'));
    const name = el('input'); name.value = draft.name; name.oninput = () => { draft.name = name.value; }; field('规则名称', name);
    editor.append(toggle('规则总开关', draft.enabled, value => { draft.enabled = value; }));
    const tools = el('select'); tools.id = 'tmAutomationTools'; tools.multiple = true; tools.size = 8; tools.style.width = '100%';
    for (const g of state.groups) {
      const optgroup = el('optgroup'); optgroup.label = g.label;
      for (const tool of [...g.legacyTools, ...g.mcpTools]) { const o = el('option', `${tool.name}${tool.enabled ? '' : '（当前未启用）'}`); o.value = tool.name; o.selected = draft.tools.includes(tool.name); optgroup.append(o); }
      tools.append(optgroup);
    }
    tools.onchange = () => { draft.tools = [...tools.selectedOptions].map(o => o.value); }; field('关联工具（可多选）', tools);
    const keys = el('input'); keys.id = 'tmAutomationKeys'; keys.value = draft.keys.join(', '); keys.placeholder = 'group:123, private:456';
    keys.oninput = () => { draft.keys = keys.value.split(/[,，\s]+/).filter(Boolean); }; field('目标会话（须在白名单内）', keys);
    editor.append(toggle('收到消息时唤醒', draft.events.includes('message'), checked => { draft.events = draft.events.filter(e => e !== 'message'); if (checked) draft.events.push('message'); }));
    const events = el('select'); events.id = 'tmAutomationEvents'; events.multiple = true; events.size = 7; events.style.width = '100%';
    for (const item of state.automations.eventTypes.filter(e => e.id !== 'message')) { const o = el('option', item.label); o.value = item.id; o.selected = draft.events.includes(item.id); events.append(o); }
    events.onchange = () => { draft.events = [...(draft.events.includes('message') ? ['message'] : []), ...[...events.selectedOptions].map(o => o.value)]; }; field('其他 SnowLuma 事件（可多选）', events);
    const interval = el('input'); interval.id = 'tmAutomationInterval'; interval.type = 'number'; interval.min = '0'; interval.max = '43200'; interval.value = draft.intervalMinutes;
    interval.oninput = () => { draft.intervalMinutes = Number(interval.value); }; field('定时间隔（分钟；0 关闭，最短 1 分钟）', interval);
    const cooldown = el('input'); cooldown.type = 'number'; cooldown.min = '10'; cooldown.value = draft.cooldownSeconds;
    cooldown.oninput = () => { draft.cooldownSeconds = Number(cooldown.value); }; field('同一会话触发冷却（秒）', cooldown);
    const reference = el('select');
    for (const [value, label] of [['', '不注入参考提示词'], ['message', '消息唤醒回复参考'], ['proactive', '随机搭话 / 主动机会参考'], ['event', '上游事件处理参考']]) { const o = el('option', label); o.value = value; o.selected = value === (draft.reference || ''); reference.append(o); }
    reference.onchange = () => { draft.reference = reference.value || null; }; field('可选参考提示词', reference);
    const prompt = el('textarea'); prompt.id = 'tmAutomationPrompt'; prompt.rows = 8; prompt.maxLength = 8000; prompt.style.width = '100%'; prompt.value = draft.prompt;
    prompt.oninput = () => { draft.prompt = prompt.value; }; field('本规则的唤醒提示词（可用 {{key}}、{{tools}}、{{time}}、{{event}}）', prompt);
    editor.append(button('复制参考到编辑框', () => { if (draft.reference) { draft.prompt = state.automations.references[draft.reference] + '\n\n' + draft.prompt; draft.reference = null; render(); } }));
    const actions = el('div', undefined, 'tm-actions');
    actions.append(button('保存唤醒规则', async () => {
      const rules = state.automations.rules.filter(r => r.id !== draft.id); rules.push(draft);
      if (await saveAutomationRules(rules)) { state.automationDraft = null; render(); }
    }), button('放弃编辑', () => { state.automationDraft = null; render(); }));
    if (state.automations.rules.some(r => r.id === draft.id)) actions.append(button('删除规则', async () => { if (confirm('删除此工具唤醒规则？') && await saveAutomationRules(state.automations.rules.filter(r => r.id !== draft.id))) { state.automationDraft = null; render(); } }));
    editor.append(actions); main.append(editor);
  }
  async function saveAutomationRules(rules) {
    if (state.busy) return false;
    state.busy = true;
    try {
      state.automations = await request('/api/tool-automations', 'POST', { rules });
      report('唤醒规则已保存并生效；定时任务从保存时重新计时。'); return true;
    } catch (error) { report(`保存唤醒规则失败：${error.message}`, true); return false; }
    finally { state.busy = false; render(); }
  }
  function parameterTable(schema) {
    const table = el('table', undefined, 'tm-params'); const head = el('tr');
    for (const label of ['参数', '类型 / 必填', '说明']) head.append(el('th', label));
    const thead = el('thead'); thead.append(head); const tbody = el('tbody');
    for (const [name, info] of Object.entries(schema?.properties || {})) {
      const row = el('tr');
      const type = info.type || (info.anyOf ? info.anyOf.map(t => t.type).join(' / ') : 'JSON');
      row.append(el('td', name), el('td', `${type}${schema.required?.includes(name) ? ' · 必填' : ' · 可选'}`), el('td', [info.description, info.enum ? `可选：${info.enum.join('、')}` : '', info.default !== undefined ? `默认：${JSON.stringify(info.default)}` : ''].filter(Boolean).join('；')));
      tbody.append(row);
    }
    table.append(thead, tbody); return table;
  }
  function renderDetail() {
    const g = state.groups.find(g => g.id === state.selected.group);
    const t = g?.mcpTools?.find(t => t.name === state.selected.tool);
    const a = g?.actions.find(a => a.action === state.selected.action);
    if (!t || !a) return;
    const detail = el('div', undefined, 'tm-detail'); detail.id = 'tmDetail';
    detail.append(el('h3', t.name));
    const schema = el('details'); schema.append(el('summary', 'MCP 调用参数（模型使用）'), parameterTable(t.inputSchema)); detail.append(schema);
    const actionSelect = el('select'); actionSelect.id = 'tmAction'; actionSelect.setAttribute('aria-label', '选择动作');
    for (const name of t.actions) { const option = el('option', name); option.value = name; option.selected = name === a.action; actionSelect.append(option); }
    actionSelect.onchange = () => { state.selected.action = actionSelect.value; render(); };
    detail.append(el('h4', 'SnowLuma 动作参数与试调用'), actionSelect, el('p', a.summary));
    detail.append(toggle('选择此动作', a.configured, enabled => save({ tools: { [a.action]: enabled } })));
    if (!g.groupEnabled) detail.append(el('div', '此组尚未开启。动作选择会保留，开启扩展组开关后才会注册。', 'tm-notice'));
    detail.append(parameterTable(a.inputSchema));
    if (a.invariants?.length) detail.append(el('pre', JSON.stringify(a.invariants, null, 2)));
    const draft = callDrafts.get(a.action) ?? { values: {}, extra: '{}', dryRun: true, result: '' }; callDrafts.set(a.action, draft);
    const key = el('input'); key.id = 'tmKey'; key.placeholder = 'group:群号 或 private:QQ号'; key.value = state.key; key.setAttribute('aria-label', '试调用会话');
    key.oninput = () => { state.key = key.value; }; detail.append(key);
    const fields = el('div', undefined, 'tm-fields');
    for (const p of a.parameters) {
      const label = el('label', `${p.name}${p.required ? ' *' : ''}`); const type = p.schema?.type;
      const input = el(type === 'boolean' ? 'select' : 'input'); input.dataset.param = p.name;
      if (type === 'boolean') for (const [value, text] of [['', '不传（使用默认值）'], ['true', 'true'], ['false', 'false']]) { const o = el('option', text); o.value = value; input.append(o); }
      else input.type = ['integer', 'number'].includes(type) ? 'number' : 'text';
      input.value = draft.values[p.name] ?? '';
      input.placeholder = ['group_id', 'user_id'].includes(p.name) ? '留空时按会话自动补齐' : p.default !== undefined ? `默认：${JSON.stringify(p.default)}` : type === 'array' || type === 'object' ? '输入 JSON' : '';
      input.oninput = () => { draft.values[p.name] = input.value; };
      label.append(input, el('small', p.desc || p.schema?.description || '')); fields.append(label);
    }
    detail.append(fields);
    const advanced = el('details'); const extra = el('textarea'); extra.rows = 3; extra.value = draft.extra; extra.setAttribute('aria-label', '额外 JSON 参数');
    extra.oninput = () => { draft.extra = extra.value; };
    advanced.append(el('summary', '额外 JSON 参数（高级）'), extra); detail.append(advanced);
    detail.append(toggle('只校验，不调用 QQ 接口', draft.dryRun, checked => { draft.dryRun = checked; }));
    const output = el('pre', draft.result); output.id = 'tmResult'; output.setAttribute('role', 'status');
    const run = button('校验 / 试调用', async () => {
      try {
        if (!state.key.trim()) throw new Error('请填写会话 key');
        const params = JSON.parse(draft.extra || '{}');
        if (!params || Array.isArray(params) || typeof params !== 'object') throw new Error('额外参数必须是 JSON 对象');
        for (const p of a.parameters) {
          const raw = draft.values[p.name]; if (raw === undefined || raw === '') continue;
          const type = p.schema?.type;
          params[p.name] = ['integer', 'number'].includes(type) ? Number(raw) : ['boolean', 'array', 'object'].includes(type) ? JSON.parse(raw) : raw;
        }
        if (!draft.dryRun && !a.readOnly && !confirm(`执行 ${a.action} 会修改 QQ 状态，确认执行？`)) return;
        run.disabled = true;
        const result = await request('/api/socialV2/tools/call', 'POST', { key: state.key.trim(), action: a.action, params, dryRun: draft.dryRun });
        draft.result = JSON.stringify(result, null, 2);
      } catch (error) { draft.result = `失败：${error.message}`; }
      finally { output.textContent = draft.result; run.disabled = !a.enabled; }
    });
    run.disabled = !a.enabled || state.busy; detail.append(run, output); main.append(detail);
  }
  search.oninput = () => { state.query = search.value.trim().toLowerCase(); state.selected = null; render(); };
  window.addEventListener('beforeunload', event => { if (promptDrafts.size) { event.preventDefault(); event.returnValue = ''; } });
  load();
})();
