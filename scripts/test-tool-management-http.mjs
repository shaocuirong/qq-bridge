import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

test('tool management API composes protocols, validates targets and isolates automation administration', async () => {
  const h = await bridgeHarness({ config: { socialV2: { toolGroups: { groupInfo: { enabled: true } }, tools: { get_group_info: true }, wake: { batchWindowMs: 60000 } } } });
  let server;
  try {
    h.setMode('reserved2'); server = h.startConsoleServer();
    if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const st = h.getSocialV2State('group:456');
    const request = async (url, body, agent = false) => {
      const headers = { 'x-console-token': 'fixture-console-token', ...(body ? { 'content-type': 'application/json' } : {}) };
      if (agent) { headers['x-agent-token'] = st.agentToken; headers['x-agent-call'] = '1'; }
      const response = await fetch(base + url, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
      return { status: response.status, value: await response.json() };
    };
    assert.equal((await request('/api/socialV2/tool-prompts', undefined, true)).status, 403);
    assert.equal((await request('/api/tool-automations', undefined, true)).status, 403);
    const dry = await request('/api/socialV2/tools/call', { key: 'group:456', action: 'get_group_info', params: {}, dryRun: true }, true);
    assert.equal(dry.status, 200, JSON.stringify(dry.value));
    assert.deepEqual(dry.value.params, { group_id: 456 }); assert.equal(dry.value.dryRun, true);
    assert.equal((await request('/api/socialV2/tools/call', { key: 'group:456', action: 'get_group_info', params: { no_cache: 'bad' }, dryRun: true }, true)).status, 400);
    assert.equal((await request('/api/socialV2/tools/call', { key: 'group:456', action: 'get_group_info', params: { group_id: 999 }, dryRun: true }, true)).status, 403);
    const prompt = await request('/api/socialV2/prompt?key=group:456', undefined, true);
    assert.equal(prompt.status, 200, JSON.stringify(prompt.value)); assert.ok(prompt.value.enabledTools.includes('qq_get_group_profile'));
    assert.ok(prompt.value.toolSuites.block.includes('【记忆卫生】'), JSON.stringify(prompt.value.toolSuites));
    const rule = { id: 'notice-memory', name: '群成员变化记录', enabled: true, keys: ['group:456'], tools: ['qq_memory_query'], events: ['notice:group_increase'], intervalMinutes: 5, cooldownSeconds: 60, reference: 'event', prompt: '判断 {{event}} 是否与已有话题有关' };
    assert.equal((await request('/api/tool-automations', { rules: [rule] }, true)).status, 403);
    assert.equal((await request('/api/tool-automations', { rules: [rule] })).status, 200);
    h.toolAutomations.event({ post_type: 'notice', notice_type: 'group_increase', group_id: 456, user_id: 123, flag: 'sensitive-flag' });
    const wake = h.buildWakePromptV2('group:456', 'toolAutomation');
    assert.ok(wake.includes('群成员变化记录')); assert.equal(wake.includes('sensitive-flag'), false);
    assert.equal((await request('/api/tool-automations', { rules: [{ ...rule, keys: ['group:999'] }] })).status, 400);
    h.cfg.socialV2.tools.get_group_info = false;
    assert.equal((await request('/api/socialV2/tools/call', { key: 'group:456', action: 'get_group_info', params: {}, dryRun: true }, true)).status, 403);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await h.close();
  }
});
