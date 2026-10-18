// Execute the real bridge initialization/functions against temporary files and fake peers.
// No production config, QQ connection, DSH process, or persistent home is accessed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as markdown from '../src/md-to-plain.js';
import * as sensitive from '../src/sensitive.js';
import * as wait from '../src/v2-wait.js';
// 长轮询等待锁：bridge.js 的等待路由用它（释放绑在 res 上，见 src/wait-lock.js）。
// VM 里必须注入同一份实现，否则等待路由一进来就 ReferenceError: createWaitLock is not defined。
import * as waitLock from '../src/wait-lock.js';
import * as safeFetch from '../src/safe-fetch.js';
import * as forward from '../src/forward.js';
import * as slang from '../src/slang-learner.js';
// 人物档案（按 QQ 号跨群共享的印象）：bridge.js 现在也依赖它，VM 里必须注入同一份实现，
// 否则 withSlangContext 会在投递 prompt 时抛 ReferenceError（buildPersonContext is not defined）。
import * as personMemory from '../src/person-memory.js';
import * as sticker from '../src/sticker-lib.js';
import * as modelPrices from '../src/model-prices.js';
import * as tokenLedger from '../src/token-ledger.js';
import * as voiceLib from '../src/send-voice-lib.js';
import * as voiceAsrLib from '../src/voice-asr.js';
import * as stateAcl from '../src/state-acl.mjs';
import * as qqToolGroups from '../src/qq-tool-groups.js';
import * as toolCatalog from '../src/tool-catalog.js';
import * as toolProtocols from '../src/tool-protocols.js';
import * as wakeRulesLib from '../src/wake-rules.js';
import * as wakePromptsLib from '../src/wake-prompts.js';
import * as upstreamEvents from '../src/upstream-events.js';
import { renderPatch as renderPresetBundlePatch } from './build-agent-preset-patches.mjs';
import * as roleCard from '../src/role-card.js';
import * as presetPromptLib from '../src/preset-prompt.js';
import * as toolPrompts from '../src/tool-prompts.js';
import { unwrap, createTurnCollector } from '../src/dsh-client.js';

const root = fileURLToPath(new URL('..', import.meta.url));
export async function bridgeHarness({ config = {}, savedState, globals = {} } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-audit-bridge-'));
  fs.mkdirSync(path.join(temp, 'src'));
  fs.mkdirSync(path.join(temp, 'state'));
  fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({
    dsh: { authToken: 'fixture-only' }, ownerQQ: 123,
    allow: { private: ['123'], groups: ['456'] }, consolePort: 0,
    consoleToken: 'fixture-console-token', slang: { enabled: false }, ...config,
  }));
  if (savedState) fs.writeFileSync(path.join(temp, 'state/sessions.json'), JSON.stringify(savedState));
  const calls = { created: [], archived: [], sent: [], prompts: [], follows: [], cancelled: [], images: [], http: [], workspaces: [], workspaceRenames: [] };
  // 语音发送在桥接里是**直接 fetch 网关**（与文本/表情共用 sendChain，但要自己带 record 段），
  // 所以这里给 VM 注入一个记录型 fetch：既不让测试真的发 QQ 消息，又能断言发出的段内容。
  const fakeFetch = async (url, init = {}) => {
    const body = (() => { try { return JSON.parse(init.body ?? '{}'); } catch { return init.body; } })();
    calls.http.push({ url: String(url), body });
    const action = String(url).split('/').pop();
    if (action === 'fetch_ptt_text') {
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { text: 'fixture-transcript' } }) };
    }
    // get_msg：语音落地校验用 —— 回一个带 record 段的消息，模拟真实网关
    if (action === 'get_msg') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'ok',
          retcode: 0,
          data: { message_id: 9001, message: [{ type: 'record', data: { file: 'fixture-record.amr', duration: 3 } }] }
        })
      };
    }
    return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9001 } }) };
  };
  const success = (value) => ({ result: { ok: true, value } });
  const api = {
    events: { follow: (id) => calls.follows.push(id) },
    workspace: {
      create: async (params) => {
        let existing = calls.workspaces.find((w) => w.path === params.path);
        const created = !existing;
        if (!existing) {
          existing = { ...params, workspaceId: `fixture-workspace-${calls.workspaces.length + 1}` };
          calls.workspaces.push(existing);
        }
        return success({ created, workspace: existing });
      },
      rename: async (params) => { calls.workspaceRenames.push(params); return success({}); },
      archiveSession: async ({ sessionId }) => { calls.archived.push(sessionId); return success({}); },
    },
    sessions: {
      create: async (params) => { calls.created.push(params); return success({ sessionId: `fixture-${calls.created.length}` }); },
      selectModel: async () => success({ selected: { provider: 'fixture', model: 'fixture' } }),
      prompt: async (params) => { calls.prompts.push(params); return success({}); },
    },
    respond: async () => success({}),
    stopSessionWork: async (sessionId) => { calls.cancelled.push(sessionId); return { removed: 0 }; },
    callUnary: async (method, params) => { calls.cancelled.push({ method, params }); return success({ accepted: true }); },
  };
  class FakeBot {
    async sendPrivateMessage(id, text) { calls.sent.push({ kind: 'private', id, text }); }
    async sendGroupMessage(id, text) { calls.sent.push({ kind: 'group', id, text }); }
    async getImage({ file }) {
      calls.images.push(file);
      // Valid 1 × 1 PNG, supplied entirely in memory by the fixture gateway.
      return { base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=' };
    }
    async request() { return { status: 'ok', retcode: 0, data: [{ emoji_id: 'fixture-sticker', url: 'https://public.invalid/sticker' }] }; }
  }
  let source = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
  // 去掉顶层 import（VM 里靠 context 注入提供这些绑定）。
  // 必须按行处理：这些 import 有**多行**写法，用单行正则（/^import[\s\S]*?;/gm）会在
  // 第一个分号处停下，把紧跟其后的正常代码一起删掉（曾把 `cfg.socialV2.voice = {…}`
  // 整段吞掉，导致语音相关断言在虚拟环境里悄悄失真）。
  source = source.split(/\r?\n/).reduce((acc, line) => {
    if (acc.droppingImport) {
      if (/;\s*$/.test(line)) acc.droppingImport = false;
      return acc;
    }
    if (/^import[\s{*]/.test(line) || /^import\s+['"]/.test(line)) {
      if (!/;\s*$/.test(line)) acc.droppingImport = true;
      return acc;
    }
    acc.out.push(line);
    return acc;
  }, { out: [], droppingImport: false }).out.join('\n');
  source = source.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path.join(temp, 'src/bridge.js')).href));
  source = source.slice(0, source.indexOf("process.on('SIGINT'"));
  source = source.replace('  bot.onPrivateMessage(async (event) => {', `
  return {
    ensureSession, ensureSlangLearnerSession, ensurePersonLearnerSession, resolvePresetName, deliverPrompt, drainPromptQueue,
    sendToQQ, sendStickerV2, handleIncoming, startConsoleServer, cfg, state, api, promptQueues,
    getSocialV2State, appendSocialV2Message, recordSentMessagesV2, wakeRules,
    buildWakePromptV2, buildWakeSnapshotV2, sendWakePromptV2, socialV2,
    flushQueue, retireSession,
    voiceCfg, voiceLibrary, resolveVoicePathForV2, resolveVoicePathForOperator,
    voiceBudgetCheck, sendVoiceV2, sendVoiceForV2, assertOutboundAuditOk,
    rotateToFreshSession, freshSessionEnabledFor,
    // 回合在途标记：fresh-session 的「上一轮还在生成就不轮换」需要能构造这种状态
    collectors, v2TurnStartAt,
    // 唤醒自愈：暂存唤醒的兜底轮询 + 「生成中」租约（测试直接调用，不等真实定时器）
    sweepPendingWakeReasonsV2, armSessionBusyLease, disarmSessionBusyLease, sessionBusyLeaseTimers,
    pendingWakeKeys, collectSessionTurnEvent, isConversationBusyV2, setupSleepTimerV2,
    finalizeWakeTurnV2, wakeConfigUpdatedKeys, markReadCalledKeys, noteModelMessagesV2,
    runPersonExtraction, feedPersonWindow, personWindows, learnerWaiters,
    queuePersonTask, queueSlangTask, invalidatePersonLearnerSession, invalidateSlangLearnerSession,
    learnerSessions, learnerSessionKeys,
    setMode(value) { currentMode = value; },
    setReady(value) { dshReady = value; },
    setPresets(value) { dshPresetIds = value; dshDefaultPreset = 'standard'; },
    resetEpoch() { sessionEpoch++; },
  };
  bot.onPrivateMessage(async (event) => {`);
  const timers = new Set();
  const context = vm.createContext({
    fs, path, http, crypto, fileURLToPath, URL, Buffer, AbortSignal, console: { log() {}, error() {} },
    fetch: fakeFetch,
    // 锁文件探测用（bridge.js 顶层的 consolePortInUse）；
    // 固定桩掉：测试不应该真去 netstat 宿主机。
    execFileSync: () => '',
    // process 桩要带 env：voice-core / bridge 会读 process.env.FFMPEG_PATH、FFPROBE_PATH 等。
    // 之前只给 pid/platform/kill/exit，导致 `process.env.FFMPEG_PATH` 直接抛 TypeError。
    process: { pid: process.pid, platform: process.platform, kill: process.kill, env: {}, exit: (code) => { throw new Error('unexpected exit ' + code); } },
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; },
    clearTimeout, setInterval: () => ({ unref() {} }), clearInterval: () => {},
    NodeApiClient: class { constructor() { return api; } },
    SnowLumaWebSocketClient: FakeBot, text: (s) => s,
    discoverDshLaunchToken: () => '', unwrap, createTurnCollector,
    ...markdown, ...sensitive, ...wait, ...safeFetch, ...forward, ...slang, ...personMemory, ...sticker,
    ...modelPrices, ...tokenLedger, ...voiceLib, ...stateAcl, ...waitLock, ...qqToolGroups, ...toolPrompts, ...toolCatalog, ...toolProtocols, ...wakeRulesLib, ...wakePromptsLib, ...upstreamEvents, ...roleCard, ...presetPromptLib, renderPresetBundlePatch,
    readToolPrompts: toolPrompts.readPrompts, writeToolPrompt: toolPrompts.writePrompt,
    ensureToolPrompts: toolPrompts.ensureDefaults, actionEnabledPure: qqToolGroups.actionEnabled,
    // 入站语音识别（ASR）：纯函数照实给（配置归一化/规范 WAV 判定），但 createVoiceAsr 默认**桩掉** ——
    // 真实现会 spawn DSH 的 SenseVoice worker 并加载 240MB 模型，审计环境不该做这件事，
    // 也不该依赖"本机抽没抽运行时"。桩只保留最小契约（conf/transcribe/warmup/status/close），
    // 转写走 gateway.fetchPttText（VM 里就是那个记录型 fakeFetch），
    // 于是含 record 段的入站消息在虚拟环境里也能被断言成 [语音: fixture-transcript]。
    // 要断言真实行为的测试用 globals.createVoiceAsr 覆盖。
    ...voiceAsrLib,
    createVoiceAsr: ({ config = {}, log = () => {}, gateway = {} } = {}) => {
      const conf = {
        enabled: config.enabled !== false,
        sources: Array.isArray(config.sources) && config.sources.length ? config.sources : ['qq'],
        inlineWaitMs: Number.isFinite(Number(config.inlineWaitMs)) ? Number(config.inlineWaitMs) : 0,
        maxChars: Number(config.maxChars) || 200,
        wakeOnTranscript: config.wakeOnTranscript !== false,
        ...config
      };
      const results = new Map();
      return {
        conf,
        async transcribe(messageId, record = {}) {
          if (!conf.enabled) return { ok: false, skipped: 'disabled', error: '语音识别已关闭' };
          if (!messageId) return { ok: false, skipped: 'no-id', error: '缺少 messageId' };
          const id = String(messageId);
          if (results.has(id)) return { ...results.get(id), cached: true };
          let out;
          try {
            const text = String((await gateway.fetchPttText?.(id)) ?? '').trim();
            out = text ? { ok: true, text, source: 'qq', ms: 1, at: Date.now() } : { ok: false, error: 'qq: 识别结果为空' };
          } catch (error) {
            out = { ok: false, error: `qq: ${error?.message ?? error}` };
          }
          results.set(id, out);
          return out;
        },
        async warmup() { return { ok: false, error: 'stub' }; },
        status() {
          return {
            enabled: conf.enabled, sources: conf.sources, inlineWaitMs: conf.inlineWaitMs,
            wakeOnTranscript: conf.wakeOnTranscript,
            stats: {
              calls: results.size, ok: 0, failed: 0, cached: 0, rateLimited: 0,
              dsh: { ok: 0, failed: 0, lastError: null }, qq: { ok: 0, failed: 0, lastError: null },
              lastText: null, lastAt: 0, cacheSize: results.size, inflight: 0
            },
            dsh: { enabled: false, workerRunning: false, port: null, ready: false, missing: ['(stub)'], workerPath: '(stub)', nodePath: '(stub)', ffmpeg: '(stub)' }
          };
        },
        close() {}
      };
    },
    // ACL 收紧会 spawn icacls 去改**真实**文件系统；测试不该做这件事（同理见下面的
    // cleanupTemp / processAudioVolume 桩）。桩成成功，让 hardenStateDirAcl 走正常分支。
    hardenDir: () => ({ ok: true, detail: 'stub' }),
    // 音量靠 ffmpeg；测试环境不该真跑 ffmpeg（也不该在沙箱里 spawn）。
    // 默认桩成"按倍数记账但不转码"，调用方可用 globals 覆盖来断言真实行为。
    processAudioVolume: async (file, { volume = 1, normalize = false, loudness = 'normal' } = {}) => {
      const v = Number(volume);
      const changed = normalize === true || Math.abs(v - 1) > 1e-9;
      return {
        path: changed ? `${file}.vol` : file,
        converted: changed,
        applied: changed,
        volume: normalize ? 1 : v,
        loudness: normalize ? -16 : null,
        mode: normalize ? 'loudnorm' : (changed ? 'volume' : 'original'),
        detail: normalize ? `智能音量（响度归一 ${loudness === 'loud' ? -13 : loudness === 'quiet' ? -20 : -16} LUFS）`
          : (changed ? `音量 ${Math.round(v * 100)}%` : '原始音量')
      };
    },
    cleanupTemp: () => {},
    ...globals,
  });
  // Execute the pure model view in the bridge realm. Its plain-object checks
  // should see the same prototypes as real bridge messages, just as in Node.
  const modelViewSource = fs.readFileSync(path.join(root, 'src/qq-model-view.js'), 'utf8').replace(/^export /gm, '');
  vm.runInContext(`Object.assign(globalThis, (() => { ${modelViewSource}\nreturn { compactModelMessage, compactModelData, serializeModelData }; })());`, context);
  vm.runInContext(source + '\nglobalThis.auditReady = main();', context);
  const bridge = await context.auditReady;
  bridge.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
  bridge.setReady(true);
  return { ...bridge, calls, temp, async close() {
    for (const timer of timers) clearTimeout(timer);
    fs.rmSync(temp, { recursive: true, force: true });
  } };
}
