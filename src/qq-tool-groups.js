// 工具组注册表：SnowLuma 198 个 OneBot action ↔ 二代仿真工具套件的唯一真相源。
//
// 纯数据 + 纯函数，**不做 IO**（不读 config、不读 state、不发请求），方便单测。
// 设计见 docs/design/QQ_TOOL_SUITES_PLAN.md。
//
// 三层职责里的第一层：
//   - GROUPS                 ：16 个功能组，action 划分 + 工具定义 + 默认提示词
//   - actionEnabled(cfg, a)  ：两级开关判定（组开关 && action 开关，且不在 never 清单）
//   - toolsToRegister(cfg)   ：MCP 侧注册期过滤（默认全关 ⇒ 返回空数组，零 token）
//
// 第二层（src/mcp-snowluma-safe.js）只消费这里的结果；第三层（bridge.js）做真正的权限校验。

// ── 永不暴露 ────────────────────────────────────────────────────────────────
// 凭据类、占位/未实现、流式（现有 onebot() 的 res.json() 会挂）、不可撤销、目录里 readOnly 误标。
export const NEVER_EXPOSED = Object.freeze([
  // 凭据与底层协议
  'get_cookies', 'get_credentials', 'get_csrf_token', 'get_clientkey',
  'get_rkey', 'get_rkey_server', 'request_decrypt_key', 'send_packet',
  // 占位 / 未实现
  '.get_word_slices', 'check_url_safely', '_get_model_show', '_set_model_show',
  'get_recent_contact', 'nc_get_packet_status', 'create_collection',
  // 占位但藏在群管理里
  'set_group_anonymous', 'set_group_anonymous_ban',
  // 不支持 / 待真机核实
  'set_restart', 'unlike_qzone',
  // 不可撤销
  'bot_exit',
  // 流式（需要专门的流式客户端，不能走 onebot()）
  'download_file_stream', 'download_file_image_stream', 'download_file_record_stream',
  'upload_file_stream', 'test_download_stream', 'clean_stream_temp_file',
]);

const NEVER = new Set(NEVER_EXPOSED);

export const STREAMING_EXCLUDED = Object.freeze([
  'download_file_stream', 'download_file_image_stream', 'download_file_record_stream',
  'upload_file_stream', 'test_download_stream', 'clean_stream_temp_file',
]);

// ── 16 个功能组 ─────────────────────────────────────────────────────────────
// risk: read / write / mixed / never
// independentTools[].mode: 'A' = MCP 侧直连 OneBot（参数从会话 key 推导）
//                          'B' = 经桥接 /api/socialV2/tools/call（参数由模型填，需会话范围校验）
export const GROUPS = [
  {
    id: 'send',
    label: '消息发送与转发',
    risk: 'write',
    actions: [
      'send_msg', 'send_group_msg', 'send_private_msg',
      'send_forward_msg', 'send_group_forward_msg', 'send_private_forward_msg',
      'upload_forward_msg', 'upload_foward_msg',
      'forward_friend_single_msg', 'forward_group_single_msg',
      'delete_msg', 'send_custom_face', 'send_tuwen_ark', 'get_mini_app_ark',
      'send_ark_share', 'send_group_ark_share', 'share_peer', 'share_group_ex',
      'click_inline_keyboard_button',
    ],
    independentTools: [
      { name: 'qq_recall_message', actions: ['delete_msg'], mode: 'B', description: '撤回自己发过的一条消息（只能撤本会话里自己发的）。' },
      { name: 'qq_forward_msg', actions: ['forward_friend_single_msg', 'forward_group_single_msg'], mode: 'B', description: '把一条消息转发给好友或群（目标必须在白名单内）。' },
    ],
    channelTool: { name: 'qq_send_invoke', description: '低频发送类动作（合并转发/Ark 卡片/键盘按钮等），需显式指定 action。' },
    legacyTools: [
      { name: 'qq_send_message', flag: 'sendMessage', description: '统一发送：一条/多条/引用/自定义间隔' },
      { name: 'qq_send_burst', flag: 'sendBurst', description: '分多条发送，桥接自动加真人化间隔' },
      { name: 'qq_send_group_message', flag: 'sendGroup', description: '向指定群发一条纯文本' },
      { name: 'qq_send_private_message', flag: 'sendPrivate', description: '向指定好友发一条纯文本' },
      { name: 'qq_reply', flag: 'reply', description: '引用/回复某条群消息' },
    ],
    defaultPrompt: '【发消息】日常说话一律用 qq_send_message / qq_send_burst，不要用这里的通道工具替代它们——通道只给低频形态（合并转发、Ark 卡片）。撤回只在发现自己说错话时用一次；转发别人的消息前先想清楚会不会让对方难堪。',
  },
  {
    id: 'social',
    label: '社交动作',
    risk: 'write',
    actions: ['send_like', 'send_poke', 'group_poke', 'friend_poke', 'set_input_status'],
    independentTools: [
      { name: 'qq_send_like', actions: ['send_like'], mode: 'B', description: '给某个群友的资料点一次赞（有副作用，别连点）。' },
      { name: 'qq_set_typing', actions: ['set_input_status'], mode: 'B', description: '在私聊里显示"正在输入"（短暂状态，别滥用）。' },
    ],
    channelTool: null,
    legacyTools: [
      { name: 'qq_send_poke', flag: 'sendPoke', description: '拍一拍（群聊/私聊自动路由）' },
    ],
    defaultPrompt: '【社交动作】拍一拍用 qq_send_poke（已有），点赞用 qq_send_like。这类动作是"有存在感但不说话"的强表达：一次会话里最多一两次，别对同一个人连拍或连赞。',
  },
  {
    id: 'readAck',
    label: '已读水位',
    risk: 'write',
    actions: ['mark_msg_as_read', 'mark_group_msg_as_read', 'mark_private_msg_as_read', '_mark_all_as_read'],
    independentTools: [],
    channelTool: null,
    legacyTools: [
      { name: 'qq_mark_read', flag: 'markRead', description: '标记当前未读为已读' },
    ],
    defaultPrompt: '',
  },
  {
    id: 'history',
    label: '读消息与历史',
    risk: 'read',
    actions: ['get_group_msg_history', 'get_friend_msg_history', 'get_msg', 'get_forward_msg', 'get_group_system_msg'],
    independentTools: [
      { name: 'qq_get_msg', actions: ['get_msg'], mode: 'B', description: '按 messageId 取单条消息（本会话内的 id，可查已被窗口挤掉的旧消息）。' },
      { name: 'qq_get_friend_msg_history', actions: ['get_friend_msg_history'], mode: 'A', description: '翻私聊更早的对话（群历史用 qq_get_group_history）。' },
      { name: 'qq_get_group_system_msg', actions: ['get_group_system_msg'], mode: 'A', description: '查本群的系统消息（入群、禁言、管理员变更等）。' },
    ],
    channelTool: null,
    legacyTools: [
      { name: 'qq_get_unread_messages', flag: 'getUnread', description: '未读消息（不自动标已读）' },
      { name: 'qq_get_recent_messages', flag: 'getRecent', description: '最近消息，可 offset 往前翻' },
      { name: 'qq_get_my_recent_messages', flag: 'getMyRecent', description: '自己最近说过什么' },
      { name: 'qq_get_message_detail', flag: 'getMessageDetail', description: '按 messageId 看单条详情' },
      { name: 'qq_get_message_images', flag: 'getImages', description: '看消息里的图片/表情' },
      { name: 'qq_get_forward_msg', flag: 'getForwardMsg', description: '看合并转发内容' },
    ],
    defaultPrompt: '【翻历史】对话里出现"之前说过""你还记得吗"而当前快照里没有时，用 qq_get_group_history 或 qq_get_friend_msg_history 往前翻，别硬编。一次翻 20~50 条就够，别把整段历史拖进上下文。',
  },
  {
    id: 'groupInfo',
    label: '群信息与群协作',
    risk: 'mixed',
    actions: [
      'get_group_list', 'get_group_info', 'get_group_info_ex', 'get_group_detail_info',
      'get_group_member_list', 'get_group_member_info', 'get_group_honor_info',
      '_get_group_notice', 'get_essence_msg_list', 'get_group_todo_list',
      'get_group_signed_list', 'get_group_at_all_remain',
      'set_essence_msg', 'delete_essence_msg', 'set_group_todo',
      'complete_group_todo', 'cancel_group_todo', 'set_group_sign',
    ],
    independentTools: [
      { name: 'qq_get_group_profile', actions: ['get_group_info', 'get_group_info_ex', 'get_group_detail_info'], mode: 'A', description: '查本群资料：群名、人数、简介、公告等（detail=true 取更详细的一份）。' },
      { name: 'qq_get_member_profile', actions: ['get_group_member_info'], mode: 'B', description: '查本群某个成员的资料（群名片/头衔/入群时间），userId 须在本会话出现过。' },
      { name: 'qq_get_group_honor', actions: ['get_group_honor_info'], mode: 'A', description: '查本群荣誉：龙王、群聊之火、活跃榜等（聊天素材）。' },
    ],
    channelTool: { name: 'qq_group_collab_invoke', description: '群协作类动作（公告/精华/待办/打卡），需显式指定 action。' },
    legacyTools: [
      { name: 'qq_list_groups', flag: null, description: '机器人在哪些群' },
      { name: 'qq_get_group_members', flag: null, description: '群成员列表' },
      { name: 'qq_get_group_history', flag: null, description: '群消息历史' },
      { name: 'qq_get_active_members', flag: 'getActiveMembers', description: '最近说话的人' },
    ],
    defaultPrompt: '【群信息】要判断"这群是干嘛的"、搭话前确认群名人数简介时用 qq_get_group_profile；要聊某个具体的人用 qq_get_member_profile，且只在 userId 已在本会话出现过时用。不要为了闲聊反复拉 qq_get_group_members（整群名单又长又没必要），同一个群别连查三次以上。',
  },
  {
    id: 'groupAdmin',
    label: '群管理',
    risk: 'write',
    actions: [
      '_send_group_notice', '_del_group_notice',
      'set_group_kick', 'set_group_kick_members', 'set_group_ban', 'set_group_whole_ban',
      'set_group_anonymous', 'set_group_anonymous_ban',
      'set_group_card', 'set_group_name', 'set_group_portrait', 'set_group_remark',
      'set_group_special_title', 'set_group_admin', 'set_group_leave',
      'set_group_add_option', 'set_group_member_invite_policy', 'set_group_member_permissions',
      'set_group_new_member_history_visibility', 'set_group_robot_add_option', 'set_group_search',
      'add_group_tag', 'delete_group_tag', 'get_group_tags',
      'get_group_admin_settings', 'get_group_shut_list',
    ],
    independentTools: [],
    channelTool: { name: 'qq_group_admin_invoke', description: '群管理动作（踢人/禁言/改名/权限/公告…）。破坏性操作，调用前必须说清后果。' },
    defaultPrompt: '【群管理】这些是有副作用甚至不可撤销的动作（踢人、禁言、退群、改群设置）。只有 owner 明确要求、且你已复述将发生什么之后再调；拿不准就先问，别自己决定。踢人/退群/全员禁言一律先在群里或私聊说明理由。',
  },
  {
    id: 'friend',
    label: '好友·用户资料·申请',
    risk: 'mixed',
    actions: [
      'get_friend_list', 'get_friends_with_category', 'get_unidirectional_friend_list',
      'get_stranger_info', '_get_friend_dress', 'get_profile_like',
      'get_doubt_friends_add_request', 'get_group_ignore_add_request', 'get_group_ignored_notifies',
      'set_friend_add_request', 'set_doubt_friends_add_request', 'set_group_add_request',
      'set_friend_remark', 'set_friends_category', 'delete_friend',
    ],
    independentTools: [
      { name: 'qq_get_stranger', actions: ['get_stranger_info'], mode: 'B', description: '查一个陌生 QQ 号的资料（昵称/性别/年龄/等级），对象须在本会话出现过。' },
      { name: 'qq_get_friend_list', actions: ['get_friend_list', 'get_friends_with_category'], mode: 'A', description: '查好友列表（只返回计数与命中，不整表倾倒）。' },
      { name: 'qq_list_friend_requests', actions: ['get_doubt_friends_add_request', 'get_unidirectional_friend_list', 'get_group_ignore_add_request', 'get_group_ignored_notifies'], mode: 'A', description: '查好友/入群申请与单向好友（只读）。' },
    ],
    channelTool: { name: 'qq_friend_invoke', description: '好友相关写操作（处理申请/改备注/分组/删好友），需显式指定 action。' },
    legacyTools: [],
    defaultPrompt: '【好友与资料】想知道"这人是谁"时用 qq_get_stranger（id 必须来自本会话），别去猜。加好友/删好友/处理申请是 owner 的事，未经明确同意不要动。',
  },
  {
    id: 'emoji',
    label: '表情与收藏',
    risk: 'mixed',
    actions: [
      'fetch_sys_faces', 'search_sys_faces', 'fetch_face_entity', 'fetch_super_face_id',
      'fetch_custom_face', 'fetch_custom_face_detail', 'get_collection_list',
      'get_emoji_likes', 'get_msg_emoji_likes', 'fetch_emoji_like',
      'add_custom_face', 'delete_custom_face', 'modify_custom_face', 'move_custom_face_to_front',
      'set_msg_emoji_like', 'set_group_reaction',
    ],
    independentTools: [
      { name: 'qq_search_sys_faces', actions: ['search_sys_faces'], mode: 'A', description: '按关键词搜 QQ 系统表情（找可用表情名/id）。' },
      { name: 'qq_fetch_sys_faces', actions: ['fetch_sys_faces'], mode: 'A', description: '拉取 QQ 系统表情目录（配合 qq_search_sys_faces 用）。' },
      { name: 'qq_get_msg_emoji_likes', actions: ['get_msg_emoji_likes'], mode: 'B', description: '看某条消息收到了哪些表情回应（谁给你点了赞）。' },
    ],
    channelTool: { name: 'qq_emoji_invoke', description: '表情相关写操作与收藏管理（加/删/改收藏、给消息贴表情回应）。' },
    legacyTools: [
      { name: 'qq_list_stickers', flag: 'listStickers', description: '查看/搜索收藏表情' },
      { name: 'qq_send_sticker', flag: 'sendSticker', description: '发收藏表情（一张一条）' },
      { name: 'qq_get_sticker_image', flag: 'getStickerImage', description: '看图理解收藏表情' },
      { name: 'qq_collect_sticker', flag: 'collectSticker', description: '收藏别人发的表情并写备注' },
      { name: 'qq_sticker_note', flag: 'stickerNote', description: '记录表情的本含义/标签' },
      { name: 'qq_set_sticker_remark', flag: 'setStickerRemark', description: '改 QQ 官方表情备注（默认关）' },
      { name: 'qq_get_self_image', flag: 'getSelfImage', description: '看自己的默认形象' },
    ],
    defaultPrompt: '【表情】发收藏表情用 qq_send_sticker（已有）；想用系统表情先 qq_search_sys_faces 确认名字，别凭印象编。给别人的消息贴表情回应（qq_emoji_invoke 的 set_msg_emoji_like）是轻量互动，一次对话里点到为止。',
  },
  {
    id: 'file',
    label: '文件·闪传·媒体',
    risk: 'mixed',
    actions: [
      'get_group_root_files', 'get_group_files_by_folder', 'get_group_file_url',
      'get_group_file_system_info', 'upload_group_file', 'delete_group_file',
      'rename_group_file', 'move_group_file', 'create_group_file_folder',
      'delete_group_file_folder', 'delete_group_folder', 'rename_group_file_folder',
      'trans_group_file', 'get_private_file_url', 'upload_private_file',
      'get_fileset_id', 'get_fileset_info', 'get_flash_file_list', 'get_flash_file_url',
      'list_filesets', 'create_flash_task', 'delete_flash_file', 'rename_flash_file',
      'download_fileset', 'get_share_link', 'send_flash_msg',
      'get_file', 'get_image', 'download_file',
      'download_file_stream', 'download_file_image_stream', 'download_file_record_stream',
      'upload_file_stream', 'test_download_stream', 'clean_stream_temp_file', 'ocr_image',
    ],
    independentTools: [
      { name: 'qq_get_group_files', actions: ['get_group_root_files', 'get_group_files_by_folder'], mode: 'A', description: '列本群文件（根目录或指定文件夹）。' },
      { name: 'qq_get_group_file_url', actions: ['get_group_file_url'], mode: 'A', description: '取本群文件的下载直链。' },
    ],
    channelTool: { name: 'qq_file_invoke', description: '文件/闪传/媒体类动作（上传、删除、私聊文件、OCR），需显式指定 action。' },
    legacyTools: [],
    defaultPrompt: '【文件】只在对方明确要文件、或你要确认"群里那个文件是什么"时用。上传/删除群文件是 owner 级操作；流式接口不在工具面里，别试。',
  },
  {
    id: 'qzone',
    label: 'QQ 空间',
    risk: 'write',
    actions: [
      'get_qzone_msg_list', 'get_qzone_feeds', 'send_qzone_msg', 'delete_qzone_msg',
      'comment_qzone', 'like_qzone', 'unlike_qzone', 'set_qzone_msg_right', 'set_qzone_ban',
    ],
    independentTools: [
      { name: 'qq_get_qzone_list', actions: ['get_qzone_msg_list'], mode: 'A', description: '看说说列表（默认看自己空间）。' },
      { name: 'qq_get_qzone_feeds', actions: ['get_qzone_feeds'], mode: 'A', description: '看空间好友动态 feed（只有首页可靠，别深翻）。' },
    ],
    channelTool: { name: 'qq_qzone_invoke', description: '空间写操作（发/删说说、评论、点赞、权限、黑名单），需显式指定 action。' },
    legacyTools: [],
    defaultPrompt: '【空间】发说说/评论/点赞都是公开动作，等于用账号发言。只有 owner 明确要求才发；替别人点赞前想清楚。看动态只翻首页。',
  },
  {
    id: 'album',
    label: '群相册',
    risk: 'mixed',
    actions: [
      'get_group_album_list', 'get_qun_album_list', 'get_group_album_media_list',
      'upload_image_to_qun_album', 'upload_video_to_qun_album', 'del_group_album_media',
      'set_group_album_media_like', 'cancel_group_album_media_like', 'do_group_album_comment',
    ],
    independentTools: [],
    channelTool: { name: 'qq_album_invoke', description: '群相册动作（列表/上传/删除/点赞/评论），需显式指定 action。' },
    legacyTools: [],
    defaultPrompt: '【群相册】低频。只有话题明确指向相册（"上次那张图"）时才看；上传/删除由 owner 决定。',
  },
  {
    id: 'account',
    label: '账号与在线状态',
    risk: 'write',
    actions: [
      'set_qq_profile', 'set_qq_avatar', 'set_self_longnick',
      'set_online_status', 'set_diy_online_status',
      'clean_cache', 'set_restart', 'bot_exit',
    ],
    independentTools: [],
    channelTool: { name: 'qq_account_invoke', description: '账号资料与在线状态（昵称/头像/签名/状态/清缓存），需显式指定 action。' },
    legacyTools: [],
    defaultPrompt: '【账号】改昵称/头像/签名/在线状态会影响别人看到你的样子，只有 owner 明确要求才动。bot_exit 与重启不在工具面里。',
  },
  {
    id: 'credential',
    label: '凭据与底层协议',
    risk: 'never',
    actions: [
      'get_cookies', 'get_credentials', 'get_csrf_token', 'get_clientkey',
      'get_rkey', 'get_rkey_server', 'request_decrypt_key', 'send_packet',
    ],
    independentTools: [],
    channelTool: null,
    legacyTools: [],
    defaultPrompt: '',
  },
  {
    id: 'system',
    label: '能力·系统信息',
    risk: 'read',
    actions: [
      'get_login_info', 'get_status', 'get_version_info',
      'can_send_image', 'can_send_record', 'get_online_clients',
      'nc_get_user_status', 'translate_en2zh',
    ],
    independentTools: [
      { name: 'qq_get_online_clients', actions: ['get_online_clients'], mode: 'A', description: '查当前账号在哪些客户端在线（只读）。' },
      { name: 'qq_can_send', actions: ['can_send_image', 'can_send_record'], mode: 'A', description: '查当前账号能否发图片/语音（能力探测）。' },
      { name: 'qq_get_version', actions: ['get_version_info'], mode: 'A', description: '查 SnowLuma 版本与 OneBot 协议版本。' },
      { name: 'qq_get_user_status', actions: ['nc_get_user_status'], mode: 'B', description: '查某个 QQ 号的在线/扩展状态，对象须在本会话出现过。' },
    ],
    channelTool: null,
    legacyTools: [
      { name: 'qq_status', flag: null, description: '账号与在线状态' },
    ],
    defaultPrompt: '',
  },
  {
    id: 'voice',
    label: '语音',
    risk: 'mixed',
    actions: ['get_record', 'fetch_ptt_text', 'get_ai_characters', 'get_ai_record', 'send_group_ai_record'],
    independentTools: [
      { name: 'qq_get_record', actions: ['get_record'], mode: 'A', description: '取语音消息的音频信息（可选服务端转码）。' },
      { name: 'qq_fetch_ptt_text', actions: ['fetch_ptt_text'], mode: 'B', description: '取某条语音的转文字结果（历史语音）。' },
      { name: 'qq_get_ai_characters', actions: ['get_ai_characters'], mode: 'A', description: '查可用的 AI 语音角色（配合发声场景用）。' },
    ],
    channelTool: { name: 'qq_voice_invoke', description: 'AI 语音生成与发送，需显式指定 action。' },
    legacyTools: [
      { name: 'qq_send_voice', flag: 'sendVoice', description: '把语音库里的音频当语音发出去' },
      { name: 'qq_list_voices', flag: 'sendVoice', description: '查看语音库' },
    ],
    defaultPrompt: '【语音】发语音用 qq_send_voice（只能发语音库里的文件）。AI 合成语音（qq_voice_invoke）是强表达，偶然而为；听不清对方语音时先看唤醒提示里的转写，不够再 qq_fetch_ptt_text。',
  },
  {
    id: 'memory',
    label: '记忆与人物',
    risk: 'mixed',
    actions: [],
    independentTools: [],
    channelTool: null,
    legacyTools: [
      { name: 'qq_memory_append', flag: 'memory', description: '记一条轻量记忆' },
      { name: 'qq_memory_query', flag: 'memory', description: '查当前会话记忆' },
      { name: 'qq_memory_remove', flag: 'memory', description: '删一条记忆' },
      { name: 'qq_memory_clear', flag: 'memory', description: '清空记忆（可按类别）' },
      { name: 'qq_person_query', flag: 'personQuery', description: '查人物档案（跨群）' },
      { name: 'qq_person_note', flag: 'personNote', description: '给某人记长期印象' },
    ],
    defaultPrompt: '【记忆】轻量记忆（qq_memory_*）只存本次会话的话题与想说没说的话；人物档案（qq_person_*）按 QQ 号跨群共享，记稳定特征，不要记一次性闲聊或隐私信息。',
  },
  {
    id: 'slang',
    label: '黑话与梗',
    risk: 'read',
    actions: [],
    independentTools: [],
    channelTool: null,
    legacyTools: [
      { name: 'qq_slang_query', flag: 'slangQuery', description: '查已确认黑话/梗' },
      { name: 'qq_slang_submit', flag: 'slangSubmit', description: '提交陌生词给管理员' },
    ],
    defaultPrompt: '【黑话】遇到看不懂的词先 qq_slang_query；确认是新词/新梗时用 qq_slang_submit 提交给管理员，别在群里直接问“这是什么意思”。',
  },
  {
    id: 'wake',
    label: '唤醒与状态',
    risk: 'mixed',
    actions: [],
    independentTools: [],
    channelTool: null,
    legacyTools: [
      { name: 'qq_get_prompt', flag: 'getPrompt', description: '看角色卡/推荐值/工具清单/唤醒配置' },
      { name: 'qq_social_state', flag: 'socialState', description: '看未读数/上次唤醒原因' },
      { name: 'qq_set_wake_config', flag: 'setWakeConfig', description: '设置唤醒与潜水条件' },
      { name: 'qq_wait_for_messages', flag: 'waitMessages', description: '等待新消息（长轮询）' },
      { name: 'qq_report_feedback', flag: 'feedback', description: '把问题反馈给管理端' },
    ],
    defaultPrompt: '【唤醒与状态】每轮开始先看唤醒提示里的会话令牌与快照；要潜水前用 qq_wait_for_messages 完成沉睡前观察，再用 qq_set_wake_config 设下一次唤醒。卡住了用 qq_report_feedback，不要在群里播报内部状态。',
  },
  {
    id: 'placeholder',
    label: '占位/未实现',
    risk: 'never',
    actions: [
      '.get_word_slices', 'check_url_safely', '_get_model_show', '_set_model_show',
      'get_recent_contact', 'nc_get_packet_status', 'create_collection',
    ],
    independentTools: [],
    channelTool: null,
    legacyTools: [],
    defaultPrompt: '',
  },
];

// ── 索引 ────────────────────────────────────────────────────────────────────
const ACTION_GROUP = new Map();
for (const g of GROUPS) for (const a of g.actions) ACTION_GROUP.set(a, g.id);
const GROUP_BY_ID = new Map(GROUPS.map((g) => [g.id, g]));

export function groupOfAction(action) {
  return ACTION_GROUP.get(action) ?? null;
}

export function actionsOfGroup(id) {
  return GROUP_BY_ID.get(id)?.actions.slice() ?? [];
}

/** 某组的原有桥接工具（不是 OneBot action，开关是旧 flag）。 */
export function legacyToolsOfGroup(id) {
  return GROUP_BY_ID.get(id)?.legacyTools?.slice() ?? [];
}

/** 全部旧工具（控制台用来兜底渲染与校验不重复）。 */
export const ALL_LEGACY_TOOLS = GROUPS.flatMap((g) => (g.legacyTools ?? []).map((t) => ({ ...t, group: g.id })));

export function isNeverExposed(action) {
  return NEVER.has(action);
}

/** 组内"可以出现在工具面/白名单里"的 action（去掉 never 清单）。 */
export function exposableActions(id) {
  return actionsOfGroup(id).filter((a) => !NEVER.has(a));
}

/** 默认配置：16 组全关、无 action 开启。用于首次启动与测试。 */
export function defaultConfig() {
  return {
    socialV2: {
      toolGroups: Object.fromEntries(GROUPS.map((g) => [g.id, { enabled: false }])),
      tools: {},
    },
  };
}

/**
 * 归一化 `socialV2.toolGroups`（控制台保存时用）。
 * 只接受布尔；非布尔回落 false；未提交的组保留 current 的值。
 */
export function normalizeToolGroups(current, incoming) {
  const out = {};
  for (const g of GROUPS) {
    const fromIncoming = incoming && typeof incoming === 'object' ? incoming[g.id] : undefined;
    const fromCurrent = current && typeof current === 'object' ? current[g.id] : undefined;
    const raw = fromIncoming !== undefined ? fromIncoming?.enabled : fromCurrent?.enabled;
    out[g.id] = { enabled: raw === true };
  }
  return out;
}

/**
 * 两级开关判定：组开 && action 开 && 不在 never 清单。
 * 旧 flag（cfg.socialV2.tools.sendMessage 等）不参与，互不影响。
 */
export function actionEnabled(cfg, action) {
  if (NEVER.has(action)) return false;
  const gid = ACTION_GROUP.get(action);
  if (!gid) return false;
  const groupOn = cfg?.socialV2?.toolGroups?.[gid]?.enabled === true;
  if (!groupOn) return false;
  return cfg?.socialV2?.tools?.[action] === true;
}

/**
 * 注册期过滤：返回需要注册的工具列表。
 *
 * - 独立工具：其覆盖的 action 里**任一**启用即注册，`actions` 只带已启用的。
 * - 通道工具：组开 && 组内存在"已启用且没有被任何独立工具覆盖"的 action 才注册
 *   —— 否则会注册一个什么都调不了的壳（Review Focus 1）。
 */
export function toolsToRegister(cfg) {
  const out = [];
  for (const g of GROUPS) {
    if (g.risk === 'never') continue;
    const enabled = g.actions.filter((a) => actionEnabled(cfg, a));
    if (enabled.length === 0) continue;

    const covered = new Set();
    for (const tool of g.independentTools) {
      const hit = tool.actions.filter((a) => actionEnabled(cfg, a));
      if (hit.length === 0) continue;
      hit.forEach((a) => covered.add(a));
      out.push({ kind: 'independent', group: g.id, name: tool.name, mode: tool.mode, actions: hit, description: tool.description });
    }
    if (g.channelTool) {
      const rest = enabled.filter((a) => !covered.has(a));
      if (rest.length > 0) {
        out.push({ kind: 'channel', group: g.id, name: g.channelTool.name, actions: rest, description: g.channelTool.description });
      }
    }
  }
  return out;
}

/**
 * 某个 action 最终由哪个 MCP 工具承载：独立工具优先，其次本组通道工具。
 * 控制台抽屉用它显示"这个开关会出现在哪个工具里"。
 */
export function toolForAction(action) {
  for (const g of GROUPS) {
    for (const t of g.independentTools) {
      if (t.actions.includes(action)) return { kind: 'independent', name: t.name };
    }
  }
  const gid = ACTION_GROUP.get(action);
  const g = gid ? GROUP_BY_ID.get(gid) : null;
  if (g?.channelTool) return { kind: 'channel', name: g.channelTool.name };
  return null;
}

/** 某组当前可用的提示词（默认文本），控制台"恢复默认"用。 */
export function defaultPromptOf(id) {
  return GROUP_BY_ID.get(id)?.defaultPrompt ?? '';
}

/**
 * key 类型与 action 是否匹配。
 * 规则刻意保守：**action 名里带 group 的，必须给 group: key**；其余放行。
 * 误判方向是"拒绝"而不是"用错 id 发出去"，符合 Review Focus 3。
 */
export function keyKindOkFor(action, key) {
  const k = String(key ?? '');
  if (/group/i.test(String(action ?? ''))) return k.startsWith('group:');
  return true;
}

// ── 独立工具的参数规格 ──────────────────────────────────────────────────────
// 值：'string' | 'number' | 'boolean'，带 '?' 表示可选。MCP 侧据此造 zod schema。
// 参数名用 camelCase，落到 OneBot 时由 actionParamsFrom() 转 snake_case。
export const TOOL_PARAMS = {
  qq_recall_message: { messageId: 'string' },
  qq_forward_msg: { messageId: 'string', groupId: 'string?', userId: 'string?' },
  qq_send_like: { userId: 'string', times: 'number?' },
  qq_set_typing: { userId: 'string' },
  qq_get_msg: { messageId: 'string' },
  qq_get_friend_msg_history: { count: 'number?' },
  qq_get_group_system_msg: { count: 'number?' },
  qq_get_group_profile: { detail: 'boolean?' },
  qq_get_member_profile: { userId: 'string' },
  qq_get_group_honor: { type: 'string?' },
  qq_get_stranger: { userId: 'string' },
  qq_get_friend_list: { grouped: 'boolean?' },
  qq_list_friend_requests: { kind: 'string?' },
  qq_search_sys_faces: { query: 'string' },
  qq_fetch_sys_faces: {},
  qq_get_msg_emoji_likes: { messageId: 'string' },
  qq_get_group_files: { folderId: 'string?' },
  qq_get_group_file_url: { fileId: 'string', busid: 'number?' },
  qq_get_qzone_list: {},
  qq_get_qzone_feeds: { count: 'number?' },
  qq_get_online_clients: {},
  qq_can_send: { voice: 'boolean?' },
  qq_get_version: {},
  qq_get_user_status: { userId: 'string' },
  qq_get_record: { fileId: 'string' },
  qq_fetch_ptt_text: { messageId: 'string' },
  qq_get_ai_characters: {},
};

const CAMEL_TO_SNAKE = {
  messageId: 'message_id',
  userId: 'user_id',
  groupId: 'group_id',
  fileId: 'file_id',
  folderId: 'folder_id',
  busid: 'busid',
  count: 'count',
  type: 'type',
  times: 'times',
  query: 'query',
  kind: 'kind',
};

/** 把工具的 camelCase 参数转成 OneBot 的 snake_case（丢掉未识别的键）。 */
export function actionParamsFrom(args = {}) {
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue;
    const mapped = CAMEL_TO_SNAKE[k];
    if (mapped) out[mapped] = v;
  }
  return out;
}

const TOOL_BY_NAME = new Map();
for (const g of GROUPS) for (const t of g.independentTools) TOOL_BY_NAME.set(t.name, { ...t, group: g.id });

export function toolByName(name) {
  return TOOL_BY_NAME.get(name) ?? null;
}

/**
 * 多 action 的独立工具：按参数选真正要调的 action。
 * 单 action 的工具直接返回它定义里的第一个（也是唯一一个）。
 */
export function resolveToolAction(toolName, args = {}) {
  const tool = toolByName(toolName);
  if (args.action !== undefined) return tool?.actions.includes(args.action) ? args.action : null;
  switch (toolName) {
    case 'qq_get_group_profile': return args.detail ? 'get_group_detail_info' : 'get_group_info';
    case 'qq_get_group_files': return args.folderId ? 'get_group_files_by_folder' : 'get_group_root_files';
    case 'qq_get_friend_list': return args.grouped ? 'get_friends_with_category' : 'get_friend_list';
    case 'qq_forward_msg': return args.groupId ? 'forward_group_single_msg' : 'forward_friend_single_msg';
    case 'qq_can_send': return args.voice ? 'can_send_record' : 'can_send_image';
    case 'qq_list_friend_requests': {
      const kind = String(args.kind ?? '');
      if (kind === 'unidirectional') return 'get_unidirectional_friend_list';
      if (kind === 'group-ignored') return 'get_group_ignored_notifies';
      if (kind === 'group-ignored-napcat') return 'get_group_ignore_add_request';
      return 'get_doubt_friends_add_request';
    }
    default:
      return toolByName(toolName)?.actions?.[0] ?? null;
  }
}

/** 注册表派生的基础工具状态，控制台与 prompt 共用。 */
export function legacyToolEnabled(cfg, tool) {
  if (tool.flag && cfg?.socialV2?.tools?.[tool.flag] === false) return false;
  if (tool.flag === 'sendVoice') return cfg?.socialV2?.voice?.enabled === true;
  if (['listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote', 'collectSticker'].includes(tool.flag)) {
    if (cfg?.socialV2?.sticker?.enabled === false) return false;
  }
  if (tool.flag === 'setStickerRemark') return cfg?.socialV2?.tools?.setStickerRemark === true;
  return true;
}

export function enabledToolNames(cfg) {
  return [...ALL_LEGACY_TOOLS.filter((t) => legacyToolEnabled(cfg, t)).map((t) => t.name),
    ...toolsToRegister(cfg).map((t) => t.name)];
}

/**
 * 目标范围校验：params 里的 group_id / user_id / message_id 必须落在
 * 本会话可见或允许列表内。这是 C1 的修复——通道工具不能靠 key 白名单
 * 就操作任意群/任意人。
 */
export function validateToolTarget({ action, key, params = {}, allowGroups = [], allowPrivate = [], sessionUserIds = [], sessionMessageIds = null } = {}) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? ''));
  if (!m) return { ok: false, status: 400, error: 'key 格式应为 group:群号 或 private:QQ号' };
  const kind = m[1];
  const id = m[2];
  const groups = (allowGroups ?? []).map(String);
  const privates = (allowPrivate ?? []).map(String);
  const sessionUsers = (sessionUserIds ?? []).map(String);

  if (params.group_id !== undefined && params.group_id !== null) {
    const gid = String(params.group_id);
    if (kind !== 'group' || gid !== id || (groups.length > 0 && !groups.includes(gid))) {
      return { ok: false, status: 403, error: `目标群不在本会话允许范围内：${gid}` };
    }
  }
  for (const field of ['user_id', 'target_id', 'targetUserId', 'userIds']) {
    const raw = params[field];
    if (raw === undefined || raw === null) continue;
    const list = Array.isArray(raw) ? raw : [raw];
    for (const item of list) {
      const uid = String(item);
      const okUser = (kind === 'private' && uid === id) || privates.includes(uid) || sessionUsers.includes(uid);
      if (!okUser) return { ok: false, status: 403, error: `目标用户不在本会话范围内：${uid}` };
    }
  }
  if (params.message_id !== undefined && params.message_id !== null && Array.isArray(sessionMessageIds)) {
    const mid = String(params.message_id);
    if (!sessionMessageIds.map(String).includes(mid)) {
      return { ok: false, status: 403, error: `消息不在本会话可见范围内：${mid}` };
    }
  }
  return { ok: true };
}

/**
 * 出站内容审计：把 params 里所有字符串交给与桥接发送端相同的特征表。
 * 命中即拒（不是打码），与桥接既有出站审计口径一致。
 */
export function auditToolParams(params, sensitiveRe) {
  if (!sensitiveRe || typeof sensitiveRe.test !== 'function') return { ok: true };
  const seen = new Set();
  const visit = (value) => {
    if (value == null) return null;
    if (typeof value === 'string') return sensitiveRe.test(value) ? value : null;
    if (typeof value !== 'object' || seen.has(value)) return null;
    seen.add(value);
    for (const v of Object.values(value)) {
      const hit = visit(v);
      if (hit) return hit;
    }
    return null;
  };
  const hit = visit(params);
  return hit ? { ok: false, status: 403, error: '出站内容命中敏感特征，已拦截' } : { ok: true };
}

/**
 * 控制台（管理端令牌）试调用的授权判定：不需要会话令牌，但仍守 never + 开关。
 */
export function authorizeConsoleToolCall({ cfg, action } = {}) {
  if (!groupOfAction(action)) return { ok: false, status: 400, error: `未知 action：${action}` };
  if (isNeverExposed(action)) return { ok: false, status: 403, error: `该 action 永不可暴露：${action}` };
  if (!actionEnabled(cfg, action)) return { ok: false, status: 403, error: `工具未启用：${action}（需同时打开所属组开关）` };
  return { ok: true };
}

/**
 * 通用动作端点（POST /api/socialV2/tools/call）的授权判定。
 *
 * 抽成纯函数是为了：闸门顺序可以逐条单测，而不是靠"起一个桥接手工点一下"。
 * 顺序本身是安全语义的一部分——先认令牌、再认模式、最后才告诉调用者
 * "这个 action 存不存在/开没开"，避免把工具面当探测面用。
 *
 * 返回 `{ ok: true }` 或 `{ ok: false, status: number, error: string }`。
 */
export function authorizeToolCall({
  cfg,
  action,
  key,
  tokenOk,
  sessionAllowed,
  mode,
  keyKindOk,
} = {}) {
  if (!tokenOk) return { ok: false, status: 403, error: '未授权：智能体调用必须携带有效的会话令牌' };
  if (mode !== 'reserved2') return { ok: false, status: 403, error: '该接口仅 reserved2 模式可用' };
  if (!sessionAllowed) return { ok: false, status: 403, error: '目标不在当前模式允许范围内' };
  if (typeof action !== 'string' || !action) return { ok: false, status: 400, error: 'action 不能为空' };
  if (!groupOfAction(action)) return { ok: false, status: 400, error: `未知 action：${action}` };
  if (isNeverExposed(action)) {
    return { ok: false, status: 403, error: `该 action 永不可暴露：${action}` };
  }
  if (!actionEnabled(cfg, action)) {
    return { ok: false, status: 403, error: `工具未启用：${action}（需同时打开所属组开关）` };
  }
  if (keyKindOk === false) {
    return { ok: false, status: 400, error: `key 类型与 action 不符：${action} 需要 ${key ?? 'group:'} 会话` };
  }
  return { ok: true };
}
