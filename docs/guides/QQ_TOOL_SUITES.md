# 工具套件（Tool Suites）

> 面向使用者：怎么开、怎么写提示词、开了要付出什么代价。
> 设计见 [../design/QQ_TOOL_SUITES_PLAN.md](../design/QQ_TOOL_SUITES_PLAN.md)。

## 这是什么

桥接把 SnowLuma 的 **198 个 OneBot action** 按 16 个功能组包装成 Q​Q 侧可用的 `qq_*` 工具：

- **27 个独立语义工具**（推荐主力，如 `qq_get_group_profile`、`qq_get_member_profile`、`qq_get_stranger`）
- **10 个组通道工具**（低频兜底，如 `qq_group_admin_invoke`，参数里显式写 `action`）
- 另有 26 个 action **永不暴露**（凭据类、占位/未实现、流式、不可撤销操作）

**默认全关。** 全关时这些工具**一个都不注册**，token 成本为零。

## 怎么开

新版统一入口为控制台侧边栏 **MCP 工具管理**。工具参数、按组私有协议和事件/定时唤醒见 [MCP_TOOLS_AND_WAKE.md](MCP_TOOLS_AND_WAKE.md)。

控制台 → 「工具套件」面板（`http://127.0.0.1:3100/`）：

1. 展开一个组 → 打开 **组总开关**；
2. 勾选该组里要开的 action（或点 **一键开启本组只读**）；
3. **重启 DSH** —— 工具清单在 DSH 启动时读取，改开关必须重启；
4. 用 `qq_get_prompt` 确认新工具和对应的提示词都出现了。

判定是两级的：`组开 && action 开`，且该 action 不在永不暴露清单里。

## 提示词逻辑编写区

每个组一块文本框，写"这组工具什么时候用 / 怎么用 / 别做什么"：

- 改完**立即生效**，不需要重启（它只在拼 prompt 时读取）；
- 每组上限 **8000 字符**，一次注入总上限 **32000 字符**（超出截断并标 `…（已截断）`）；
- 只有至少一个基础工具可用或扩展动作已开启的组会被注入，且须开启该组提示词注入开关；
- 注入点：`qq_get_prompt` 返回的 `toolSuites` 段 + 每次唤醒提示；
- QQ 侧 AI **读不到也改不了**（`/api/socialV2/tool-prompts` 对 agent token 一律 403）；
- 控制台可「恢复默认」，默认文案维护在 `src/qq-tool-groups.js` 的 `defaultPrompt`。

存储：`state/tool-prompts.json`。

## 代价

| 项 | 数值 |
| --- | --- |
| 单个工具描述上限 | 200 字符 |
| 全关时新增 token | **0** |
| 全开时工具总数 | 40（原有）+ 37（新增） |
| 全开时增量 token | 约 **+7k / 每次请求** |

建议按需开：先开 `history`、`groupInfo`、`friend` 三组只读，观察几轮再决定要不要开写组。

## 安全边界

- **永不暴露**：`get_cookies` / `get_credentials` / `get_csrf_token` / `get_clientkey` / `get_rkey*` /
  `request_decrypt_key` / `send_packet`、全部占位与未实现、全部流式、`bot_exit`、`set_restart`、
  `set_group_anonymous(_ban)`、`unlike_qzone`。
- **B 级校验**：凡是"模型能自己填 QQ 号"的工具（`qq_get_stranger`、`qq_get_user_status`、
  `qq_get_member_profile`、通道工具、`qq_recall_message` / `qq_forward_msg` / `qq_send_like`），
  一律经桥接 `/api/socialV2/tools/call`，由桥接做令牌绑定、会话范围、白名单与限频校验。
- **A 级直连**：参数全部从会话 key 推导的只读工具在 MCP 侧直连 OneBot，只额外校验白名单。
- **目录 readOnly 不可全信**：`send_ark_share` / `send_group_ark_share` / `share_peer` / `share_group_ex`
  在官方目录里被标成只读，实际会发消息，桥接按写操作对待。

## 维护

```bash
npm run catalog:check     # 快照是否落后于当前 SnowLuma（落后退出码 1）
npm run catalog:refresh   # 升级 SnowLuma 后刷新 _snowluma-catalog.json
npm run catalog:gaps      # 打印"只读但未暴露"的清单 + readOnly 误标
npm run test:audit        # 含注册表/开关/授权/提示词/MCP 注册 5 组纯函数回归
```

升级 SnowLuma 后：`catalog:refresh` → 看 `--gaps` 有没有新增只读 action → 有就补进
`src/qq-tool-groups.js` 对应组（注册表是唯一真相源，`action 并集必须等于目录全集`，
`scripts/test-qq-tool-groups.mjs` 会当场抓住漏登）。
