/* 仿真页只管理工具协议的注入选择，与工具页共用唯一的 enabled 状态。 */
(() => {
  const host = document.getElementById('simToolPrompts');
  if (!host) return;
  let groups = [], selected = new Set(), original = new Set(), dirty = false, busy = false;
  const el = (tag, text, cls) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  };
  const button = (text, callback) => { const node = el('button', text); node.type = 'button'; node.onclick = callback; return node; };
  const status = el('div', '', 'tm-status'); status.id = 'simToolPromptsStatus'; status.setAttribute('role', 'status');
  const body = el('div');
  host.replaceChildren(el('h3', '选择注入的工具提示词'),
    el('p', '二代仿真按所选工具组内联私有协议；该组有可用工具时才实际注入。选择保存后下一轮生效，工具本身的开关不受影响。', 'meta'), status, body);
  const report = (text, failed = false) => { status.textContent = text; status.className = `tm-status ${failed ? 'err' : 'ok'}`; };
  const markDirty = () => { dirty = selected.size !== original.size || [...selected].some(id => !original.has(id)); };
  async function load() {
    try {
      const response = await api('/api/socialV2/tool-prompts');
      if (response.ok === false) throw new Error(response.error);
      groups = response.groups;
      original = new Set(groups.filter(g => g.enabled).map(g => g.id));
      if (!dirty) selected = new Set(original);
      markDirty(); render();
    } catch (error) { report(`读取失败：${error.message}`, true); }
  }
  function render() {
    host.hidden = document.getElementById('simPromptPreset').value !== 'qq-chat-v2';
    body.replaceChildren();
    const list = el('div', undefined, 'sim-prompt-options');
    let injecting = 0;
    for (const group of groups) {
      const available = [...(group.legacyTools || []), ...(group.mcpTools || [])].some(t => t.enabled);
      if (available && selected.has(group.id) && group.text.trim()) injecting++;
      const label = el('label', undefined, 'sim-prompt-option');
      const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(group.id); checkbox.disabled = busy;
      checkbox.dataset.promptGroup = group.id;
      checkbox.onchange = () => { if (checkbox.checked) selected.add(group.id); else selected.delete(group.id); markDirty(); render(); };
      const description = el('span'); description.append(el('strong', group.label), el('small', `${group.text.length} 字符 · ${available ? '有可用工具' : '等待该组工具启用'}`));
      label.append(checkbox, description); list.append(label);
    }
    body.append(el('p', `已选 ${selected.size} 组 · 当前可注入 ${injecting} 组${dirty ? ' · 尚未保存' : ''}`, 'meta'), list);
    const actions = el('div', undefined, 'tm-actions');
    actions.append(button('全选', () => { selected = new Set(groups.map(g => g.id)); markDirty(); render(); }),
      button('清空选择', () => { selected.clear(); markDirty(); render(); }),
      button('恢复已保存选择', () => { selected = new Set(original); markDirty(); render(); }));
    const save = button('保存工具提示词选择', async () => {
      if (busy) return;
      busy = true; render();
      try {
        const response = await api('/api/socialV2/tool-prompts/selection', 'POST', { selectedGroupIds: [...selected] });
        if (response.ok === false) throw new Error(response.error);
        groups = response.groups; original = new Set(groups.filter(g => g.enabled).map(g => g.id)); selected = new Set(original); dirty = false;
        report('工具提示词选择已保存，下一轮注入生效。');
        document.dispatchEvent(new Event('tool-prompts-updated'));
      } catch (error) { report(`保存失败：${error.message}`, true); }
      finally { busy = false; render(); }
    });
    save.id = 'simToolPromptsSave'; save.disabled = busy || !dirty; actions.append(save); body.append(actions);
    if (busy) body.querySelectorAll('button').forEach(node => { node.disabled = true; });
  }
  document.getElementById('simPromptPreset').addEventListener('change', render);
  document.addEventListener('tool-prompts-updated', load);
  load();
})();
