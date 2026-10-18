import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { GROUPS, toolsToRegister, defaultConfig, enabledToolNames, keyKindOkFor } from '../src/qq-tool-groups.js';
import { registerToolSuites } from '../src/mcp-tool-suites.js';
import { prepareActionParams, actionCatalog, actionReadOnly } from '../src/tool-catalog.js';
import { activeToolGroups, defaultToolProtocol } from '../src/tool-protocols.js';
import { composePromptBlock } from '../src/tool-prompts.js';

test('all independent tool actions belong to their own configuration group', () => {
  for (const group of GROUPS) for (const tool of group.independentTools) {
    for (const action of tool.actions) assert.ok(group.actions.includes(action), `${tool.name}: ${action} belongs to another group`);
  }
  const cfg = defaultConfig(); cfg.socialV2.toolGroups.system.enabled = true; cfg.socialV2.tools.get_online_clients = true;
  assert.ok(toolsToRegister(cfg).some(t => t.name === 'qq_get_online_clients'));
  assert.ok(enabledToolNames(cfg).includes('qq_get_online_clients'));
});

test('real MCP schemas list and call independent and combined tools, preserving native params', async () => {
  const cfg = defaultConfig();
  cfg.socialV2.toolGroups.groupInfo.enabled = true;
  cfg.socialV2.tools.get_group_info_ex = true;
  cfg.socialV2.tools.set_group_todo = true;
  const server = new McpServer({ name: 'fixture', version: '1' }); const calls = [];
  registerToolSuites(server, { getConfig: () => cfg, serializeModelData: JSON.stringify,
    agentApi: async (url, options) => { calls.push({ url, body: JSON.parse(options.body), token: options.headers['x-agent-token'] }); return { ok: true }; } });
  const client = new Client({ name: 'fixture-client', version: '1' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    const group = listed.tools.find(t => t.name === 'qq_get_group_profile');
    assert.deepEqual(group.inputSchema.properties.action.enum, ['get_group_info_ex']);
    const common = { key: 'group:456', token: 'fixture-only' };
    const response = await client.callTool({ name: 'qq_get_group_profile', arguments: { ...common, params: { no_cache: true } } });
    assert.notEqual(response.isError, true);
    assert.equal(calls.at(-1).body.action, 'get_group_info_ex');
    assert.deepEqual(calls.at(-1).body.params, { no_cache: true });
    const combined = await client.callTool({ name: 'qq_group_collab_invoke', arguments: { ...common, action: 'set_group_todo', params: { message_id: 123 } } });
    assert.notEqual(combined.isError, true);
    assert.equal(calls.at(-1).body.action, 'set_group_todo');
    const before = calls.length; cfg.socialV2.tools.get_group_info_ex = false;
    const disabled = await client.callTool({ name: 'qq_get_group_profile', arguments: common });
    assert.equal(disabled.isError, true); assert.equal(calls.length, before);
    const invalid = await client.callTool({ name: 'qq_group_collab_invoke', arguments: { ...common, action: 'set_group_kick', params: {} } });
    assert.equal(invalid.isError, true); assert.equal(calls.length, before);
  } finally { await client.close(); await server.close(); }
});

test('request approval actions can run from the owner private session, group-scoped writes cannot', () => {
  // 申请处理发生在管理员私聊会话里：flag 本身已经限定目标，不需要 group: key。
  for (const action of ['set_group_add_request', 'get_group_ignore_add_request', 'get_group_ignored_notifies', 'set_friend_add_request']) {
    assert.equal(keyKindOkFor(action, 'private:123'), true, action);
  }
  assert.equal(keyKindOkFor('set_group_ban', 'private:123'), false);
  assert.equal(keyKindOkFor('set_group_add_request', 'group:456'), true);
});

test('official schemas supply session IDs, preserve falsy values and reject missing/wrong parameters', () => {
  assert.deepEqual(prepareActionParams('get_group_info', 'group:456', { no_cache: false }).params, { group_id: 456, no_cache: false });
  assert.equal(prepareActionParams('get_group_info', 'private:123', {}).ok, false);
  assert.equal(prepareActionParams('set_group_card', 'group:456', { user_id: '123', card: '' }).ok, true);
  assert.equal(prepareActionParams('set_group_ban', 'group:456', { user_id: '123', duration: 'forever' }).ok, false);
  for (const action of actionCatalog().values()) assert.ok(action.inputSchema && action.parameters, `${action.name}: no schema`);
  for (const name of ['send_ark_share', 'send_group_ark_share', 'share_peer', 'share_group_ex']) assert.equal(actionReadOnly(name), false);
});

test('private protocols follow available groups and disabled prompt injection', () => {
  const cfg = defaultConfig();
  cfg.socialV2.tools = Object.fromEntries(GROUPS.flatMap(g => (g.legacyTools ?? []).filter(t => t.flag).map(t => [t.flag, false])));
  cfg.socialV2.tools.memory = true;
  const active = activeToolGroups(cfg);
  const block = composePromptBlock({}, active);
  assert.ok(block.includes('【记忆卫生】'));
  assert.equal(block.includes('【发语音'), false);
  assert.equal(composePromptBlock({ memory: { text: 'private-custom', enabled: false, protocolVersion: 2 } }, ['memory']), '');
  assert.ok(defaultToolProtocol('wake').includes('preSleepWaitRemainingMs'));
});
