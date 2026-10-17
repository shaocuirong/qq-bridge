# 已读水位：工具私有协议

【已读水位】快照与读消息/等待工具返回的 readThroughSeq 表示本次读到的安全水位；收尾只提交已经看过的水位，不自行猜测/增加。readThroughSeq 是桥接本地的 seq，不是 QQ messageId，两者不能混用；引用、看图或收藏用消息的 messageId。没有水位的旧调用仍兼容，但有水位就传 throughSeq，避免把你没看到的新消息一起标成已读。
