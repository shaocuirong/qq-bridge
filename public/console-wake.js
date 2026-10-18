/* 独立唤醒管理页；现有唤醒文案与事件/定时规则共用 /api/wake-rules。 */
(() => {
  const host = document.getElementById('wakeManager');
  if (!host) return;
  const state = { rules: [], prompts: [], promptGroups: [], eventTypes: [], references: {}, schedules: [], targets: [], adminKey: null,
    filters: { query: '', status: 'all', trigger: 'all', target: 'all', category: 'all' },
    draft: null, busy: false, promptId: 'message', builtinOpen: false };
  const WAKE_UI_VERSION = '2026-10-18d';
  const promptDrafts = new Map();
  // 目标要求由触发条件决定：消息/通知要会话，成员/群通知只要群，申请/网关/定时不需要。
  const targetModeOf = events => {
    const modes = events.map(id => state.eventTypes.find(item => item.id === id)?.target || 'session');
    if (modes.includes('session')) return 'session';
    if (modes.includes('group')) return 'group';
    return 'none';
  };
  const TARGET_MODE_LABELS = { session: '需要目标会话', group: '只需群聊', none: '无需目标会话' };
  const TARGET_MODE_HINTS = {
    session: '消息和私聊通知按所选会话的来信/事件触发。',
    group: '群成员、群禁言、群文件等事件只按群触发；私聊会话不会收到。',
    none: '申请、网关状态和定时任务不绑定 QQ 会话，会投递到管理员私聊会话。',
  };
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
  const versionBadge = el('span', `规则页 ${WAKE_UI_VERSION}`, 'wm-version');
  versionBadge.title = '看到这个版本号说明浏览器已加载最新的唤醒管理脚本';
  toolbar.append(el('p', '现有消息唤醒和主动机会继续按原参数运行。自定义规则补充事件和定时任务，共用同一套队列与限频。', 'meta'), versionBadge, button('刷新', load));
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
    state.draft = { id: crypto.randomUUID(), name: schedule ? '新的定时任务' : '新的事件唤醒', enabled: false, proactive: false, keys: [],
      events: schedule ? [] : ['message'], intervalMinutes: schedule ? 30 : 0, intervalMaxMinutes: 0, cooldownSeconds: 60, snapshotLimit: 10, reference: null,
      toolPromptMode: 'inherit', toolPromptGroups: state.promptGroups.map(group => group.id),
      prompt: state.references[schedule ? 'proactive' : 'message'] || '结合 {{event}} 与会话 {{key}} 判断是否需要行动。' };
    render(); document.getElementById('wakeRuleEditor').scrollIntoView({ block: 'start' });
  }
  function eventLabel(id) { return state.eventTypes.find(item => item.id === id)?.label || id; }
  function ruleTargetText(rule) {
    const mode = targetModeOf(rule.events);
    if (mode === 'none') return `无需目标会话，投递到管理员私聊${state.adminKey ? `（${state.adminKey}）` : ''}`;
    return rule.keys.join('、') || '未选择目标';
  }
  function ruleMatchesFilters(rule) {
    const filters = state.filters;
    const query = filters.query.trim().toLowerCase();
    if (query) {
      const haystack = [rule.name, rule.prompt, ...rule.keys, ...rule.events, ...rule.events.map(eventLabel),
        targetModeOf(rule.events) === 'none' ? '无需目标 管理员' : '需要目标'].join(' ').toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    if (filters.status === 'enabled' && !rule.enabled) return false;
    if (filters.status === 'disabled' && rule.enabled) return false;
    if (filters.trigger === 'event' && !rule.events.length) return false;
    if (filters.trigger === 'schedule' && !rule.intervalMinutes) return false;
    if (filters.trigger === 'both' && !(rule.events.length && rule.intervalMinutes)) return false;
    if (filters.target === 'targeted' && targetModeOf(rule.events) === 'none') return false;
    if (filters.target === 'none' && targetModeOf(rule.events) !== 'none') return false;
    if (filters.category !== 'all' && !rule.events.some(id => state.eventTypes.find(item => item.id === id)?.category === filters.category)) return false;
    return true;
  }
  function renderRuleItems() {
    const items = document.getElementById('wakeRuleItems');
    if (!items) return;
    const visible = state.rules.filter(ruleMatchesFilters);
    const count = document.getElementById('wakeRuleFilterCount');
    if (count) count.textContent = `显示 ${visible.length} / ${state.rules.length} 条`;
    items.replaceChildren();
    if (!visible.length) {
      items.append(el('p', state.rules.length ? '没有匹配的规则，换个筛选条件试试。' : '还没有自定义规则。原有的消息唤醒和主动机会仍然正常工作。', 'wm-empty'));
      return;
    }
    for (const rule of visible) {
      const row = el('article', undefined, 'wm-rule'); row.dataset.wakeRule = rule.id;
      const info = el('div');
      info.append(el('h4', rule.name));
      const triggers = rule.events.map(eventLabel);
      if (rule.intervalMinutes) {
        const max = Number(rule.intervalMaxMinutes) || 0;
        triggers.push(max > rule.intervalMinutes ? `每 ${rule.intervalMinutes}–${max} 分钟随机` : `每 ${rule.intervalMinutes} 分钟`);
      }
      info.append(el('p', triggers.join(' · ') || '未设置触发', 'meta'), el('p', ruleTargetText(rule), 'meta'));
      info.append(el('p', `事件快照：${rule.snapshotLimit ?? 1} 条`, 'meta'));
      info.append(el('p', rule.proactive ? '主动找机会：开启' : '主动找机会：关闭', 'meta'));
      info.append(el('p', rule.toolPromptMode === 'custom' ? `工具提示词：本规则自定义 ${(rule.toolPromptGroups ?? []).length} 组` : '工具提示词：沿用仿真页选择', 'meta'));
      const next = state.schedules.find(s => s.id === rule.id)?.nextRunAt;
      if (next) info.append(el('p', '下次定时检查：' + new Date(next).toLocaleString('zh-CN', { hour12: false }), 'meta'));
      const actions = el('div', undefined, 'wm-rule-actions');
      actions.append(checkbox(rule.enabled ? '已启用' : '未启用', rule.enabled, enabled => persist({ rules: state.rules.map(r => r.id === rule.id ? { ...r, enabled } : r) }, '规则开关已保存。')),
        button('编辑', () => { state.draft = structuredClone(rule); render(); document.getElementById('wakeRuleEditor').scrollIntoView({ block: 'start' }); }));
      row.append(info, actions); items.append(row);
    }
  }
  function renderRules() {
    const panel = el('div', undefined, 'wm-panel'); panel.id = 'wakeRuleList';
    const heading = el('div', undefined, 'wm-toolbar');
    heading.append(el('h3', `自定义事件与定时任务（${state.rules.length}）`), button('新增事件唤醒', () => newRule(false)), button('新增定时任务', () => newRule(true)));
    panel.append(heading, el('p', '编辑规则可设置「允许主动找机会」；申请/网关/定时任务不需要目标会话。', 'meta'));
    if (state.active === false) panel.append(el('p', '当前二代 AI 未运行或已暂停，规则暂不触发。恢复后定时任务重新计时。', 'meta'));
    const filters = el('div', undefined, 'wm-filters');
    const search = el('input'); search.id = 'wakeRuleSearch'; search.type = 'search'; search.placeholder = '名称 / 提示词 / 事件 / 目标'; search.value = state.filters.query;
    search.oninput = () => { state.filters.query = search.value; renderRuleItems(); };
    const select = (id, options, value, onChange) => {
      const node = el('select'); node.id = id;
      for (const [optionValue, label] of options) {
        const option = el('option', label); option.value = optionValue; option.selected = value === optionValue; node.append(option);
      }
      node.onchange = () => onChange(node.value); return node;
    };
    const status = select('wakeRuleStatusFilter', [['all', '全部状态'], ['enabled', '已启用'], ['disabled', '未启用']], state.filters.status,
      value => { state.filters.status = value; renderRuleItems(); });
    const trigger = select('wakeRuleTriggerFilter', [['all', '全部触发'], ['event', '仅事件'], ['schedule', '仅定时'], ['both', '事件+定时']], state.filters.trigger,
      value => { state.filters.trigger = value; renderRuleItems(); });
    const target = select('wakeRuleTargetFilter', [['all', '全部目标'], ['targeted', '需要目标'], ['none', '无需目标']], state.filters.target,
      value => { state.filters.target = value; renderRuleItems(); });
    const categories = [...new Set(state.eventTypes.map(item => item.category).filter(Boolean))];
    const category = select('wakeRuleCategoryFilter', [['all', '全部事件类型'], ...categories.map(item => [item, item])], state.filters.category,
      value => { state.filters.category = value; renderRuleItems(); });
    const count = el('span', '', 'wm-filter-count'); count.id = 'wakeRuleFilterCount';
    const reset = button('清空筛选', () => {
      state.filters = { query: '', status: 'all', trigger: 'all', target: 'all', category: 'all' };
      render();
    }, 'small');
    filters.append(field('搜索规则', search), field('状态', status), field('触发方式', trigger), field('目标会话', target), field('事件类型', category), reset, count);
    panel.append(filters);
    const items = el('div'); items.id = 'wakeRuleItems'; panel.append(items);
    content.append(panel);
    renderRuleItems();
  }
  function renderEditor() {
    const draft = state.draft;
    const editor = el('div', undefined, 'wm-panel'); editor.id = 'wakeRuleEditor';
    editor.append(el('h3', '编辑唤醒规则'));
    const name = el('input'); name.id = 'wakeRuleName'; name.value = draft.name; name.maxLength = 80;
    name.oninput = () => { draft.name = name.value; };
    const flags = el('div', undefined, 'wm-flags');
    const enabledBox = checkbox('启用这条规则', draft.enabled, enabled => { draft.enabled = enabled; });
    const proactiveBox = checkbox('允许主动找机会（没有待处理内容时也可以开话题）', draft.proactive === true, value => { draft.proactive = value; });
    proactiveBox.querySelector('input').dataset.wakeFlag = 'proactive';
    flags.append(el('h5', '规则行为'), enabledBox, proactiveBox);
    editor.append(field('规则名称', name), flags, el('p', '「允许主动找机会」只在本轮唤醒任务里追加主动开话题的许可；关闭时保持原提示词行为。', 'meta'));
    const targetMode = targetModeOf(draft.events);
    const targets = el('fieldset', undefined, 'wm-options'); targets.id = 'wakeRuleTargets';
    targets.append(el('legend', `目标会话（${TARGET_MODE_LABELS[targetMode]}）`));
    if (targetMode === 'none') {
      targets.append(el('p', `${TARGET_MODE_HINTS.none}${state.adminKey ? `当前管理员会话：${state.adminKey}。` : '当前没有可用的管理员私聊会话，请先在访问与安全里添加。'}`, 'meta'));
    } else {
      const available = state.targets.filter(key => targetMode !== 'group' || key.startsWith('group:'));
      const candidates = [...new Set([...available, ...draft.keys])].filter(key => targetMode !== 'group' || key.startsWith('group:'));
      for (const [label, keys] of [['群聊', candidates.filter(key => key.startsWith('group:'))], ['私聊', candidates.filter(key => key.startsWith('private:'))]]) {
        if (!keys.length) continue;
        const section = el('div', undefined, 'wm-target-group');
        section.append(el('h5', label));
        for (const key of keys) {
          section.append(checkbox(key.startsWith('group:') ? `群聊 ${key.slice(6)}` : `私聊 ${key.slice(8)}`, draft.keys.includes(key), checked => {
            draft.keys = draft.keys.filter(k => k !== key); if (checked) draft.keys.push(key);
          }));
        }
        targets.append(section);
      }
      if (!candidates.length) targets.append(el('p', targetMode === 'group' ? '请先在访问与安全中添加白名单群聊。' : '请先在访问与安全中添加白名单会话。', 'meta'));
      const bulk = el('div', undefined, 'wm-target-actions');
      bulk.append(button('全选当前可用', () => { draft.keys = [...available]; render(); }, 'small'),
        button('清空目标', () => { draft.keys = []; render(); }, 'small'));
      targets.append(bulk);
      if (targetMode === 'group' && draft.keys.some(key => !key.startsWith('group:'))) targets.append(el('p', '私聊目标会被忽略：群成员/群通知事件只按群触发。', 'meta'));
      targets.append(el('p', TARGET_MODE_HINTS[targetMode], 'meta'));
    }
    editor.append(targets);
    const events = el('fieldset', undefined, 'wm-options'); events.id = 'wakeRuleEvents'; events.append(el('legend', '事件触发'));
    for (const item of state.eventTypes) {
      const suffix = item.target === 'session' ? '（需会话）' : item.target === 'group' ? '（仅群）' : '（无需会话）';
      const check = checkbox(`${item.label}${suffix}`, draft.events.includes(item.id), checked => {
        draft.events = draft.events.filter(e => e !== item.id); if (checked) draft.events.push(item.id);
        render();
      });
      check.querySelector('input').dataset.wakeEvent = item.id; events.append(check);
    }
    editor.append(events, el('p', '消息/通知类规则按所选会话触发；申请、网关状态和定时任务不需要目标会话，统一投递管理员私聊会话。触发仍经过冷却与合批。', 'meta'));
    const timing = el('div', undefined, 'wm-fields');
    const interval = el('input'); interval.id = 'wakeRuleInterval'; interval.type = 'number'; interval.min = '0'; interval.max = '43200'; interval.value = draft.intervalMinutes;
    interval.oninput = () => { draft.intervalMinutes = Number(interval.value); };
    const intervalMax = el('input'); intervalMax.id = 'wakeRuleIntervalMax'; intervalMax.type = 'number'; intervalMax.min = '0'; intervalMax.max = '43200'; intervalMax.value = draft.intervalMaxMinutes ?? 0;
    intervalMax.oninput = () => { draft.intervalMaxMinutes = Number(intervalMax.value); };
    const cooldown = el('input'); cooldown.id = 'wakeRuleCooldown'; cooldown.type = 'number'; cooldown.min = '10'; cooldown.max = '86400'; cooldown.value = draft.cooldownSeconds;
    cooldown.oninput = () => { draft.cooldownSeconds = Number(cooldown.value); };
    timing.append(field('定时间隔 / 随机下限（分钟，0 表示关闭）', interval), field('随机上限（分钟，0/等于下限 = 固定）', intervalMax));
    editor.append(timing, field('同一会话触发冷却（秒）', cooldown),
      el('p', '设置随机上限后，每次触发后会在 [下限, 上限] 分钟之间重新随机；上限为 0 或等于下限时按固定间隔。定时从保存/启动开始计时，暂停期间不补跑。', 'meta'));
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
    draft.toolPromptGroups ??= state.promptGroups.map(group => group.id);
    draft.toolPromptMode ??= 'inherit';
    const promptMode = el('select'); promptMode.id = 'wakeRuleToolPromptMode';
    for (const [id, label] of [['inherit', '沿用仿真页选择（默认）'], ['custom', '本规则自定义']]) {
      const option = el('option', label); option.value = id; option.selected = id === draft.toolPromptMode; promptMode.append(option);
    }
    promptMode.onchange = () => { draft.toolPromptMode = promptMode.value; render(); };
    editor.append(field('工具提示词注入方式', promptMode));
    const promptGroups = el('fieldset', undefined, 'wm-options'); promptGroups.id = 'wakeRuleToolPrompts';
    promptGroups.append(el('legend', '本规则注入的工具提示词（可多选，默认全选）'));
    for (const group of state.promptGroups) {
      const check = checkbox(group.label, draft.toolPromptGroups.includes(group.id), checked => {
        draft.toolPromptGroups = draft.toolPromptGroups.filter(id => id !== group.id);
        if (checked) draft.toolPromptGroups.push(group.id);
        draft.toolPromptMode = 'custom'; render();
      });
      check.querySelector('input').dataset.wakePromptGroup = group.id; promptGroups.append(check);
    }
    const promptActions = el('div', undefined, 'wm-toolbar');
    promptActions.append(button('全选工具提示词', () => { draft.toolPromptMode = 'custom'; draft.toolPromptGroups = state.promptGroups.map(group => group.id); render(); }),
      button('清空工具提示词', () => { draft.toolPromptMode = 'custom'; draft.toolPromptGroups = []; render(); }));
    editor.append(promptGroups, promptActions, el('p', draft.toolPromptMode === 'custom'
      ? '当前以本规则选择为准，不受仿真页勾选限制；清空表示不注入工具提示词。可切回“沿用仿真页选择”。工具本身仍须启用，多条规则合批时合并各自生效的协议。'
      : '当前沿用仿真页的工具提示词选择。修改勾选会自动切换为本规则自定义，自定义初始全选；保存其他规则参数不会改变注入方式。', 'meta'));
    const prompt = el('textarea'); prompt.id = 'wakeRulePrompt'; prompt.rows = 8; prompt.maxLength = 8000; prompt.value = draft.prompt;
    prompt.oninput = () => { draft.prompt = prompt.value; };
    editor.append(field('本规则提示词', prompt), el('p', '可用变量：{{key}} 当前会话、{{event}} 事件数据、{{time}} 触发时间、{{reason}} 触发原因。定时任务从保存开始计时，暂停期间不补跑。', 'meta'));
    const actions = el('div', undefined, 'wm-toolbar');
    actions.append(button('保存规则', async () => {
      // 目标要求随触发条件变化：无需目标的规则清空 keys，仅群规则只保留群聊目标。
      const mode = targetModeOf(draft.events);
      const payload = { ...draft };
      if (mode === 'none') payload.keys = [];
      else if (mode === 'group') payload.keys = draft.keys.filter(key => key.startsWith('group:'));
      if (mode !== 'none' && !payload.keys.length) {
        report(mode === 'group' ? '请选择至少一个目标群。' : '请选择至少一个目标会话。', true); return;
      }
      const rules = state.rules.some(r => r.id === draft.id) ? state.rules.map(r => r.id === draft.id ? payload : r) : [...state.rules, payload];
      if (await persist({ rules }, '唤醒规则已保存并生效。')) { state.draft = null; render(); }
    }), button('取消编辑', () => { state.draft = null; render(); }));
    if (state.rules.some(r => r.id === draft.id)) actions.append(button('删除规则', async () => {
      if (await persist({ rules: state.rules.filter(r => r.id !== draft.id) }, '规则已删除。')) { state.draft = null; render(); }
    }, 'danger'));
    editor.append(actions); content.append(editor);
  }
  load();
})();
