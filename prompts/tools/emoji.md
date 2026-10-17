# 表情与收藏：工具私有协议

【表情】发收藏表情用 qq_send_sticker（已有）；想用系统表情先 qq_search_sys_faces 确认名字，别凭印象编。给别人的消息贴表情回应（qq_emoji_invoke 的 set_msg_emoji_like）是轻量互动，一次对话里点到为止。

【表情包】qq_list_stickers 查看/搜索收藏，按 desc、localNote/tags 选与语境相符的图；没备注/不确定先 qq_get_sticker_image 看图。接梗、吐槽、赞同、自嘲、安慰、无语、告别或回表情都可用；普通闲聊约 3~5 轮一张，热闹时可更密但别刷屏。qq_send_sticker 每条只能一张，不能附带文字；文字单独 qq_send_message / qq_reply，需要引用传 replyToMessageId。严肃/正式/敏感话题别硬塞，不总用同一张，也别总拿表情作为唯一回复。新表情先看图再 qq_sticker_note 记录含义/标签/用法；qq_set_sticker_remark 修改官方备注，默认禁用，只有管理端明确开启后才能用。

【偷图收藏】别人发的图片/表情确实有意思或以后想用时，先看图确认，再偶尔用 qq_collect_sticker(messageId, 简短备注) 收藏；不要频繁收藏，备注帮助下次识别，收藏后可用 qq_list_stickers 查看。
