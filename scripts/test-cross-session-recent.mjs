// 管理员专用的跨会话最近消息摘要：一次读所有白名单会话，过滤旧消息/自己消息，并拒绝非管理员。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { enabledToolNames } from '../src/qq-tool-groups.js';

test('admin cross-session recent returns allowed sessions only and filters old/self messages', async () => {
  const h = await bridgeHarness();
  let server;
  try {
    h.setMode('reserved2'); h.setReady(true);
    server = h.startConsoleServer();
    if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    h.appendSocialV2Message('group:456', '张三', '今天加班到十点', '今天加班到十点', false, false, 'm-g1', [], '111');
    h.appendSocialV2Message('private:123', '管理员', '晚上吃啥', '晚上吃啥', false, true, 'm-p1', [], '123');
    h.appendSocialV2Message('group:999', '路人', '不该出现', '不该出现', false, false, 'm-x1', [], '999');
    const groupState = h.getSocialV2State('group:456');
    groupState.recentMessages.push({ sender: '旧人', text: '25小时前', plain: '25小时前', time: Date.now() - 25 * 3600_000, isSelf: false, seq: 900 });
    groupState.recentMessages.push({ sender: '小鲸鱼', text: '自己的回复', plain: '自己的回复', time: Date.now(), isSelf: true, seq: 901 });
    const adminToken = h.getSocialV2State('private:123').agentToken;
    const groupToken = h.getSocialV2State('group:456').agentToken;
    const call = async (query, token) => {
      const response = await fetch(`${base}/api/socialV2/recent-all?${query}`, {
        headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': token, 'x-agent-call': '1' }
      });
      return { status: response.status, body: await response.json() };
    };

    const ok = await call('key=private:123&hours=24&limit=50&perSession=10', adminToken);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.sessions, 2);
    const texts = ok.body.messages.map(message => message.text);
    assert.ok(texts.some(text => text.includes('加班')));
    assert.ok(texts.some(text => text.includes('晚上吃啥')));
    assert.equal(texts.some(text => text.includes('不该出现')), false);
    assert.equal(texts.some(text => text.includes('25小时前')), false);
    assert.equal(texts.some(text => text.includes('自己的回复')), false);
    assert.ok(ok.body.messages.every(message => ['group:456', 'private:123'].includes(message.key)));
    assert.ok(ok.body.messages.every(message => message.text.length <= 120));

    const nonAdmin = await call('key=group:456&hours=24&limit=50&perSession=10', groupToken);
    assert.equal(nonAdmin.status, 403);
    const wrongToken = await call('key=private:123&hours=24&limit=50&perSession=10', groupToken);
    assert.equal(wrongToken.status, 403);
    const limited = await call('key=private:123&hours=1&limit=1&perSession=1', adminToken);
    assert.equal(limited.status, 200);
    assert.equal(limited.body.total, 1);
    assert.ok(enabledToolNames(h.cfg).includes('qq_get_cross_session_recent'));
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await h.close();
  }
});
