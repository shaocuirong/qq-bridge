// 上游事件类型日志：只记录「收到了什么类型 + 目标 + 健康位」，不记录正文、申请 flag 或文件名。
// bridge.js 在消息入口与 OneBot 事件旁路调用；这里保持纯函数便于单测。
const MESSAGE_INTERVAL_MS = 5_000;
const NOTIFY_INTERVAL_MS = 1_000;
const HEARTBEAT_INTERVAL_MS = 5 * 60_000;

/** 把 OneBot 事件压缩成 message/group、notice/group_increase、request/group/invite 这样的类型串。 */
export function upstreamKind(event) {
  const post = event?.post_type;
  if (!post) return 'event';
  if (post === 'message' || post === 'message_sent') return `${post}/${event.message_type ?? 'unknown'}`;
  const detail = event.notice_type || event.request_type || event.meta_event_type;
  return detail ? `${post}/${detail}${event.sub_type ? `/${event.sub_type}` : ''}` : post;
}

/** 目标 ID（群/用户/操作者/消息）；不包含正文。 */
export function upstreamTarget(event) {
  const parts = [];
  if (event?.group_id) parts.push(`group:${event.group_id}`);
  if (event?.user_id) parts.push(`user:${event.user_id}`);
  if (event?.operator_id) parts.push(`op:${event.operator_id}`);
  if (event?.target_id) parts.push(`target:${event.target_id}`);
  if (event?.message_id) parts.push(`msg:${event.message_id}`);
  return parts.length ? ` ${parts.join(' ')}` : '';
}

/** 心跳/账号状态是健康信号，额外带上 good/online。 */
export function upstreamHealth(event) {
  if (event?.post_type !== 'meta_event' || event.meta_event_type !== 'heartbeat') return '';
  const good = typeof event.status?.good === 'boolean' ? ` good=${event.status.good}` : '';
  const online = typeof event.status?.online === 'boolean' ? ` online=${event.status.online}` : '';
  return good || online ? `${good}${online}` : '';
}

/**
 * 创建一个带节流的上游日志函数。
 * - 消息：同一群/私聊每 5 秒最多一行（避免刷屏，类型仍可确认）
 * - 拍一拍等 notify：同一目标每 1 秒最多一行
 * - 心跳：每 5 分钟一行
 * - 申请/成员变更/撤回等低频事件：每条都记录
 * @returns {(event: object) => boolean} 是否实际写入
 */
export function createUpstreamEventLogger({
  write,
  now = Date.now,
  messageIntervalMs = MESSAGE_INTERVAL_MS,
  notifyIntervalMs = NOTIFY_INTERVAL_MS,
  heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
} = {}) {
  const lastAt = new Map();
  return function logUpstreamEvent(event) {
    const post = event?.post_type;
    // message_sent 是机器人自己发出的回显，不是上游新消息。
    if (!post || post === 'message_sent') return false;
    const kind = upstreamKind(event);
    const interval = post === 'meta_event' && event.meta_event_type === 'heartbeat'
      ? heartbeatIntervalMs
      : post === 'notice' && event.notice_type === 'notify'
        ? notifyIntervalMs
        : post === 'message' ? messageIntervalMs : 0;
    if (interval > 0) {
      const scope = event.group_id ? `group:${event.group_id}` : (event.user_id ? `private:${event.user_id}` : '');
      const key = `${kind}|${scope}`;
      const at = now();
      if (at - (lastAt.get(key) ?? -Infinity) < interval) return false;
      // 防御异常 ID 洪峰：只保留最近 1000 个节流键。
      if (lastAt.size > 1000) lastAt.clear();
      lastAt.set(key, at);
    }
    write(`[upstream] ← ${kind}${upstreamTarget(event)}${upstreamHealth(event)}`);
    return true;
  };
}
