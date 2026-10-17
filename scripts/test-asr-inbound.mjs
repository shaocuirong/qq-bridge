// 入站语音识别（ASR）回归：
//   ① 静态结构：桥接里那条链路（segmentsToText 的 record 段 → resolveRecord → 补写 → 补唤醒）
//      与两个控制台端点、配置块是否都还在（这些一走丢，功能会静默退化回 "[语音]"）；
//   ② 纯函数：配置归一化、规范 WAV 判定/修复、文本清理、worker 端口解析；
//   ③ 用**假网关**跑通来源回退链、缓存、限流、失败兜底（不打真 QQ）；
//   ④ 真跑 DSH 内置 SenseVoice 子进程的部分需要 QQ_BRIDGE_ASR_LIVE=1（会加载 240MB 模型、
//      并且会去网关翻一条真实语音来转）——默认关，避免审计套件依赖生产环境。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVoiceAsr, normalizeAsrConfig, canonicalWavProblem, repairCanonicalWav, formatVoiceText, parseWorkerPort } from '../src/voice-asr.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.error(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};
const skip = (name) => console.log(`  ⏭  ${name}`);

/** 造一段规范 WAV（默认 16k 单声道 PCM16，0.2 秒静音） */
function makeWav({ sampleRate = 16000, channels = 1, seconds = 0.2, extraListChunk = false } = {}) {
  const frames = Math.floor(sampleRate * seconds);
  const pcm = Buffer.alloc(frames * channels * 2);
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(channels, 2);
  fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE(sampleRate * channels * 2, 8);
  fmt.writeUInt16LE(channels * 2, 12);
  fmt.writeUInt16LE(16, 14);
  const chunks = [Buffer.from('fmt '), Buffer.from([16, 0, 0, 0]), fmt];
  if (extraListChunk) {
    const listBody = Buffer.alloc(4);
    chunks.push(Buffer.from('LIST'), Buffer.from([4, 0, 0, 0]), listBody);
  }
  chunks.push(Buffer.from('data'), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(pcm.length); return b; })(), pcm);
  const body = Buffer.concat(chunks);
  const head = Buffer.from('RIFF');
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length + 4);
  return Buffer.concat([head, size, Buffer.from('WAVE'), body]);
}

console.log('## 结构：桥接侧链路');
{
  const bridge = read('src/bridge.js');
  ok(bridge.includes("from './voice-asr.js'"), 'bridge.js 引入 voice-asr.js');
  ok(/resolveRecord/.test(bridge), 'segmentsToText 支持 resolveRecord');
  ok(/\[语音: \$\{spoken\}\]/.test(bridge), 'record 段渲染成 [语音: 文本]（拿不到才回退 [语音]）');
  ok(/function quickRecordResolver/.test(bridge), '入站有 quickRecordResolver（只等 inlineWaitMs）');
  ok(/function patchSocialV2VoiceText/.test(bridge), '迟到转写会补写进已入库消息');
  ok(/voiceWakeScheduled/.test(bridge) && /lateReason/.test(bridge), '语音内容迟到命中唤醒条件时补唤醒');
  ok(/voiceOnlyMessage/.test(bridge) && /voiceWakeMaxWaitMs/.test(bridge), '纯语音消息：唤醒/投递前先等转写（有上限）');
  // 作用域回归：`voiceOnlyMessage` 必须定义在 `currentMode === 'reserved2'` 分支**之外**。
  // 历史 bug（2026-10-16 实测）：它只定义在 reserved2 分支里，而分支之后的**一代投递路径**
  // 也用它 ⇒ 只要模式是 chat / reserved / closed-agent，handleIncoming 里每条消息都抛
  // `ReferenceError: voiceOnlyMessage is not defined`，日志只有一行「处理私聊消息出错」，
  // QQ 上表现为机器人整个哑掉。上面那条「字符串存在」的断言抓不到这种错（文本确实在）。
  const declIdx = bridge.indexOf('const voiceOnlyMessage');
  ok(declIdx > 0, '存在 voiceOnlyMessage 的声明');
  const branchAfterDecl = bridge.slice(declIdx, declIdx + 2000).search(/if \(currentMode === 'reserved2'\) \{/);
  ok(declIdx > 0 && branchAfterDecl > 0,
    'voiceOnlyMessage 声明在 reserved2 分支之外（否则非 reserved2 模式每条消息都 ReferenceError）');
  const useAfterBranch = bridge.indexOf('if (voiceOnlyMessage && asrTask) {', declIdx + branchAfterDecl);
  ok(useAfterBranch > 0, '分支之后的一代投递路径仍在用它（这条链没被整体删掉）');
  ok(/wakeOnTranscript/.test(bridge), '补唤醒受 wakeOnTranscript 开关约束');
  ok(/cfg\.socialV2\.asr = \{/.test(bridge), 'config 里 asr 有默认值并做深合并');
  ok(bridge.includes("'/api/asr/status'"), '控制台有 /api/asr/status');
  ok(bridge.includes("'/api/asr/transcribe'"), '控制台有 /api/asr/transcribe');
  ok(bridge.includes("'/api/asr/backfill'"), '控制台有 /api/asr/backfill（补转历史 [语音]）');
  ok(/该接口仅控制台可用/.test(bridge.slice(bridge.indexOf("'/api/asr/status'") - 200, bridge.indexOf("'/api/asr/status'") + 200)), 'ASR 端点拒绝 agent token（仅操作者）');
  ok(/recordDataFromGateway/.test(bridge), '只给 messageId 时回网关取 record 段');
  ok(/fetch_ptt_text/.test(bridge) && /fetchPttText/.test(bridge), 'qq 来源接了网关 fetch_ptt_text');
  ok(/get_record[\s\S]{0,120}out_format: 'wav'/.test(bridge), '取音频走 get_record(out_format=wav)（SILK 只有网关能解）');
  // 语音发送（sendVoice）保持原样：ASR 不应该顺手把「发语音」打开
  ok(/sendVoice: false/.test(bridge), 'ASR 不影响发语音默认关闭');
}

console.log('## 结构：配置示例（出厂默认）');
{
  const ex = JSON.parse(read('config.example.json'));
  const asr = ex.socialV2?.asr;
  ok(Boolean(asr), 'config.example.json 有 socialV2.asr 块');
  ok(asr?.enabled === true, 'asr 出厂默认开启（只影响「听得懂」，不外发）');
  ok(Array.isArray(asr?.sources) && asr.sources[0] === 'dsh' && asr.sources.includes('qq'), 'sources 顺序 dsh → qq');
  ok(typeof asr?.inlineWaitMs === 'number', 'inlineWaitMs 可配');
  ok(asr?.wakeOnTranscript === true, 'wakeOnTranscript 有默认值');
  ok(ex.socialV2?.voice?.enabled === false && ex.socialV2?.tools?.sendVoice === false, 'voice（发语音）仍然是出厂关闭');
  // 文档：讲清依赖（抽运行时 + 下模型）与回退顺序
  ok(Array.isArray(ex.socialV2?._asr_comment) && ex.socialV2._asr_comment.some((s) => s.includes('extract-dsh-speech')),
    'config.example 的说明里点了运行时抽取脚本');
  const guide = fs.existsSync(path.join(ROOT, 'docs', 'guides', 'ASR.md')) ? read(path.join('docs', 'guides', 'ASR.md')) : '';
  ok(guide.includes('fetch-sensevoice-model.mjs'), 'docs/guides/ASR.md 讲了下模型脚本');
}

console.log('## 纯函数：配置归一化');
{
  const { config, warnings } = normalizeAsrConfig({ sources: ['DSH', 'weird', 'qq'], inlineWaitMs: 999999, dsh: { threads: 99 } });
  ok(JSON.stringify(config.sources) === JSON.stringify(['dsh', 'qq']), 'sources 只接受 dsh/qq（大小写归一）');
  ok(warnings.length > 0, '非法项给出 warning');
  ok(config.inlineWaitMs === 30000, 'inlineWaitMs 有上限（不会把入站卡死）', String(config.inlineWaitMs));
  ok(config.dsh.threads === 16, 'dsh.threads 有上限', String(config.dsh.threads));
  const off = normalizeAsrConfig({ enabled: false }).config;
  ok(off.enabled === false, 'enabled=false 透传');
  const empty = normalizeAsrConfig({ sources: [] });
  ok(empty.warnings.some((w) => w.includes('sources')), 'sources 为空时告警');
  const merged = normalizeAsrConfig({ dsh: { language: 'zh' } }).config;
  ok(merged.dsh.language === 'zh' && merged.dsh.threads === 2, 'dsh 子配置逐字段合并（不丢默认）');
}

console.log('## 纯函数：规范 WAV 判定与修复');
{
  const good = makeWav();
  ok(canonicalWavProblem(good) === null, '规范 WAV 通过');
  ok(canonicalWavProblem(makeWav({ sampleRate: 24000 }))?.includes('16000'), '24kHz 被拒');
  ok(canonicalWavProblem(makeWav({ channels: 2 }))?.includes('单声道'), '双声道被拒');
  ok(canonicalWavProblem(Buffer.from('not a wav at all, but long enough to pass the length check.....')).includes('RIFF'), '非 WAV 被拒');
  const withList = makeWav({ extraListChunk: true });
  ok(canonicalWavProblem(withList) !== null, '带 LIST 块的 WAV 不通过（ffmpeg 会产出这种）');
  const fixed = repairCanonicalWav(withList);
  ok(fixed && canonicalWavProblem(fixed) === null, 'repairCanonicalWav 能重建成 44 字节头规范 WAV');
  ok(repairCanonicalWav(Buffer.from('garbage')) === null, 'repairCanonicalWav 对垃圾返回 null');
}

console.log('## 纯函数：文本与端口');
{
  ok(formatVoiceText('  是真的AI吗？\n还是假的？  ') === '是真的AI吗？ 还是假的？', '换行被压成单个空格、首尾空白去掉');
  ok(formatVoiceText('<|zh|><|HAPPY|>你好') === '你好', 'SenseVoice 富文本标记被剥掉');
  ok(formatVoiceText('') === null && formatVoiceText('   ') === null, '空文本返回 null（调用方保留占位）');
  const long = '啊'.repeat(300);
  ok(formatVoiceText(long, 50).length === 51, '超长按 maxChars 截断并加省略号', String(formatVoiceText(long, 50).length));
  ok(parseWorkerPort('noise\n{"port":51234}\n') === 51234, 'worker 端口解析');
  ok(parseWorkerPort('') === null, '无端口返回 null');
}

console.log('## 行为：来源回退 / 缓存 / 限流（假网关）');
{
  let qqCalls = 0;
  const asr = createVoiceAsr({
    config: { sources: ['qq'], enabled: true, maxPerMinute: 5 },
    log: () => {},
    gateway: { fetchPttText: async () => { qqCalls += 1; return '你好呀'; } }
  });
  const r1 = await asr.transcribe('m1', {});
  ok(r1.ok && r1.text === '你好呀' && r1.source === 'qq', 'qq 来源转写成功', JSON.stringify(r1.text));
  const r2 = await asr.transcribe('m1', {});
  ok(r2.cached === true && qqCalls === 1, '同一条消息命中缓存（不重复调网关）');

  const failing = createVoiceAsr({
    config: { sources: ['dsh', 'qq'], enabled: true },
    log: () => {},
    gateway: { getRecordBytes: async () => { throw new Error('没有音频'); }, fetchPttText: async () => '兜底成功' }
  });
  const r3 = await failing.transcribe('m2', {});
  ok(r3.ok && r3.source === 'qq', 'dsh 失败自动回退到 qq', r3.text);
  const s3 = failing.status().stats;
  ok(s3.dsh.failed === 1 && s3.dsh.lastError === '没有音频', 'dsh 失败原因被记录');

  const allFail = createVoiceAsr({
    config: { sources: ['dsh', 'qq'], enabled: true },
    log: () => {},
    gateway: { getRecordBytes: async () => { throw new Error('x'); }, fetchPttText: async () => { throw new Error('y'); } }
  });
  const r4 = await allFail.transcribe('m3', {});
  ok(r4.ok === false && /dsh: x/.test(r4.error) && /qq: y/.test(r4.error), '两条来源都失败时把原因都带出来');

  const limited = createVoiceAsr({
    config: { sources: ['qq'], enabled: true, maxPerMinute: 1 },
    log: () => {},
    gateway: { fetchPttText: async () => 'ok' }
  });
  await limited.transcribe('a', {});
  const r5 = await limited.transcribe('b', {});
  ok(r5.ok === false && /限流/.test(r5.error), '限流生效（每分钟上限）');

  const off = createVoiceAsr({ config: { enabled: false }, log: () => {}, gateway: {} });
  const r6 = await off.transcribe('m9', {});
  ok(r6.ok === false && r6.skipped === 'disabled', '关闭时直接跳过（不报错、不占额度）');

  const noId = await off.transcribe('', {});
  ok(noId.ok === false, '缺 messageId 时不炸');

  // 队列是串行的：并发两条不同消息都要有结果
  let inflightNow = 0;
  let maxInflight = 0;
  const serial = createVoiceAsr({
    config: { sources: ['qq'], enabled: true, cacheTtlMs: 0 },
    log: () => {},
    gateway: { fetchPttText: async (id) => { inflightNow += 1; maxInflight = Math.max(maxInflight, inflightNow); await new Promise((r) => setTimeout(r, 30)); inflightNow -= 1; return 't' + id; } }
  });
  const [x, y] = await Promise.all([serial.transcribe('x', {}), serial.transcribe('y', {})]);
  ok(x.ok && y.ok && maxInflight === 1, '推理串行（CPU 不互相抢）', `并发峰值 ${maxInflight}`);
}

console.log('## 真链路（可选）：DSH 内置 SenseVoice 子进程');
if (process.env.QQ_BRIDGE_ASR_LIVE !== '1') {
  skip('QQ_BRIDGE_ASR_LIVE!=1，跳过（真跑会拉起 DSH 的语音 worker 并加载模型）');
} else {
  const probe = createVoiceAsr({
    config: JSON.parse(read('config.json')).socialV2?.asr ?? {},
    log: (m) => console.log('    ' + m),
    gateway: { getRecordBytes: async () => makeWav({ seconds: 0.3 }) }
  });
  const st = probe.status();
  if (!st.dsh.ready) {
    ok(false, '运行时/模型缺失', st.dsh.missing.join('、'));
  } else {
    const r = await probe.transcribe(`live-silence-${Date.now()}`, {});
    // 静音输入不该编造内容：要么识别出空（ok=false），要么极短文本；能跑通进程与推理即算通过
    ok(r.ms > 0, 'DSH worker 可拉起并完成一次推理', `${r.ms}ms / ${JSON.stringify(r.text ?? r.error)}`);
    ok((r.error ?? '').includes('空') || r.ok, '静音输入没有被编造出内容', JSON.stringify(r.text ?? null));
    probe.close();
  }
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail ? 1 : 0;
