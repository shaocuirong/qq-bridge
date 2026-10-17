import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { extractPresetPrefix } from '../src/preset-prompt.js';

test('real console assets load with console authentication and reject anonymous or agent access', async () => {
  const h = await bridgeHarness();
  let server;
  try {
    fs.mkdirSync(path.join(h.temp, 'public'));
    const assets = [['console-tools.js', 'text/javascript'], ['console-tools.css', 'text/css'], ['console-wake.js', 'text/javascript'], ['console-wake.css', 'text/css']];
    for (const [name] of assets) fs.copyFileSync(new URL(`../public/${name}`, import.meta.url), path.join(h.temp, 'public', name));
    h.setMode('reserved2'); server = h.startConsoleServer();
    if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const agentToken = h.getSocialV2State('group:456').agentToken;
    for (const [name, mime] of assets) {
      const expected = fs.readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
      // The browser loader sends its console token in the query, API clients use a header.
      for (const options of [{ query: '?token=fixture-console-token' }, { headers: { 'x-console-token': 'fixture-console-token' } }]) {
        const response = await fetch(`${base}/${name}${options.query ?? ''}`, { headers: options.headers });
        assert.equal(response.status, 200, name);
        assert.equal(response.headers.get('content-type'), `${mime}; charset=utf-8`);
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(await response.text(), expected);
      }
      for (const query of ['', '?token=wrong-token']) {
        const response = await fetch(`${base}/${name}${query}`);
        assert.equal(response.status, 401); await response.text();
      }
      const agent = await fetch(`${base}/${name}`, { headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': agentToken, 'x-agent-call': '1' } });
      assert.equal(agent.status, 403); await agent.text();
    }
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await h.close();
  }
});

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
    assert.equal((await request('/api/wake-rules', undefined, true)).status, 403);
    const dry = await request('/api/socialV2/tools/call', { key: 'group:456', action: 'get_group_info', params: {}, dryRun: true }, true);
    assert.equal(dry.status, 200, JSON.stringify(dry.value));
    assert.deepEqual(dry.value.params, { group_id: 456 }); assert.equal(dry.value.dryRun, true);
    assert.equal((await request('/api/socialV2/tools/call', { key: 'group:456', action: 'get_group_info', params: { no_cache: 'bad' }, dryRun: true }, true)).status, 400);
    assert.equal((await request('/api/socialV2/tools/call', { key: 'group:456', action: 'get_group_info', params: { group_id: 999 }, dryRun: true }, true)).status, 403);
    const prompt = await request('/api/socialV2/prompt?key=group:456', undefined, true);
    assert.equal(prompt.status, 200, JSON.stringify(prompt.value)); assert.ok(prompt.value.enabledTools.includes('qq_get_group_profile'));
    assert.ok(prompt.value.toolSuites.block.includes('【记忆卫生】'), JSON.stringify(prompt.value.toolSuites));
    fs.mkdirSync(path.join(h.temp, 'roles'), { recursive: true });
    fs.writeFileSync(path.join(h.temp, 'roles/测试人格.md'), '这是一个安静好奇的人格。');
    fs.writeFileSync(path.join(h.temp, 'state/current-role.json'), JSON.stringify({ role: '测试人格', mode: 'active' }));
    const rule = { id: 'notice-memory', name: '群成员变化记录', enabled: true, keys: ['group:456'], events: ['notice:group_increase'], intervalMinutes: 5, cooldownSeconds: 60, reference: 'event', prompt: '判断 {{event}} 是否与已有话题有关' };
    assert.equal((await request('/api/wake-rules', { rules: [rule] }, true)).status, 403);
    assert.equal((await request('/api/wake-rules', { rules: [rule] })).status, 200);
    h.wakeRules.event({ post_type: 'notice', notice_type: 'group_increase', group_id: 456, user_id: 123, flag: 'sensitive-flag' });
    const wake = h.buildWakePromptV2('group:456', 'wakeRule');
    assert.ok(wake.includes('群成员变化记录')); assert.equal(wake.includes('sensitive-flag'), false);
    assert.ok(wake.indexOf('【记忆卫生】') < wake.indexOf('这是一个安静好奇的人格。'));
    assert.ok(wake.indexOf('这是一个安静好奇的人格。') < wake.indexOf('群成员变化记录'));
    assert.equal(wake.includes('选定工具'), false);
    fs.writeFileSync(path.join(h.temp, 'roles/测试人格.md'), '修改后的人格会热更新到下一条消息。');
    assert.ok(h.buildWakePromptV2('group:456', 'question').includes('修改后的人格会热更新到下一条消息。'));
    const scene = await request('/api/wake-rules', { prompts: { proactiveCheck: '【主动机会】{{key}} 查看上次话题。' } });
    assert.equal(scene.status, 200); assert.equal(scene.value.rules.length, 1);
    assert.ok(h.buildWakePromptV2('group:456', 'proactiveCheck').includes('【主动机会】group:456 查看上次话题。'));
    assert.equal((await request('/api/wake-rules', { rules: [{ ...rule, keys: ['group:999'] }] })).status, 400);
    h.cfg.socialV2.tools.get_group_info = false;
    assert.equal((await request('/api/socialV2/tools/call', { key: 'group:456', action: 'get_group_info', params: {}, dryRun: true }, true)).status, 403);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await h.close();
  }
});

test('simulation editor reads the current preset and saves/restores the actual inline bundle with it', async () => {
  const h = await bridgeHarness();
  let server;
  try {
    const sourceDir = path.join(h.temp, 'dsh/agent-presets/qq-chat-v2');
    fs.mkdirSync(sourceDir, { recursive: true });
    for (const file of ['agent.cordis.yml', 'preset.yml']) fs.copyFileSync(new URL(`../dsh/agent-presets/qq-chat-v2/${file}`, import.meta.url), path.join(sourceDir, file));
    server = h.startConsoleServer();
    if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async (url, body) => {
      const response = await fetch(base + url, { method: body ? 'POST' : 'GET', headers: { 'x-console-token': 'fixture-console-token', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
    };
    const current = await request('/api/preset/sim-prompt?preset=qq-chat-v2');
    const original = extractPresetPrefix(fs.readFileSync(path.join(sourceDir, 'agent.cordis.yml'), 'utf8'));
    assert.equal(current.content, original);
    const content = original + '\n\n【编辑验证】保持自然参与。';
    const saved = await request('/api/preset/sim-prompt', { preset: 'qq-chat-v2', content });
    assert.equal(saved.requiresRestart, true); assert.equal(saved.synced, true); assert.equal(saved.status.bundleReady, true);
    const bundlePath = path.join(h.temp, 'plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml');
    const prefixInBundle = () => yaml.load(fs.readFileSync(bundlePath, 'utf8'))[0].insert[0].config.plugins.find(row => row.id === 'persona').config.prefix.replace(/\n+$/, '');
    assert.equal(prefixInBundle(), content);
    assert.equal((await request('/api/preset/sim-prompt', { preset: 'qq-chat-v2', content })).unchanged, true);
    await request('/api/preset/sim-prompt/restore', { preset: 'qq-chat-v2' });
    assert.equal(prefixInBundle(), original);
    assert.equal(extractPresetPrefix(fs.readFileSync(path.join(sourceDir, 'agent.cordis.yml'), 'utf8')), original);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await h.close();
  }
});
