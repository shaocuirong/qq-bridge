# 入站语音识别（ASR）：让 AI 听懂 QQ 语音（docs/guides/ASR.md）

> 状态：✅ 新增功能（2026-10-16）。与 [VOICE.md](VOICE.md) 的「**发**语音」是两回事，互相独立。

## 一句话

别人在 QQ 里发一条语音，桥接把它转成文字写进这条消息（`[语音: 今天下雨了]`），AI 于是"听得见"；
识别不出来就老老实实保留 `[语音]` 占位，**绝不编造内容**。

| | 谁在用 | 默认 | 会不会外发数据 |
| --- | --- | --- | --- |
| **发语音**（`socialV2.voice`） | AI / 操作者 → QQ 语音条 | **关** | 会把本地音频发到 QQ |
| **听语音**（`socialV2.asr`，本文） | QQ 语音条 → AI 的上下文 | **开** | 不外发；音频与推理都在本机 |

---

## 1. 链路（每一步为什么是这样）

```
QQ 语音条（SILK v3）
  → SnowLuma 收到并缓存 record（uuid/md5/duration/size/format）
  → 桥接 get_record(file, out_format=wav)      ← 关键：SILK 只有网关能解，实测 ~180ms
  → 本地 ffmpeg：-ac 1 -ar 16000 -c:a pcm_s16le   （并重建成严格 44 字节头的规范 WAV）
  → DSH 内置语音插件的推理子进程（SenseVoice，本地 CPU）
  → 文本 → 写进消息正文 [语音: 文本]
```

三个必须知道的实现事实：

1. **QQ 发来的是 SILK，不是 AMR**。段里的文件名可能叫 `xxx.amr`，内容却是 `#!SILK_V3`；
   `ffmpeg` 没有 SILK 解码器（会以 `AVERROR_INVALIDDATA` 退出），所以必须先让网关解码。
2. **推理用的是 DSH 自带的语音插件**，不是另装一套：`@deepseek-ai/dsh-experimental-speech-to-text-sensevoice`
   本来就把推理放在独立子进程 `lib/worker.js` 里（`argv[2]`=配置 JSON、`DSH_SPEECH_TOKEN`、
   stdout 打印 `{"port":N}`、`POST /transcribe?language=auto` 收 16kHz 单声道 PCM16 WAV）。
   桥接把这个 worker 拉起来直接用 —— 同一份代码、同一份模型缓存。
   （DSH 的 speech Remote 走的是浏览器客户端专用的 Typert RPC 通道，外部进程复刻它成本高、
   还依赖"客户端 UI 插件已挂载"，所以不走那条路。）
3. **入站不等它**。识别是"先占位、后补写"：入站时最多等 `inlineWaitMs`（默认 1500ms），
   等到了就一次写进正文；没等到先入库为 `[语音]`，后台跑完再把那条消息改写成 `[语音: 文本]`
   —— 消息入库与唤醒判定不会被识别拖住。若这条语音因此命中唤醒条件（比如语音里喊了名字），
   还会补一次唤醒（`wakeOnTranscript`）。
4. **纯语音消息会"等齐了再叫醒 AI"**。一条消息里只有语音、没有别的文字时，如果它本来就会唤醒 AI，
   唤醒会在转写落地之后才发生（最多等 `voiceWakeMaxWaitMs`，默认 15s）。原因很直白：
   否则 AI 一睁眼看到的是 `[语音]`，只能回一句"听不见"——用户体感就是"识别没生效"。
   等了这么久还没结果（比如 worker 冷启动异常）就按占位照常唤醒，消息不会卡死。

## 2. 两条来源（`socialV2.asr.sources`，顺序即回退顺序）

| 来源 | 是什么 | 优点 | 边界 |
| --- | --- | --- | --- |
| `dsh` | DSH 内置 SenseVoice 子进程（本地 CPU） | 离线、不联网、不看 QQ 脸色；中文/英文/粤语/日/韩；实测一条 3 秒语音推理 ~0.2s（首次要加载模型 ~2.5s） | 需要先抽运行时 + 下模型（见 §3）；占用 CPU |
| `qq` | 网关动作 `fetch_ptt_text`（QQ 服务端转写） | 快（~250ms）、零依赖 | 只覆盖"**别人发来、且 QQ 自己转过**"的语音；历史里翻出来的旧语音常见等 20s 后 `retcode=100 语音转文字超时（未收到结果推送）` |

两条都失败 → 保留 `[语音]`，并在 `state/bridge.log` 与 `/api/asr/status` 里留下原因。

## 3. 准备（两条命令，都在 `speech-asr/`）

```powershell
# ① 从 DSH 安装包里抽出 worker 运行时（10 个包 / 约 22MB，含 sherpa-onnx 原生库与其依赖闭包）
node <工作区>\speech-asr\extract-dsh-speech.mjs

# ② 下载 SenseVoice 模型到 DSH 自己的缓存目录（int8 约 228MB + 词表 + Silero VAD，带 SHA-256 校验）
node <工作区>\_local\fetch-sensevoice-model.mjs
```

- 模型目标目录就是 DSH 语音插件用的那一份：
  `%USERPROFILE%\.dsh\speech-to-text\sensevoice\models\sensevoice-onnx\`
  —— **一份模型两处用**：DSH 界面里的语音输入插件（麦克风）也直接生效，不必再点"下载并准备"。
- 下载源顺序：`huggingface.co` → `hf-mirror.com`（实测本机 hf-mirror 可用，huggingface 直连会 fetch failed）。
- 抽取脚本按 `app.asar` 头部解包，**原生模块优先取 `app.asar.unpacked` 里的真实文件**；
  只比大小会踩坑（asar 里的占位文件和真文件大小可能一样，加载时会报 `is not a valid Win32 application`）。
  DSH 升级后重跑 ①（worker 代码/依赖版本跟着安装包走）。

## 4. 配置（`config.json` → `socialV2.asr`）

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关（关掉就退回只显示 `[语音]`） |
| `sources` | `["dsh","qq"]` | 来源与回退顺序；只认 `dsh` / `qq` |
| `inlineWaitMs` | `1500` | 入站最多同步等多久；没等到改走后台补写 |
| `maxChars` | `200` | 写进消息的转写文本上限（超出加省略号） |
| `cacheTtlMs` | `1800000` | 同一条消息的识别结果缓存（成功/失败都缓存，避免重复烧 CPU） |
| `maxPerMinute` | `30` | 识别次数限流 |
| `wakeOnTranscript` | `true` | 迟到转写命中唤醒条件时补唤醒 |
| `voiceWakeMaxWaitMs` | `15000` | 纯语音消息：唤醒前最多等转写多久（超时按占位唤醒） |
| `maxBytes` / `maxSeconds` | 4MB / 120s | 音频上限（会透传给 worker 的 `maxAudioBytes`） |
| `ffmpegPath` | `""` | 空 = 走 `PATH` / `FFMPEG_PATH` |
| `dsh.nodePath` | `""` | 空 = 桥接自己的 node；建议填 DSH 自带 node（与插件运行环境一致） |
| `dsh.runtimeDir` | `""` | 空 = `<cwd>/speech-asr/runtime` |
| `dsh.modelDir` | `""` | 空 = `<DSH_HOME>/speech-to-text/sensevoice/models/sensevoice-onnx` |
| `dsh.threads` | `2` | 推理线程数 |
| `dsh.language` | `auto` | `auto`/`zh`/`en`/`yue`/`ja`/`ko` |
| `dsh.timeoutMs` / `startupTimeoutMs` / `idleTimeoutMs` | 120s / 180s / 300s | 单次推理 / 启动 / 空闲释放 worker（模型留在磁盘，下次唤醒只重新加载） |

## 5. 怎么看它在工作

```powershell
# 运行态（仅控制台令牌可用；带 agent token 一律 403）
curl.exe -s "http://127.0.0.1:3100/api/asr/status?token=<state/console-token>"

# 手动试转一条（messageId 或 file/url 任选；只给 messageId 时回网关取 record 段）
curl.exe -s -X POST "http://127.0.0.1:3100/api/asr/transcribe?token=<token>" `
  -H "content-type: application/json" -d '{\"messageId\":\"1890134393\"}'

# 补转历史：把某个会话（或全部会话）里还是 [语音] 占位的消息补上文字
curl.exe -s -X POST "http://127.0.0.1:3100/api/asr/backfill?token=<token>" `
  -H "content-type: application/json" -d '{\"key\":\"group:1064849619\",\"limit\":10}'
```

- `/api/status` 里也带一份精简的 `asr` 计数（**不含转写文本**——聊天内容不进状态接口）。
- 日志：`state/bridge.log` 搜 `[asr]`；控制台活动流里会看到 `[asr] 语音转写（dsh）：…`。

## 6. 出问题时先看哪

| 现象 | 先查 |
| --- | --- |
| `ready:false` + `missing: [...]` | 模型没下完/目录不对 → 跑 §3 的 ② |
| `缺少 worker 运行时` | 没跑 §3 的 ①，或 DSH 升级后没重跑 |
| `is not a valid Win32 application` | 原生模块抽成了 asar 里的占位文件（用本仓库的抽取脚本，别手工解包） |
| 一直回退到 `qq` 且 QQ 那条超时 | 正常现象：旧的/QQ 没转写过的语音；看 `stats.dsh.lastError` |
| 转写文本是乱码/空白 | `get_record(out_format=wav)` 给的采样率不是 16k 时会被重采样，正常；空白说明是真没说话 |
| `ffmpeg` 报 `AVERROR_INVALIDDATA` | 拿到的是 SILK 原始字节（说明走了直链兜底而不是 `get_record`） |

## 7. 安全边界

- 语音音频**只在本机流转**：网关取字节 → 临时目录里转码 → 喂给本机 worker；不调用任何第三方 ASR 云服务。
- 临时文件用后即删（`os.tmpdir()/qq-bridge-asr/`）。
- 转写文本与普通聊天文本同级别：走同一套敏感信息审计，进入模型上下文，不额外落盘。
- `/api/asr/*` 属于**操作者面**：控制台令牌才可用，带 `x-agent-token` 的调用一律 403（避免把聊天内容
  与进程/模型信息暴露给会话级主体）。
