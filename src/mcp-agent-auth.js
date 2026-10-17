// 二代仿真的**会话令牌自愈**（MCP 侧）。
//
// 背景（这是真实踩过的坑，不是假想）：
//   唤醒 prompt 里会写死一行【会话令牌】${agentToken}，模型只能照抄这一行去调用所有
//   qq_* 工具（qq_get_prompt / qq_send_message / qq_mark_read ...）。可是会话令牌
//   **会在寿命周期里轮换**：bridge 的 retireSession()（/reset、四类 reset 接口、
//   清空工作区、以及 fresh-session 轮换）每次都会把 st.agentToken 换成新的随机值。
//   一旦轮换发生，正在跑的回合手里还是**上一代** prompt 里的旧令牌，之后每一次工具调用
//   都被桥接以 403 拒绝，模型没有任何自救手段 —— 表现为
//   「agent token 无效」反复刷屏、回合做不成事、然后被当成没动作反复唤醒。
//
//   state/tool-calls.jsonl 里的实证（本机 2026-10-16）：
//     06:52:32 qq_get_active_members  失败：agent token 无效
//     06:53:11 qq_send_message        失败：agent token 无效
//     08:14:32 qq_send_group_message  失败：agent token 无效
//     08:17:18 qq_send_group_message  失败：agent token 无效
//
// 修法：模型给的令牌只当**提示**，不当**凭据**。
//   桥接的授权语义本来就是「这枚令牌只能动它自己那个会话」，而 key 已经完全确定了目标；
//   MCP 进程与桥接同机、同目录，直接读 state/social-v2.json 里该 key 的**当前代**令牌，
//   比让模型照抄一行会过期的文本更可靠，也不会放宽任何跨会话权限（别人的 key 动不了）。
//
// 注意：这里读的是**磁盘上的当前状态**。桥接每次轮换都会 saveSocialV2State() 落盘，
// 所以磁盘值就是权威值；读失败（文件缺失/正在原子替换/不是本机部署）时返回 null，
// 调用方必须**退回模型给的令牌**，绝不因此报错 —— 自愈功能本身不能成为新的故障点。
import fs from 'node:fs';
import path from 'node:path';

/**
 * 从 state/social-v2.json 里取出某个会话的**当前**令牌。
 * @param {string} root 桥接根目录（含 state/），通常是 src/ 的上一级
 * @param {string} key  会话 key，形如 group:1060535585 / private:1761476025
 * @returns {string|null} 当前令牌；任何异常/未命中都返回 null（调用方自行兜底）
 */
export function readAgentTokenFromState(root, key) {
  const wanted = String(key ?? '').trim();
  if (!wanted) return null;
  try {
    const raw = fs.readFileSync(path.join(root, 'state', 'social-v2.json'), 'utf8');
    const obj = JSON.parse(raw);
    const st = obj?.conversations?.[wanted];
    const token = st?.agentToken;
    return typeof token === 'string' && token ? token : null;
  } catch {
    return null;
  }
}

/**
 * 桥接的「会话令牌不认」错误文案集合。
 *
 * 为什么认文案而不是认 HTTP 状态码：MCP 侧看到的永远是 agentApi() 抛出的 Error，
 * 状态码在包装过程中丢失了（只留下 body.error）。宁可只精确匹配桥接自己写死的这几句，
 * 也不要贪图省事去匹配「403/token」这类泛化模式 —— 那会把「目标不在白名单」「工具未启用」
 * 之类**不该重试**的失败也当成令牌问题重试一遍，白烧一次请求。
 */
const STALE_TOKEN_ERRORS = [
  'agent token 无效',                                      // bridge.js:5196 等所有 v2 端点
  '未授权：智能体调用必须携带有效的会话令牌',                  // bridge.js:3684 统一前置闸门
  'agent token 不能为空',                                  // bridge.js:3710
  'reserved2 模式发送必须携带 agent token',                 // bridge.js:5647/5773 等发送端点
  'reserved2 模式读取合并转发必须携带 agent token',
  'reserved2 模式读取图片必须携带 agent token',
  'reserved2 模式发送拍一拍必须携带 agent token',
  '缺少会话令牌'                                           // bridge.js:7405 旧只读工具
];

/**
 * 这个错误是不是「令牌缺失/过期」这一类（值得换当前令牌重试一次）。
 * @param {unknown} error
 * @returns {boolean}
 */
export function isStaleTokenError(error) {
  const text = String(error?.message ?? error ?? '');
  if (!text) return false;
  return STALE_TOKEN_ERRORS.some((needle) => text.includes(needle));
}
