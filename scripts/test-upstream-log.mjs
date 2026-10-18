// 上游事件类型日志：类型/目标/节流/隐私边界，以及桥接消息入口的真实写盘。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createUpstreamEventLogger, upstreamKind, upstreamTarget, upstreamHealth } from '../src/upstream-events.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

test('upstream event types, targets and health flags are formatted without payload text', () => {
  const lines = [];
  let clock = 1_000_000;
  const log = createUpstreamEventLogger({ write: (line) => lines.push(line), now: () => clock });
  log({ post_type: 'message', message_type: 'group', group_id: 456, user_id: 789, message_id: 10, raw_message: 'secret-body' });
  clock += 6_000;
  log({ post_type: 'request', request_type: 'friend', user_id: 789, flag: 'secret-flag', comment: 'secret-comment' });
  log({ post_type: 'request', request_type: 'group', group_id: 456, user_id: 789, sub_type: 'invite', flag: 'secret-flag' });
  log({ post_type: 'notice', notice_type: 'group_increase', group_id: 456, user_id: 789 });
  log({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', group_id: 456, user_id: 789 });
  log({ post_type: 'meta_event', meta_event_type: 'heartbeat', status: { good: true, online: true } });
  assert.deepEqual(lines, [
    '[upstream] ← message/group group:456 user:789 msg:10',
    '[upstream] ← request/friend user:789',
    '[upstream] ← request/group/invite group:456 user:789',
    '[upstream] ← notice/group_increase group:456 user:789',
    '[upstream] ← notice/notify/poke group:456 user:789',
    '[upstream] ← meta_event/heartbeat good=true online=true',
  ]);
  const joined = lines.join('\n');
  assert.equal(joined.includes('secret'), false);
  assert.equal(upstreamKind({ post_type: 'notice', notice_type: 'group_admin', sub_type: 'set' }), 'notice/group_admin/set');
  assert.equal(upstreamTarget({ group_id: 1, user_id: 2, operator_id: 3, target_id: 4, message_id: 5 }), ' group:1 user:2 op:3 target:4 msg:5');
  assert.equal(upstreamHealth({ post_type: 'meta_event', meta_event_type: 'lifecycle', status: { good: true } }), '');
});

test('message/notify/heartbeat logs are throttled and message_sent is ignored', () => {
  const lines = [];
  let clock = 1_000_000;
  const log = createUpstreamEventLogger({ write: (line) => lines.push(line), now: () => clock });
  log({ post_type: 'message', message_type: 'group', group_id: 456, user_id: 1 });
  clock += 1_000;
  log({ post_type: 'message', message_type: 'group', group_id: 456, user_id: 2 });
  assert.equal(lines.length, 1, '同一群 5 秒内只记一行');
  clock += 5_000;
  log({ post_type: 'message', message_type: 'group', group_id: 456, user_id: 3 });
  assert.equal(lines.length, 2);
  clock += 100;
  log({ post_type: 'message', message_type: 'group', group_id: 999, user_id: 4 });
  assert.equal(lines.length, 3, '不同群各自节流');
  log({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', group_id: 456, user_id: 5 });
  clock += 100;
  log({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', group_id: 456, user_id: 6 });
  assert.equal(lines.length, 4, '拍一拍 1 秒内只记一行');
  log({ post_type: 'meta_event', meta_event_type: 'heartbeat', status: { good: true } });
  clock += 60_000;
  log({ post_type: 'meta_event', meta_event_type: 'heartbeat', status: { good: true } });
  assert.equal(lines.length, 5, '心跳 5 分钟内只记一行');
  clock += 5 * 60_000;
  log({ post_type: 'meta_event', meta_event_type: 'heartbeat', status: { good: false } });
  assert.equal(lines.length, 6);
  log({ post_type: 'message_sent', message_type: 'group', group_id: 456 });
  assert.equal(lines.length, 6, '自己发出的回显不记录');
});

test('bridge writes the received message type into state/bridge.log', async () => {
  const h = await bridgeHarness();
  try {
    await h.handleIncoming('group', 456, {
      self_id: 999,
      user_id: 789,
      group_id: 456,
      message_id: 10,
      message: [{ type: 'text', data: { text: 'secret-body' } }],
      sender: { user_id: 789, nickname: '小张', card: '小张' }
    }, h.cfg);
    const log = fs.readFileSync(path.join(h.temp, 'state/bridge.log'), 'utf8');
    const line = log.split('\n').find((item) => item.includes('[upstream] ←'));
    assert.ok(line, log);
    assert.match(line, /message\/group group:456 user:789 msg:10/);
    assert.equal(line.includes('secret-body'), false);
  } finally { await h.close(); }
});
