// 工具套件注册与参数入口。管理页直接复用此处 schema，避免展示与调用漂移。
import { z } from 'zod';
import { toolsToRegister, TOOL_PARAMS, toolByName, resolveToolAction, actionParamsFrom, actionEnabled } from './qq-tool-groups.js';

export function suiteToolSchema(tool) {
  const schema = {
    key: z.string().regex(/^(group|private):\d+$/).describe('当前会话，group:群号 或 private:QQ号'),
    token: z.string().min(1).describe('唤醒提示中的会话令牌'),
  };
  if (tool.kind === 'channel') {
    schema.action = z.enum(tool.actions).describe('本组已启用的 SnowLuma action');
    schema.params = z.record(z.string(), z.unknown()).optional().describe('该 action 的原生参数；群号由 key 自动补齐');
    return schema;
  }
  const definition = toolByName(tool.name);
  schema.params = z.record(z.string(), z.unknown()).optional().describe('可选：SnowLuma 原生参数，用于缓存、分页等额外选项；同名参数以外层参数为准');
  if (definition?.actions.length > 1) schema.action = z.enum(tool.actions).optional().describe('可显式选择动作；省略时按兼容参数自动选择');
  for (const [name, spec] of Object.entries(TOOL_PARAMS[tool.name] ?? {})) {
    const base = spec.replace('?', '');
    let field = base === 'number' ? z.number() : base === 'boolean' ? z.boolean() : z.string();
    if (spec.endsWith('?')) field = field.optional();
    schema[name] = field;
  }
  return schema;
}

export function suiteInputSchema(tool) {
  const { $schema, ...schema } = z.toJSONSchema(z.object(suiteToolSchema(tool)));
  return schema;
}

export function suiteCall(tool, args, cfg) {
  let action = tool.kind === 'channel' ? args.action : resolveToolAction(tool.name, args);
  // 单一动作启用时，未指定选择参数的调用自然落到这个动作，而不是已关闭的默认动作。
  const selectsVariant = ['action', 'detail', 'folderId', 'grouped', 'groupId', 'userId', 'voice', 'kind']
    .some((key) => args[key] !== undefined);
  if (tool.kind !== 'channel' && !selectsVariant && tool.actions.length === 1) action = tool.actions[0];
  if (!action || !tool.actions.includes(action)) throw new Error(`所选动作未在此工具启用；可用：${tool.actions.join('、')}`);
  if (!actionEnabled(cfg, action)) throw new Error(`动作已关闭：${action}；请检查所属组与动作开关`);
  return { key: args.key, action, params: tool.kind === 'channel' ? (args.params ?? {}) : { ...(args.params ?? {}), ...actionParamsFrom(args) } };
}

export function registerToolSuites(server, { getConfig, agentApi, serializeModelData }) {
  const tools = toolsToRegister(getConfig());
  for (const tool of tools) {
    server.tool(tool.name, tool.description, suiteToolSchema(tool), async (args) => {
      try {
        const body = suiteCall(tool, args, getConfig());
        // 全部套件共用桥接鉴权、目标推导、参数校验、限流与错误处理。
        const data = await agentApi('/api/socialV2/tools/call', {
          method: 'POST', body: JSON.stringify(body),
          headers: { 'x-agent-token': args.token }, timeoutMs: 120000,
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `${tool.name} 失败：${error?.message ?? error}` }], isError: true };
      }
    });
  }
  return tools;
}
