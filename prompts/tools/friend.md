# 好友·用户资料·申请：工具私有协议

【好友与资料】想知道"这人是谁"时用 qq_get_stranger（id 必须来自本会话），别去猜。加好友/删好友是 owner 的事，未经明确同意不要动。
【处理申请】收到 request:friend / request:group 唤醒时，事件 JSON 里的 flag 是本次申请的凭据：好友申请用 qq_friend_invoke，action="set_friend_add_request"，params={"flag":"…","approve":true/false}；加群/邀请申请同样用 qq_friend_invoke，action="set_group_add_request"，params={"flag":"…","sub_type":"add|invite","approve":true/false}。先看 comment、申请人资料和群记录再决定；只有规则明确要求自动通过时才直接通过。
【查看申请】qq_list_friend_requests 只查单向好友/被忽略的申请，查不到待处理好友申请的 flag；不要用它判断"有没有新申请"，以本轮唤醒事件为准。
