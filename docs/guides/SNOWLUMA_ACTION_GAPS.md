# SnowLuma action 目录 vs 桥接工具面（差额清单）

> 数据源：`@snowluma/mcp@1.14.22` 的 `dist/generated/catalog.js`（与运行中的 SnowLuma 1.14.22 同版本）。
> 复现：`npm run catalog:gaps`（会顺带把 `_snowluma-catalog.json` 刷新到当前版本）。
> 快照文件：仓库根 `_snowluma-catalog.json`（198 条 / 只读 80）。

## 一、现状

| 项 | 数量 |
| --- | --- |
| SnowLuma 全部 action | **198** |
| 其中只读（`readOnly: true`） | **80** |
| 桥接注册的 `qq_*` 工具 | **40**（`src/mcp-snowluma-safe.js`） |
| 这 40 个里真正落到**裸 OneBot action** 的 | **4 个工具 / 5 个 action** |
| 只读但**没有任何工具**覆盖的 action | **75** |

落地的 4 个：`qq_status`（`get_login_info` + `get_status`）、`qq_list_groups`、`qq_get_group_members`、`qq_get_group_history`。

其余 36 个工具（发送/等待/潜水/表情/记忆/黑话/人物档案）**都不打 OneBot**，走桥接自己的 `/api/socialV2/*` 内存态。这解释了差额的来源：桥接把"会话状态机"做厚了，把"QQ 侧事实查询"留得很薄。

## 二、目录本身的两个坑（先看这个）

### 1. `readOnly` 有误标 —— 4 个"只读"会真的发消息

```
send_ark_share(user_id, group_id, phone_number)   分享用户/群 Ark 卡片
send_group_ark_share(group_id)                    分享群 Ark 卡片
share_peer(user_id, group_id, phone_number)       分享用户/群 Ark 卡片
share_group_ex(group_id)                          分享群 Ark 卡片
```

四个都被标成 `readOnly: true`，但它们的作用是把卡片**发进会话**。

推论：**任何"按 `readOnly` 过滤出一个安全集合"的写法都必须再过一遍名字启发式**。官方 `@snowluma/mcp` 的 `query_action` 就是按这个字段放行的，所以那 4 个在 `read` 模式下也能被调。桥接若要从目录自动生成工具白名单，必须显式排除它们（`refresh-snowluma-catalog.mjs --gaps` 已经会打印这个冲突清单）。

### 2. 有一批占位/未实现，别包成工具

| action | 状态 |
| --- | --- |
| `.get_word_slices` | 分词，未实现 |
| `get_recent_contact` | 占位 |
| `nc_get_packet_status` | 占位 |
| `check_url_safely` | 占位（恒返回 `level: 1`） |
| `_set_model_show` | 占位 |
| `set_restart` | 不支持 |
| `unlike_qzone` | 取消赞端点待真机核实 |

包成工具等于给模型一个必然失败（或必然返回假值）的按钮。

## 三、建议补的工具

### 第一档：现在就是空洞（5 个，建议做）

| 新工具 | action | 参数 | 为什么值得 |
| --- | --- | --- | --- |
| `qq_get_friend_msg_history` | `get_friend_msg_history` | `user_id, message_id, count, reverse_order` | 现在**只有群历史**（`qq_get_group_history`）。私聊想翻更早的对话完全无路——而私聊恰恰是 owner 用得最多的。 |
| `qq_get_msg` | `get_msg` | `message_id` | `qq_get_message_detail` 只查桥接内存里"本会话可见"的那部分。跨会话 id、或已被内存窗口挤掉的旧消息，它拿不到。 |
| `qq_get_group_info` | `get_group_info` | `group_id, no_cache` | 群名/人数/简介。桥接只缓存了 `group_id`，人格搭话时对"这是个什么群"一无所知。 |
| `qq_get_group_member_info` | `get_group_member_info` | `group_id, user_id, no_cache` | 单成员资料（群名片/头衔/入群时间）。现在只有全量 `member_list`——为了看一个人把整群拉进上下文，又贵又容易超限。 |
| `qq_get_stranger_info` | `get_stranger_info` | `user_id` | 群里出现陌生 QQ 号时，模型只能靠"他刚说了什么"猜人设。这个给出昵称/性别/年龄/等级。 |

**落地方式要分开**：

- 前 4 个的 `group_id`/`user_id`/`message_id` **都从会话 key 或本会话上下文推导得出**，不允许模型传任意 id → 可以走 **A 类**（只改 `src/mcp-snowluma-safe.js`，用 `onebot()` 直连）。
- `qq_get_stranger_info` 的 `user_id` 是模型自由填的 → 必须走 **B 类**（桥接侧加 `/api/socialV2/...`，校验目标确实是本会话的参与者：`key` 对应的群成员、或白名单私聊）。否则它就是一台"输入任意 QQ 号查资料"的探测机，属于对边界 L7 的实质放宽。

### 第二档：有明确场景（按人格取舍）

| action | 参数 | 场景 | 备注 |
| --- | --- | --- | --- |
| `get_group_honor_info` | `group_id, type` | 龙王、群聊之火、活跃榜 —— 聊天素材 | 纯 A 类；`group_id` 从 key 推导 |
| `_get_group_notice` | `group_id` | 群公告/新人须知 | 纯 A 类 |
| `get_essence_msg_list` | `group_id` | 精华消息（"群里的规矩"） | 纯 A 类 |
| `get_friend_list` / `get_friends_with_category` | — | 判断某 QQ 是不是好友 | 纯 A 类；返回体可能很大，建议只回计数+命中 |
| `get_msg_emoji_likes` | `message_id` | 谁给这条消息点了表情（"被点赞"体感） | 纯 A 类，`message_id` 限本会话 |
| `search_sys_faces` / `fetch_sys_faces` | `query` / — | 精确挑 QQ 系统表情 | 现在只能发**收藏**表情；系统表情目录能补这块 |
| `get_group_at_all_remain` | `group_id` | @全体 剩余次数（防滥用） | 也可以只做 B 类内部闸门，不给模型 |
| `fetch_ptt_text` | `message_id` | 历史语音转文字 | 与桥接自带 ASR 重叠，只在"重听旧语音"时有增量 |
| `get_qzone_msg_list` / `get_qzone_feeds` | `target_uin,pos,num` / `page_num,count` | 经营 QQ 空间 | 文档注明深翻页未实现 |
| `ocr_image` | `image` | 图片文字 | 桥接已有视觉模型，价值有限 |

### 第三档：不建议 / 永不暴露

- **凭据与底层**（永不）：`get_cookies`、`get_credentials`、`get_csrf_token`、`get_clientkey`、`get_rkey`、`get_rkey_server`、`send_packet`、`request_decrypt_key`。
- **占位/未实现**：见第二节。
- **与桥接已有实现重复**：`get_image`、`get_record`、`get_file`、`fetch_custom_face*`（桥接的表情库与图片管线已经是加工过的）、`get_collection_list`。
- **管理向/低频、进了也只是白烧 token**：`get_group_admin_settings`、`get_group_shut_list`、`get_group_tags`、`get_group_todo_list`、`get_group_signed_list`、`get_group_root_files`、`get_group_files_by_folder`、`get_group_file_url`、`get_group_file_system_info`、`get_private_file_url`、`get_fileset_id`、`get_group_album_list`、`get_group_album_media_list`、`get_qun_album_list`、`get_online_clients`、`nc_get_user_status`、`_get_friend_dress`、`get_profile_like`、`get_doubt_friends_add_request`、`get_unidirectional_friend_list`、`get_group_ignored_notifies`、`get_group_ignore_add_request`、`get_ai_characters`、`fetch_emoji_like`/`get_emoji_likes`（旧版 pair，新代码用 `get_msg_emoji_likes`）、`fetch_face_entity`、`fetch_super_face_id`、`get_mini_app_ark`、`translate_en2zh`（模型自带）。
- **`readOnly` 误标的 4 个 Ark 分享**：当写操作看，永不进只读面。

## 四、维护

```bash
npm run catalog:check     # CI/审计：快照是否落后于当前 SnowLuma（落后退出码 1）
npm run catalog:refresh   # 升级 SnowLuma 后刷新
npm run catalog:gaps      # 刷新并打印本文的原始数据
```

`package.json` 里 `@snowluma/mcp` 已固定为 `^1.14.20`；脚本**远端优先**（按 `--version`，默认 latest），无外网时回退本地 `node_modules` 并告警。注意本地装的是 1.14.20（195 条），和运行中的 1.14.22（198 条）**不一致** —— 这也是这张快照过去会静默落后的原因之一，建议顺手把依赖版本对齐。
