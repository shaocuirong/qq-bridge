// 黑话注入开关：只有 MCP「黑话与梗」组开启时才注入黑话表/协议，并把 qq_slang_* 视为可用工具。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slangContextEnabled, enabledToolNames, defaultConfig } from '../src/qq-tool-groups.js';
import { activeToolGroups } from '../src/tool-protocols.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

test('slang context needs both the 黑话与梗 group and the global slang switch', () => {
  const cfg = defaultConfig();
  cfg.slang = { enabled: true };
  cfg.socialV2.tools.slangQuery = true;
  cfg.socialV2.tools.slangSubmit = true;
  assert.equal(slangContextEnabled(cfg), false);
  assert.equal(enabledToolNames(cfg).includes('qq_slang_query'), false);
  assert.equal(activeToolGroups(cfg).includes('slang'), false);
  cfg.socialV2.toolGroups.slang.enabled = true;
  assert.equal(slangContextEnabled(cfg), true);
  assert.equal(enabledToolNames(cfg).includes('qq_slang_query'), true);
  assert.equal(activeToolGroups(cfg).includes('slang'), true);
  cfg.slang.enabled = false;
  assert.equal(slangContextEnabled(cfg), false);
  assert.equal(enabledToolNames(cfg).includes('qq_slang_submit'), false);
  assert.equal(activeToolGroups(cfg).includes('slang'), false);
});

test('bridge injects slang only after the group is enabled', async () => {
  const h = await bridgeHarness({ config: { slang: { enabled: true }, socialV2: { toolGroups: { slang: { enabled: false } },
    tools: { slangQuery: true, slangSubmit: true, getPrompt: true }, wake: { batchWindowMs: 60000 } } } });
  let server;
  try {
    h.setMode('reserved2'); h.setReady(true);
    server = h.startConsoleServer();
    if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const added = await fetch(`${base}/api/slang`, {
      method: 'POST',
      headers: { 'x-console-token': 'fixture-console-token', 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'yyds', meaning: '永远的神' })
    });
    assert.equal(added.status, 200, await added.text());
    const st = h.getSocialV2State('group:456');
    const agentHeaders = { 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken, 'x-agent-call': '1' };
    const readPrompt = async () => (await fetch(`${base}/api/socialV2/prompt?key=group:456`, { headers: agentHeaders })).json();

    const off = await readPrompt();
    assert.equal(off.slang.enabled, false);
    assert.equal(off.slang.block, '');
    assert.deepEqual(off.slang.entries, []);
    assert.equal(off.enabledTools.includes('qq_slang_query'), false);
    assert.equal(off.toolSuites.groups.includes('slang'), false);
    const queryOff = await fetch(`${base}/api/socialV2/slang/query?key=group:456`, { headers: agentHeaders });
    assert.equal(queryOff.status, 403); await queryOff.text();

    // 实际投递路径：组关闭时 prompt 里既没有黑话表，也没有【黑话】协议。
    h.wakeRules.replace([{ id: 'slang-gate', name: '黑话开关', enabled: true, keys: ['group:456'], events: ['message'],
      intervalMinutes: 0, cooldownSeconds: 10, snapshotLimit: 0, prompt: '处理本轮消息' }]);
    h.wakeRules.event({ post_type: 'message', group_id: 456, user_id: 1, raw_message: 'hi' }, 'group:456');
    clearTimeout(st.pendingWakeTimer); st.pendingWakeTimer = null;
    await h.sendWakePromptV2('group:456', 'wakeRule');
    const deliveredOff = JSON.stringify(h.calls.prompts.at(-1));
    assert.equal(deliveredOff.includes('yyds'), false);
    assert.equal(deliveredOff.includes('【黑话】'), false);

    h.cfg.socialV2.toolGroups.slang = { enabled: true };
    const on = await readPrompt();
    assert.equal(on.slang.enabled, true);
    assert.match(on.slang.block, /yyds/);
    assert.equal(on.enabledTools.includes('qq_slang_query'), true);
    assert.equal(on.toolSuites.groups.includes('slang'), true);
    const queryOn = await fetch(`${base}/api/socialV2/slang/query?key=group:456`, { headers: agentHeaders });
    assert.equal(queryOn.status, 200);
    assert.match((await queryOn.json()).block, /yyds/);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await h.close();
  }
});
