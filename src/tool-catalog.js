// SnowLuma 官方目录的本地适配层：参数表、类型校验、会话目标补齐共用一份快照。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const cache = new Map();
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
const validators = new WeakMap();
const WRITE_ACTIONS = new Set(['send_ark_share', 'send_group_ark_share', 'share_peer', 'share_group_ex']);

export function actionCatalog(root = ROOT) {
  const local = path.join(root, '_snowluma-catalog.json');
  const file = fs.existsSync(local) ? local : path.join(ROOT, '_snowluma-catalog.json');
  const stamp = fs.statSync(file).mtimeMs;
  if (cache.get(file)?.stamp === stamp) return cache.get(file).actions;
  const actions = new Map(JSON.parse(fs.readFileSync(file, 'utf8')).map((a) => [a.name, a]));
  cache.set(file, { stamp, actions });
  return actions;
}

export function actionReadOnly(action, root = ROOT) {
  return actionCatalog(root).get(action)?.readOnly === true && !WRITE_ACTIONS.has(action);
}

export function prepareActionParams(action, key, raw, root = ROOT) {
  const fail = (error) => ({ ok: false, status: 400, error });
  const match = /^(group|private):(\d+)$/.exec(String(key ?? ''));
  if (!match) return fail('key 格式应为 group:群号 或 private:QQ号');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('params 必须是 JSON 对象');
  const meta = actionCatalog(root).get(action);
  if (!meta) return fail(`目录中没有动作：${action}`);
  if (!meta.inputSchema) return fail(`动作 ${action} 缺少参数 schema，请更新动作目录`);
  const params = { ...raw };
  // 只补官方参数表声明的目标字段，不往所有 API 盲塞 group_id/user_id。
  if (meta.params.includes('group_id') && match[1] === 'group' && params.group_id === undefined) params.group_id = match[2];
  if (meta.params.includes('user_id') && match[1] === 'private' && params.user_id === undefined) params.user_id = match[2];
  for (const parameter of meta.parameters ?? []) {
    const value = params[parameter.name];
    const type = parameter.schema?.type;
    // QQ 工具的 ID 采用字符串；网关 uint 参数要求 JSON 整数。只转换无损的十进制整数。
    if (type === 'integer' && typeof value === 'string' && /^-?\d+$/.test(value)) {
      const number = Number(value);
      if (Number.isSafeInteger(number)) params[parameter.name] = number;
    }
  }
  let validate = validators.get(meta);
  if (!validate) { validate = ajv.compile(meta.inputSchema); validators.set(meta, validate); }
  if (!validate(params)) {
    const detail = validate.errors.slice(0, 4).map((e) => `${e.instancePath || '/'} ${e.message}${e.params?.missingProperty ? ` (${e.params.missingProperty})` : ''}`).join('；');
    return fail(`${action} 参数无效：${detail}`);
  }
  return { ok: true, params };
}
