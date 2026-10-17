/* MCP 管理页：工具、底层动作、参数和提示词各有明确入口。依赖主控制台的 api()。 */
(() => {
  const host = document.getElementById('tsGroups');
  if (!host) return;
  const state = { groups: [], group: 'all', tab: 'tools', query: '', selected: null, key: '', busy: false };
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
      const result = await request('/api/socialV2/tool-prompts');
      state.groups = result.groups || []; render();
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
    for (const [id, label] of [['tools', '工具清单'], ['actions', '动作目录'], ['prompts', '私有提示词']]) {
      const tab = button(label, () => { state.tab = id; state.selected = null; render(); });
      tab.setAttribute('aria-pressed', String(state.tab === id)); tab.dataset.tab = id; tabs.append(tab);
    }
    main.append(tabs);
    if (state.tab === 'prompts') { renderPrompts(); return; }
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
    const global = el('a', '编辑全局提示词 → 仿真提示词'); global.href = '#simulation';
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
