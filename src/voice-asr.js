// 入站语音识别（ASR）：把「收到的」QQ 语音条转成文字，写进消息文本给 AI 看。
//
// 两条来源，按 socialV2.asr.sources 的顺序回退：
//   1) dsh —— **DSH 内置的语音输入插件**（@deepseek-ai/dsh-experimental-speech-to-text-sensevoice）：
//      该插件把推理放在独立子进程 lib/worker.js 里（argv[2]=配置 JSON、env DSH_SPEECH_TOKEN、
//      stdout 输出 {"port":N}、POST /transcribe 收 16kHz 单声道 PCM16 WAV）。这里就是把这个
//      worker 拉起来复用，模型也用 DSH 自己的缓存目录（%USERPROFILE%\.dsh\speech-to-text\sensevoice）。
//      本地 CPU 推理、不联网、不看 QQ 脸色，是主路径。
//   2) qq —— 网关动作 fetch_ptt_text：走 QQ 服务端的转写结果。快（~250ms）但**只有别人发来、
//      且 QQ 自己转写出来的语音**才有；历史消息里翻出来的旧语音往往等 20s 后返回
//      retcode=100「语音转文字超时（未收到结果推送）」。作为兜底。
//
// 两条都拿不到时保留 [语音] 占位 —— 宁可承认听不见，也不编造内容。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const MB = 1024 * 1024;

export const ASR_DEFAULTS = Object.freeze({
  enabled: true,
  // 顺序即回退顺序；'dsh' = DSH 内置 SenseVoice 子进程，'qq' = 网关 fetch_ptt_text
  sources: ['dsh', 'qq'],
  // 入站时最多同步等多久：等到了就写进这条消息（AI 一次就能看到），没等到就先进 [语音]，
  // 后台跑完再补写（见补写回调）。DSH 本地推理常见 0.5~3s，首次要加载模型（数秒）。
  inlineWaitMs: 1500,
  maxChars: 200,
  cacheTtlMs: 30 * 60 * 1000,
  maxPerMinute: 30,
  // 转写文本回来后，如果这条消息因此命中唤醒条件，补一次唤醒（语音里喊名字也能唤醒）
  wakeOnTranscript: true,
  // 「纯语音消息」的唤醒最多等转写多久：等到了就让 AI 一睁眼就看到文字，
  // 而不是看到 [语音] 只能回一句"听不见"。超时（worker 冷启动异常等）就按占位照常唤醒。
  voiceWakeMaxWaitMs: 15000,
  maxBytes: 4 * MB,
  maxSeconds: 120,
  ffmpegPath: '',
  dsh: {
    enabled: true,
    // DSH 自带的 Node（版本与安装包一致，最稳）；留空则用本进程的 node
    nodePath: '',
    // 从 DSH 安装包里抽出来的 worker 运行时（scripts/extract-dsh-speech.mjs 生成）
    runtimeDir: '',
    // 模型目录；留空 = <DSH_HOME>/speech-to-text/sensevoice/models/sensevoice-onnx
    modelDir: '',
    threads: 2,
    language: 'auto',
    // 单次推理超时 + 空闲多久释放 worker（释放后模型留在磁盘缓存，下次唤醒只重新加载）
    timeoutMs: 120000,
    startupTimeoutMs: 180000,
    idleTimeoutMs: 300000
  }
});

const num = (v, dflt, { min = -Infinity, max = Infinity } = {}) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
};
const str = (v, dflt = '') => (typeof v === 'string' ? v : dflt);

/** 归一化配置（含旧/缺字段兜底与范围校正）。返回 { config, warnings } —— 不抛错，桥接启动不该被配置问题打断。 */
export function normalizeAsrConfig(raw = {}) {
  const warnings = [];
  const src = raw && typeof raw === 'object' ? raw : {};
  const dshRaw = src.dsh && typeof src.dsh === 'object' ? src.dsh : {};
  const sources = Array.isArray(src.sources)
    ? src.sources.map((s) => String(s).toLowerCase().trim()).filter((s) => s === 'dsh' || s === 'qq')
    : [...ASR_DEFAULTS.sources];
  if (Array.isArray(src.sources) && sources.length !== src.sources.length) {
    warnings.push('sources 里只有 "dsh" / "qq" 有效，其余已忽略');
  }
  const enabled = src.enabled !== false;
  if (enabled && sources.length === 0) {
    warnings.push('sources 为空，语音识别不会工作（要关就设 enabled=false）');
  }
  const config = {
    enabled,
    sources: sources.length ? [...new Set(sources)] : [],
    inlineWaitMs: num(src.inlineWaitMs, ASR_DEFAULTS.inlineWaitMs, { min: 0, max: 30000 }),
    maxChars: num(src.maxChars, ASR_DEFAULTS.maxChars, { min: 20, max: 1000 }),
    cacheTtlMs: num(src.cacheTtlMs, ASR_DEFAULTS.cacheTtlMs, { min: 0, max: 24 * 3600 * 1000 }),
    maxPerMinute: num(src.maxPerMinute, ASR_DEFAULTS.maxPerMinute, { min: 1, max: 300 }),
    wakeOnTranscript: src.wakeOnTranscript !== false,
    voiceWakeMaxWaitMs: num(src.voiceWakeMaxWaitMs, ASR_DEFAULTS.voiceWakeMaxWaitMs, { min: 0, max: 120000 }),
    maxBytes: num(src.maxBytes, ASR_DEFAULTS.maxBytes, { min: 46, max: 200 * MB }),
    maxSeconds: num(src.maxSeconds, ASR_DEFAULTS.maxSeconds, { min: 1, max: 3600 }),
    ffmpegPath: str(src.ffmpegPath),
    dsh: {
      enabled: dshRaw.enabled !== false,
      nodePath: str(dshRaw.nodePath),
      runtimeDir: str(dshRaw.runtimeDir),
      modelDir: str(dshRaw.modelDir),
      threads: num(dshRaw.threads, ASR_DEFAULTS.dsh.threads, { min: 1, max: 16 }),
      language: str(dshRaw.language, ASR_DEFAULTS.dsh.language) || 'auto',
      timeoutMs: num(dshRaw.timeoutMs, ASR_DEFAULTS.dsh.timeoutMs, { min: 1000, max: 3600 * 1000 }),
      startupTimeoutMs: num(dshRaw.startupTimeoutMs, ASR_DEFAULTS.dsh.startupTimeoutMs, { min: 1000, max: 3600 * 1000 }),
      idleTimeoutMs: num(dshRaw.idleTimeoutMs, ASR_DEFAULTS.dsh.idleTimeoutMs, { min: 0, max: 24 * 3600 * 1000 })
    }
  };
  return { config, warnings };
}

/**
 * 复刻 DSH 的 validateWave 规则（speech-to-text/lib/types/wave.js）做**本地预检**：
 * 不符合规范的音频根本不用发给 worker（省一次进程往返，也避免把 ffmpeg 的怪输出当正常输入）。
 * 返回 null 表示合规，否则返回人类可读的原因。
 */
export function canonicalWavProblem(buf) {
  if (!Buffer.isBuffer(buf) && !(buf instanceof Uint8Array)) return '不是字节缓冲';
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (data.length < 46) return `太短（${data.length} 字节）`;
  if (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') return '缺少 RIFF/WAVE 头';
  if (data.toString('ascii', 12, 16) !== 'fmt ' || data.readUInt32LE(16) !== 16) return 'fmt 块不是规范 16 字节';
  if (data.readUInt16LE(20) !== 1) return '不是 PCM';
  if (data.readUInt16LE(22) !== 1) return `不是单声道（channels=${data.readUInt16LE(22)}）`;
  const rate = data.readUInt32LE(24);
  if (rate !== 16000) return `采样率不是 16000（${rate}）`;
  if (data.readUInt32LE(28) !== 32000 || data.readUInt16LE(32) !== 2 || data.readUInt16LE(34) !== 16) return '不是 16bit/32KBps';
  if (data.toString('ascii', 36, 40) !== 'data') return '第 37 字节起不是 data 块（可能有 LIST 等额外块）';
  if (data.length - 44 !== data.readUInt32LE(40)) return 'data 长度与文件长度不一致';
  if ((data.length - 44) % 2 !== 0) return 'PCM 字节数不是偶数';
  return null;
}

/** 把 WAV 里可能存在的额外块（LIST/INFO…）剥掉，重建成严格 44 字节头的规范 WAV；修不了返回 null。 */
export function repairCanonicalWav(buf) {
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (data.length < 12 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') return null;
  let off = 12;
  let fmt = null;
  let pcm = null;
  while (off + 8 <= data.length) {
    const id = data.toString('ascii', off, off + 4);
    const size = data.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') fmt = { channels: data.readUInt16LE(body + 2), rate: data.readUInt32LE(body + 4), bits: data.readUInt16LE(body + 14) };
    if (id === 'data') { pcm = data.subarray(body, Math.min(body + size, data.length)); break; }
    off = body + size + (size % 2);
  }
  if (!fmt || !pcm) return null;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(fmt.channels, 22);
  header.writeUInt32LE(fmt.rate, 24);
  header.writeUInt32LE((fmt.rate * fmt.channels * fmt.bits) / 8, 28);
  header.writeUInt16LE((fmt.channels * fmt.bits) / 8, 32);
  header.writeUInt16LE(fmt.bits, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** 转写文本 → 消息里的展示形式。空文本返回 null（调用方保留 [语音]）。 */
export function formatVoiceText(text, maxChars = ASR_DEFAULTS.maxChars) {
  const clean = String(text ?? '')
    .replace(/<\|[^|]*\|>/g, '')      // SenseVoice 富文本标记（笑声/情绪等）
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!clean) return null;
  return clean.length > maxChars ? `${clean.slice(0, maxChars)}…` : clean;
}

/** 从 worker stdout 里抓 {"port":N}。 */
export function parseWorkerPort(text) {
  const m = String(text ?? '').match(/\{"port":(\d+)\}/);
  return m ? Number(m[1]) : null;
}

/**
 * 语音识别器。对外只有 transcribe / warmup / status 三件事。
 * @param config 已归一化的 socialV2.asr
 * @param log 日志函数
 * @param gateway { fetchPttText(messageId): Promise<string>, getRecordBytes(recordData): Promise<Buffer> }
 *        —— 与网关/SnowLuma 相关的取数动作由桥接注入，本模块不直接碰 HTTP，便于单测。
 */
export function createVoiceAsr({ config, log = () => {}, gateway = {} }) {
  const conf = normalizeAsrConfig(config).config;
  const tmpRoot = path.join(os.tmpdir(), 'qq-bridge-asr');
  const stats = {
    calls: 0, ok: 0, failed: 0, cached: 0, rateLimited: 0,
    dsh: { ok: 0, failed: 0, lastError: null, startedAt: 0, modelDir: null, port: null },
    qq: { ok: 0, failed: 0, lastError: null },
    lastText: null, lastAt: 0
  };
  /** messageId -> { at, text, source, error } —— 成功和失败都缓存，避免对同一条反复烧 CPU/时间 */
  const cache = new Map();
  const inflight = new Map();
  const stamps = [];
  let queue = Promise.resolve();

  const dshHome = () => process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const modelDir = () => conf.dsh.modelDir || path.join(dshHome(), 'speech-to-text', 'sensevoice', 'models', 'sensevoice-onnx');
  const runtimeDir = () => conf.dsh.runtimeDir || path.join(process.cwd(), 'speech-asr', 'runtime');
  const workerPath = () => path.join(runtimeDir(), 'node_modules', '@deepseek-ai', 'dsh-experimental-speech-to-text-sensevoice', 'lib', 'worker.js');
  const nodePath = () => conf.dsh.nodePath || process.execPath;
  const ffmpegPath = () => conf.ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg';

  const dshReady = () => {
    const dir = modelDir();
    const need = ['model.int8.onnx', 'tokens.txt', 'silero_vad.onnx'];
    const missing = need.filter((f) => !fs.existsSync(path.join(dir, f)));
    const worker = fs.existsSync(workerPath());
    return { ok: missing.length === 0 && worker && fs.existsSync(nodePath()), dir, missing, worker, node: nodePath() };
  };

  // ── DSH 子进程（常驻，空闲释放；模型留在磁盘，唤醒只需重新加载） ──────────────
  let worker = null; // { child, port, token, readyAt, lastUsedAt, idleTimer }
  let starting = null;

  function killWorker(reason = '') {
    if (!worker) return;
    const { child, idleTimer } = worker;
    worker = null;
    if (idleTimer) clearTimeout(idleTimer);
    try { child.kill(); } catch {}
    if (reason) log(`[asr] DSH 语音 worker 已释放（${reason}）`);
  }

  function armIdleTimer() {
    if (!worker) return;
    if (worker.idleTimer) clearTimeout(worker.idleTimer);
    if (!conf.dsh.idleTimeoutMs) return;
    worker.idleTimer = setTimeout(() => killWorker('空闲超时'), conf.dsh.idleTimeoutMs);
    if (typeof worker.idleTimer.unref === 'function') worker.idleTimer.unref();
  }

  function startWorker() {
    if (worker) return Promise.resolve(worker);
    if (starting) return starting;
    const readiness = dshReady();
    if (!readiness.ok) {
      const why = !readiness.worker
        ? `缺少 worker 运行时（先跑 extract-dsh-speech.mjs）：${workerPath()}`
        : `模型文件缺失：${readiness.missing.join('、')}（目录 ${readiness.dir}，先跑 fetch-sensevoice-model.mjs）`;
      stats.dsh.lastError = why;
      return Promise.reject(new Error(why));
    }
    const token = crypto.randomBytes(32).toString('hex');
    const workerConfig = JSON.stringify({
      providerId: 'sensevoice-local',
      dataRoot: path.dirname(readiness.dir),
      threads: conf.dsh.threads,
      model: path.join(readiness.dir, 'model.int8.onnx'),
      tokens: path.join(readiness.dir, 'tokens.txt'),
      vad: path.join(readiness.dir, 'silero_vad.onnx'),
      maxAudioBytes: Math.max(46, Math.floor(conf.maxBytes))
    });
    starting = new Promise((resolve, reject) => {
      let settled = false;
      let stdout = '';
      let stderr = '';
      const t0 = Date.now();
      let child;
      try {
        child = spawn(nodePath(), [workerPath(), workerConfig], {
          env: { ...process.env, DSH_SPEECH_TOKEN: token },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        });
      } catch (error) {
        starting = null;
        reject(error);
        return;
      }
      const fail = (error) => {
        if (settled) return;
        settled = true;
        starting = null;
        stats.dsh.lastError = error?.message ?? String(error);
        try { child.kill(); } catch {}
        reject(error);
      };
      const check = () => {
        if (settled) return;
        const port = parseWorkerPort(stdout);
        if (port == null) return;
        settled = true;
        starting = null;
        worker = { child, port, token, readyAt: Date.now(), lastUsedAt: Date.now(), idleTimer: null };
        stats.dsh.startedAt = Date.now();
        stats.dsh.port = port;
        stats.dsh.modelDir = readiness.dir;
        stats.dsh.lastError = null;
        armIdleTimer();
        log(`[asr] DSH 内置语音插件 worker 就绪：port=${port}，模型加载 ${((Date.now() - t0) / 1000).toFixed(1)}s（${path.basename(readiness.dir)}）`);
        resolve(worker);
      };
      const timer = setInterval(check, 100);
      if (typeof timer.unref === 'function') timer.unref();
      const deadline = setTimeout(() => fail(new Error(`worker 启动超时（${conf.dsh.startupTimeoutMs}ms）`)), conf.dsh.startupTimeoutMs);
      if (typeof deadline.unref === 'function') deadline.unref();
      child.stdout.on('data', (d) => { stdout += d.toString(); check(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 8000) stderr = stderr.slice(-8000); });
      child.on('error', (error) => fail(error));
      child.on('exit', (code) => {
        clearInterval(timer); clearTimeout(deadline);
        if (!settled) { fail(new Error(`worker 退出（code=${code}）${stderr ? '：' + stderr.trim().split('\n').slice(-3).join(' | ') : ''}`)); return; }
        // 已就绪后又退出：清状态，下次请求会重新拉起
        if (worker && worker.child === child) {
          worker = null;
          stats.dsh.port = null;
          log(`[asr] DSH 语音 worker 退出（code=${code}），下次识别会重新拉起`);
        }
      });
    });
    return starting;
  }

  function withTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
      promise.finally(() => clearTimeout(timer)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms); if (typeof timer.unref === 'function') timer.unref(); })
    ]);
  }

  // ── ffmpeg：任意音频 → 16kHz 单声道 PCM16 WAV ─────────────────────────────
  async function toCanonicalWav(inputBytes) {
    fs.mkdirSync(tmpRoot, { recursive: true });
    const stamp = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const inPath = path.join(tmpRoot, `in-${stamp}.bin`);
    const outPath = path.join(tmpRoot, `out-${stamp}.wav`);
    fs.writeFileSync(inPath, inputBytes);
    try {
      const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', inPath,
        '-map_metadata', '-1', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', outPath];
      const code = await new Promise((resolve, reject) => {
        const child = spawn(ffmpegPath(), args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
        let err = '';
        child.stderr.on('data', (d) => { err += d.toString(); });
        child.on('error', (error) => reject(new Error(error.code === 'ENOENT' ? `找不到 ffmpeg（${ffmpegPath()}）：设 socialV2.asr.ffmpegPath 或 FFMPEG_PATH` : error.message)));
        child.on('close', (c) => resolve(c === 0 ? 0 : new Error(`ffmpeg 退出 code=${c}：${err.trim().slice(-300)}`)));
        // 转码不该超过 30s
        const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(new Error('ffmpeg 超时（30000ms）')); }, 30000);
        if (typeof timer.unref === 'function') timer.unref();
      });
      if (code instanceof Error) throw code;
      let wav = fs.readFileSync(outPath);
      let problem = canonicalWavProblem(wav);
      if (problem) {
        const repaired = repairCanonicalWav(wav);
        if (repaired && !canonicalWavProblem(repaired)) { wav = repaired; problem = null; }
      }
      if (problem) throw new Error(`ffmpeg 输出不是规范 16k 单声道 PCM16 WAV：${problem}`);
      if (wav.length > conf.maxBytes) throw new Error(`语音太长/太大（${(wav.length / MB).toFixed(1)}MB > ${(conf.maxBytes / MB).toFixed(1)}MB）`);
      return wav;
    } finally {
      try { fs.rmSync(inPath, { force: true }); } catch {}
      try { fs.rmSync(outPath, { force: true }); } catch {}
    }
  }

  // ── 两条来源 ─────────────────────────────────────────────────────────────
  async function transcribeViaDsh(recordBytes) {
    const wav = await toCanonicalWav(recordBytes);
    const w = await startWorker();
    w.lastUsedAt = Date.now();
    armIdleTimer();
    const res = await fetch(`http://127.0.0.1:${w.port}/transcribe?language=${encodeURIComponent(conf.dsh.language)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${w.token}`, 'content-type': 'application/octet-stream' },
      body: wav,
      signal: AbortSignal.timeout(conf.dsh.timeoutMs)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error || `worker HTTP ${res.status}`);
    return { text: String(body?.text ?? ''), extra: { audioSeconds: body?.audioSeconds, inferenceSeconds: body?.inferenceSeconds } };
  }

  async function transcribeViaQq(messageId) {
    if (typeof gateway.fetchPttText !== 'function') throw new Error('未接入网关 fetch_ptt_text');
    const text = await gateway.fetchPttText(String(messageId));
    return { text: String(text ?? '') };
  }

  // ── 对外 ─────────────────────────────────────────────────────────────────
  function rateLimited() {
    const now = Date.now();
    while (stamps.length && now - stamps[0] > 60000) stamps.shift();
    return stamps.length >= conf.maxPerMinute;
  }

  async function runSources(messageId, recordData) {
    const problems = [];
    for (const source of conf.sources) {
      if (source === 'dsh' && !conf.dsh.enabled) continue;
      try {
        let out = null;
        if (source === 'dsh') {
          if (typeof gateway.getRecordBytes !== 'function') { problems.push('dsh: 未接入网关取音频'); continue; }
          const bytes = await gateway.getRecordBytes(recordData ?? {});
          if (!bytes || !bytes.length) throw new Error('没取到音频字节');
          out = await transcribeViaDsh(bytes);
        } else if (source === 'qq') {
          out = await transcribeViaQq(messageId);
        }
        const text = formatVoiceText(out?.text, conf.maxChars);
        if (text) return { ok: true, text, source, extra: out?.extra ?? null };
        problems.push(`${source}: 识别结果为空`);
        if (source === 'dsh') stats.dsh.failed += 1; else stats.qq.failed += 1;
      } catch (error) {
        const message = error?.message ?? String(error);
        problems.push(`${source}: ${message}`);
        if (source === 'dsh') stats.dsh.lastError = message; else stats.qq.lastError = message;
        if (source === 'dsh') stats.dsh.failed += 1; else stats.qq.failed += 1;
      }
    }
    return { ok: false, error: problems.join('；') || '没有可用的识别来源' };
  }

  function remember(messageId, value) {
    if (conf.cacheTtlMs > 0) {
      cache.set(String(messageId), { at: Date.now(), ...value });
      if (cache.size > 500) {
        const cutoff = Date.now() - conf.cacheTtlMs;
        for (const [k, v] of cache) if (v.at < cutoff) cache.delete(k);
      }
    }
    return value;
  }

  /**
   * 转写一条语音消息。按 messageId 去重 + 缓存；同一时刻只跑一个任务（CPU 推理别互相抢）。
   * 永远 resolve（不 reject）：失败信息放在返回值里，调用方决定怎么兜底。
   */
  function transcribe(messageId, recordData = {}) {
    const id = String(messageId ?? '').trim();
    if (!conf.enabled || conf.sources.length === 0) return Promise.resolve({ ok: false, skipped: 'disabled', error: '语音识别已关闭' });
    if (!id) return Promise.resolve({ ok: false, skipped: 'no-id', error: '缺少 messageId' });
    const cached = cache.get(id);
    if (cached && Date.now() - cached.at < conf.cacheTtlMs) {
      stats.cached += 1;
      return Promise.resolve({ ...cached, cached: true });
    }
    const running = inflight.get(id);
    if (running) return running;
    if (rateLimited()) {
      stats.rateLimited += 1;
      return Promise.resolve({ ok: false, error: `语音识别限流（每分钟 ${conf.maxPerMinute} 条）` });
    }
    stats.calls += 1;
    stamps.push(Date.now());
    const task = queue.then(async () => {
      const t0 = Date.now();
      const result = await runSources(id, recordData);
      const out = { ...result, ms: Date.now() - t0, at: Date.now() };
      if (out.ok) {
        stats.ok += 1;
        if (out.source === 'dsh') stats.dsh.ok += 1; else stats.qq.ok += 1;
        stats.lastText = out.text;
        stats.lastAt = Date.now();
        log(`[asr] 语音转写成功（${out.source}，${out.ms}ms）：${out.text.slice(0, 60)}${out.text.length > 60 ? '…' : ''}`);
      } else {
        stats.failed += 1;
        log(`[asr] 语音转写失败（${out.ms}ms）：${out.error}`);
      }
      return remember(id, out);
    });
    // 队列尾部：无论成败都不让链条断掉
    queue = task.then(() => {}, () => {});
    const tracked = task.finally(() => { if (inflight.get(id) === tracked) inflight.delete(id); });
    inflight.set(id, tracked);
    return tracked;
  }

  /** 预启动 worker（可选）：让第一条语音少等几秒。失败只记日志。 */
  async function warmup() {
    if (!conf.enabled || !conf.sources.includes('dsh') || !conf.dsh.enabled) return { ok: false, error: '未启用 dsh 来源' };
    try {
      const w = await startWorker();
      return { ok: true, port: w.port, ms: Date.now() - w.readyAt };
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  }

  function status() {
    const ready = dshReady();
    return {
      enabled: conf.enabled,
      sources: conf.sources,
      inlineWaitMs: conf.inlineWaitMs,
      wakeOnTranscript: conf.wakeOnTranscript,
      stats: { ...stats, cacheSize: cache.size, inflight: inflight.size },
      dsh: {
        enabled: conf.dsh.enabled,
        workerRunning: Boolean(worker),
        port: worker?.port ?? null,
        ready: ready.ok,
        modelDir: ready.dir,
        missing: ready.missing,
        workerPath: workerPath(),
        nodePath: nodePath(),
        ffmpeg: ffmpegPath()
      }
    };
  }

  return { conf, transcribe, warmup, status, close: () => killWorker('进程退出'), _startWorker: startWorker };
}
