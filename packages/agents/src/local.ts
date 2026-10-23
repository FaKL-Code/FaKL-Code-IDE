import { exec } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  isFinalAgentState,
  type AdapterAvailability,
  type AgentOptionInfo,
  type AgentState,
} from '@fakl/protocol';
import { l10n } from '@fakl/i18n';

import { agentEnv } from './env.js';
import { McpStdioClient } from './mcp-client.js';
import { prepareMcpServers } from './mcp-servers.js';
import { toolInputKey } from './tool-input.js';
import type {
  AgentAdapter,
  AgentEvent,
  AgentHandle,
  AgentProfile,
  Disposable,
  McpStdioServerRef,
  PermissionPolicy,
  ResumeKind,
  StartOptions,
  StopReason,
  Usage,
} from './types.js';

/** Endereço padrão da API compatível com OpenAI de cada servidor local. */
export const LOCAL_ENDPOINTS: Readonly<Record<string, string>> = {
  ollama: 'http://127.0.0.1:11434/v1',
  lmstudio: 'http://127.0.0.1:1234/v1',
};

const DETECT_TIMEOUT_MS = 2_500;
/** Passos de ferramenta numa rodada antes de parar e devolver a vez. */
const MAX_STEPS = 60;
const TOOL_OUTPUT_CHARS = 16_000;
const COMMAND_TIMEOUT_MS = 10 * 60_000;
const SEARCH_LIMIT = 60;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'out', '.next', 'target', '.venv']);
const resumePrompt = (): string => l10n.t('Continue where you left off.');
/** Servidor MCP do próprio Core: ele aplica política e aprovação, então não pergunta aqui. */
const CORE_MCP = 'fakl';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface LocalAdapterOptions {
  readonly fetch?: FetchLike;
  readonly hostEnv?: NodeJS.ProcessEnv;
}

export function endpointOf(profile: AgentProfile): string {
  const configured = profile.endpoint?.trim();
  const base = configured ?? LOCAL_ENDPOINTS[profile.provedor] ?? LOCAL_ENDPOINTS.ollama ?? '';
  return base.replace(/\/+$/, '');
}

async function listModels(endpoint: string, fetcher: FetchLike): Promise<string[]> {
  const response = await fetcher(`${endpoint}/models`, {
    signal: AbortSignal.timeout(DETECT_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
  const body = (await response.json()) as { data?: { id?: string }[] };
  return (body.data ?? []).map((m) => m.id ?? '').filter(Boolean);
}

/**
 * Adaptador local (SDD 8.2): Ollama ou LM Studio pela API compatível com
 * OpenAI em localhost. Sem CLI de agente, o próprio adaptador faz o laço de
 * ferramentas: arquivos do worktree, busca, comandos e as ferramentas MCP da
 * sessão, com a mesma política de permissões dos agentes ACP.
 */
export class LocalAdapter implements AgentAdapter {
  readonly id = 'ollama';
  private readonly fetcher: FetchLike;

  constructor(
    private readonly profile: AgentProfile,
    private readonly options: LocalAdapterOptions = {},
  ) {
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async detect(): Promise<AdapterAvailability> {
    const endpoint = endpointOf(this.profile);
    try {
      const models = await listModels(endpoint, this.fetcher);
      const wanted = this.profile.modelo;
      if (wanted && !models.some((m) => m === wanted || m === `${wanted}:latest`)) {
        // No Ollama, baixar o modelo é um comando; no LM Studio, é pela janela dele.
        return this.profile.provedor === 'lmstudio'
          ? { status: 'não-instalado' }
          : { status: 'não-instalado', install: `ollama pull ${wanted}` };
      }
      if (models.length === 0) return { status: 'não-instalado' };
      return { status: 'pronto', path: endpoint };
    } catch {
      // Servidor fechado ou não instalado; a IDE pede para abri-lo.
      return { status: 'não-instalado' };
    }
  }

  async start(options: StartOptions): Promise<AgentHandle> {
    const session = new LocalSession(this.profile, options, this.fetcher, this.options.hostEnv);
    await session.open();
    return session;
  }
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/**
 * Chamadas de ferramenta escritas como texto, comuns em modelos pequenos que
 * não usam o campo `tool_calls`: JSON entre `<tool_call>`, num bloco de código
 * ou como a resposta inteira, no formato `{"name", "arguments"}` (ou
 * `parameters`, ou dentro de `function`). Só valem nomes de ferramentas que
 * existem, para um JSON qualquer na resposta não virar chamada.
 */
export function textToolCalls(content: string, known: ReadonlySet<string>): ToolCall[] {
  const candidates: string[] = [];
  for (const match of content.matchAll(/<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/g)) {
    candidates.push(match[1] ?? '');
  }
  for (const match of content.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    candidates.push(match[1] ?? '');
  }
  const trimmed = content.trim();
  if (candidates.length === 0 && /^[[{]/.test(trimmed)) candidates.push(trimmed);
  const calls: ToolCall[] = [];
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate.trim());
    } catch {
      continue;
    }
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const inner =
        record.function && typeof record.function === 'object'
          ? (record.function as Record<string, unknown>)
          : record;
      const name = inner.name;
      if (typeof name !== 'string' || !known.has(name)) continue;
      const args = inner.arguments ?? inner.parameters ?? {};
      calls.push({
        id: `text_${String(calls.length)}`,
        type: 'function',
        function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
      });
    }
  }
  return calls;
}

type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

interface ToolSpec {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

interface LocalTool {
  readonly spec: ToolSpec;
  /** Tipo no vocabulário do ACP: read, search, edit, execute ou other. */
  readonly kind: string;
  /** Título curto para a mesa de controle e o pedido de permissão. */
  title(args: Record<string, unknown>): string;
  run(args: Record<string, unknown>): Promise<string>;
}

interface QueuedMessage {
  readonly text: string;
  resolve(): void;
  reject(error: Error): void;
}

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value);
}

function clip(text: string): string {
  return text.length > TOOL_OUTPUT_CHARS
    ? `${text.slice(0, TOOL_OUTPUT_CHARS / 2)}\n…\n${text.slice(-TOOL_OUTPUT_CHARS / 2)}`
    : text;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function schema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required };
}

const systemBase = (): string =>
  [
    l10n.t('You are a programming agent working in a project folder (the worktree).'),
    l10n.t(
      'Use the tools to read, search, edit files and run commands; paths are relative to the worktree.',
    ),
    l10n.t('Read before editing. Prefer edit_file over rewriting the whole file.'),
    l10n.t('When you finish, reply with a short summary of what you did.'),
  ].join(' ');

/** Rodada interrompida por pause() ou stop(). */
class Interrupted extends Error {}

class LocalSession implements AgentHandle {
  private current: AgentState = 'preparando';
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly queue: QueuedMessage[] = [];
  private readonly permissions = new Map<string, (allow: boolean) => void>();
  private readonly messages: ChatMessage[] = [];
  private readonly tools = new Map<string, LocalTool>();
  private readonly mcp: McpStdioClient[] = [];
  private readonly cwd: string;
  private readonly endpoint: string;
  private model = '';
  /** Modelos do servidor local, para trocar com a sessão viva. */
  private models: string[] = [];
  private running = false;
  private interrupted = false;
  private policy: PermissionPolicy;
  private abort: AbortController | undefined;
  private totals = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  private nextPermission = 1;

  constructor(
    private readonly profile: AgentProfile,
    private readonly options: StartOptions,
    private readonly fetcher: FetchLike,
    private readonly hostEnv: NodeJS.ProcessEnv = process.env,
  ) {
    this.cwd = path.resolve(options.cwd);
    this.policy = options.permissions;
    this.endpoint = endpointOf(profile);
  }

  get state(): AgentState {
    return this.current;
  }

  get resumedAs(): ResumeKind | undefined {
    return this.options.resume ? 'histórico' : undefined;
  }

  async open(): Promise<void> {
    let models: string[];
    try {
      models = await listModels(this.endpoint, this.fetcher);
    } catch (error) {
      throw new Error(
        l10n.t(
          'the local server at {0} did not respond ({1}); open Ollama or LM Studio',
          this.endpoint,
          error instanceof Error ? error.message : String(error),
        ),
        { cause: error },
      );
    }
    const wanted = this.profile.modelo;
    const model = wanted ? models.find((m) => m === wanted || m === `${wanted}:latest`) : models[0];
    if (!model) {
      throw new Error(
        wanted
          ? l10n.t('the model {0} is not on the local server', wanted)
          : l10n.t('the local server has no models'),
      );
    }
    this.model = model;
    this.models = models;
    this.addBuiltinTools();
    // O laço local só fala stdio; servidores HTTP ficam para os agentes ACP.
    for (const server of prepareMcpServers(this.options.mcpServers ?? [], this.cwd)) {
      if (server.type !== 'http') await this.addMcp(server);
    }
    this.messages.push({
      role: 'system',
      content: [systemBase(), this.options.systemPrompt, this.options.resume?.history]
        .filter(Boolean)
        .join('\n\n'),
    });
    this.setState('ocioso');
  }

  send(message: string): Promise<void> {
    if (isFinalAgentState(this.current))
      return Promise.reject(new Error(l10n.t('agent {0}', this.current)));
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ text: message, resolve, reject });
      this.pump();
    });
  }

  onEvent(listener: (event: AgentEvent) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  respondPermission(id: string, allow: boolean): Promise<void> {
    const pending = this.permissions.get(id);
    if (!pending) return Promise.reject(new Error(l10n.t('no permission request {0} is open', id)));
    this.permissions.delete(id);
    pending(allow);
    this.transition(['aguardando-permissão'], allow ? 'executando' : 'pensando');
    return Promise.resolve();
  }

  setPermissions(policy: PermissionPolicy): void {
    this.policy = policy;
  }

  sessionOptions(): readonly AgentOptionInfo[] {
    return [
      {
        id: 'model',
        nome: l10n.t('Model'),
        categoria: 'model',
        atual: this.model,
        valores: this.models.map((id) => ({ id, nome: id })),
      },
    ];
  }

  setOption(id: string, value: string | boolean): Promise<void> {
    if (id !== 'model' || typeof value !== 'string' || !this.models.includes(value)) {
      return Promise.reject(new Error(l10n.t('invalid option: {0}={1}', id, String(value))));
    }
    // O histórico continua; o próximo pedido já vai para o modelo novo.
    this.model = value;
    this.emit({ type: 'options', options: this.sessionOptions() });
    return Promise.resolve();
  }

  pause(): Promise<void> {
    if (isFinalAgentState(this.current))
      return Promise.reject(new Error(l10n.t('agent {0}', this.current)));
    if (this.current === 'pausado') return Promise.resolve();
    const wasBusy = this.running;
    this.setState('pausado');
    if (wasBusy) {
      this.interrupted = true;
      this.cancelTurn();
    }
    return Promise.resolve();
  }

  resume(continuar = true): Promise<void> {
    if (this.current !== 'pausado') return Promise.resolve();
    this.setState('ocioso');
    if (this.interrupted) {
      this.interrupted = false;
      if (continuar)
        this.queue.unshift({
          text: resumePrompt(),
          resolve: () => undefined,
          reject: () => undefined,
        });
    }
    this.pump();
    return Promise.resolve();
  }

  stop(reason: StopReason): Promise<void> {
    if (isFinalAgentState(this.current)) return Promise.resolve();
    this.setState('parado', reason);
    this.cancelTurn();
    for (const item of this.queue.splice(0)) item.reject(new Error(l10n.t('agent stopped')));
    for (const client of this.mcp) client.close();
    return Promise.resolve();
  }

  usage(): Usage {
    // Modelo local: tokens contam, custo é zero.
    return { ...this.totals, cost: { amount: 0, currency: 'USD' } };
  }

  private cancelTurn(): void {
    this.abort?.abort();
    for (const pending of this.permissions.values()) pending(false);
    this.permissions.clear();
  }

  private pump(): void {
    if (this.running || this.current !== 'ocioso') return;
    const next = this.queue.shift();
    if (!next) return;
    this.running = true;
    this.abort = new AbortController();
    this.messages.push({ role: 'user', content: next.text });
    this.turn().then(
      () => {
        this.running = false;
        this.transition(['pensando', 'executando', 'aguardando-permissão'], 'ocioso');
        next.resolve();
        this.pump();
      },
      (error: unknown) => {
        this.running = false;
        if (!(error instanceof Interrupted)) {
          const message = error instanceof Error ? error.message : String(error);
          this.emit({ type: 'error', message });
          this.transition(['pensando', 'executando', 'aguardando-permissão'], 'ocioso');
          next.reject(new Error(message));
        } else {
          next.resolve();
        }
        this.pump();
      },
    );
  }

  /** Uma rodada: o modelo responde e chama ferramentas até não chamar mais. */
  private async turn(): Promise<void> {
    for (let step = 0; step < MAX_STEPS; step++) {
      this.checkRunning();
      this.setState('pensando');
      const reply = await this.complete();
      this.messages.push(reply);
      const calls = reply.tool_calls ?? [];
      if (calls.length === 0) return;
      for (const call of calls) {
        this.checkRunning();
        const content = await this.runTool(call);
        this.messages.push({ role: 'tool', tool_call_id: call.id, content: clip(content) });
      }
    }
    this.emit({
      type: 'output',
      kind: 'message',
      text: `\n\n(${l10n.t('Stopped after {0} steps; send "continue" to proceed.', String(MAX_STEPS))})`,
    });
  }

  private checkRunning(): void {
    if (this.current === 'pausado' || isFinalAgentState(this.current)) throw new Interrupted();
  }

  /** Chamada em streaming à API de chat; separa raciocínio, texto e chamadas de ferramenta. */
  private async complete(): Promise<Extract<ChatMessage, { role: 'assistant' }>> {
    const abort = this.abort ?? new AbortController();
    const tools = [...this.tools.values()].map((t) => t.spec);
    let response: Response;
    try {
      response = await this.fetcher(`${this.endpoint}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: this.messages,
          stream: true,
          stream_options: { include_usage: true },
          ...(tools.length > 0 ? { tools } : {}),
        }),
        signal: abort.signal,
      });
    } catch (error) {
      if (abort.signal.aborted) throw new Interrupted();
      throw error;
    }
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      throw new Error(
        l10n.t('the local model responded {0}: {1}', String(response.status), text.slice(0, 300)),
      );
    }
    let content = '';
    let thinking = false;
    const calls: ToolCall[] = [];
    const decoder = new TextDecoder();
    let buffer = '';
    const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
    const emitText = (text: string): void => {
      // Modelos como o deepseek-r1 mandam o raciocínio entre <think> e </think>.
      let rest = text;
      while (rest) {
        const tag = thinking ? '</think>' : '<think>';
        const at = rest.indexOf(tag);
        const piece = at < 0 ? rest : rest.slice(0, at);
        if (piece) {
          if (thinking) this.emit({ type: 'output', kind: 'thought', text: piece });
          else {
            content += piece;
            this.emit({ type: 'output', kind: 'message', text: piece });
          }
        }
        if (at < 0) break;
        thinking = !thinking;
        rest = rest.slice(at + tag.length);
      }
    };
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          let chunk: StreamChunk;
          try {
            chunk = JSON.parse(data) as StreamChunk;
          } catch {
            continue;
          }
          if (chunk.usage) this.addUsage(chunk.usage);
          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;
          const reasoning = delta.reasoning_content ?? delta.reasoning;
          if (reasoning) this.emit({ type: 'output', kind: 'thought', text: reasoning });
          if (delta.content) emitText(delta.content);
          for (const part of delta.tool_calls ?? []) {
            const index = part.index ?? calls.length;
            const call = (calls[index] ??= {
              id: part.id ?? `call_${String(index)}`,
              type: 'function',
              function: { name: '', arguments: '' },
            });
            if (part.id) call.id = part.id;
            if (part.function?.name) call.function.name += part.function.name;
            if (part.function?.arguments) call.function.arguments += part.function.arguments;
          }
        }
      }
    } catch (error) {
      if (abort.signal.aborted) throw new Interrupted();
      throw error;
    }
    let toolCalls = calls.filter(Boolean);
    if (toolCalls.length === 0) toolCalls = textToolCalls(content, new Set(this.tools.keys()));
    return {
      role: 'assistant',
      content,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
  }

  private async runTool(call: ToolCall): Promise<string> {
    const tool = this.tools.get(call.function.name);
    if (!tool) return l10n.t('Error: tool {0} does not exist.', call.function.name);
    let args: Record<string, unknown>;
    try {
      const parsed: unknown = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      args = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return l10n.t('Error: arguments are not valid JSON.');
    }
    const title = tool.title(args);
    const input = toolInputKey(args);
    this.emit({
      type: 'tool',
      toolCallId: call.id,
      title,
      ...(input ? { input } : {}),
      kind: tool.kind,
      status: 'pending',
    });
    if (!(await this.allowed(call.id, tool, title))) {
      this.emit({ type: 'tool', toolCallId: call.id, title, kind: tool.kind, status: 'failed' });
      this.checkRunning();
      return l10n.t('The user denied this action. Continue without it or explain what you need.');
    }
    this.checkRunning();
    this.setState('executando');
    this.emit({ type: 'tool', toolCallId: call.id, title, kind: tool.kind, status: 'in_progress' });
    try {
      const result = await tool.run(args);
      this.emit({ type: 'tool', toolCallId: call.id, title, kind: tool.kind, status: 'completed' });
      return result;
    } catch (error) {
      this.emit({ type: 'tool', toolCallId: call.id, title, kind: tool.kind, status: 'failed' });
      return l10n.t('Error: {0}', error instanceof Error ? error.message : String(error));
    }
  }

  private allowed(callId: string, tool: LocalTool, title: string): Promise<boolean> {
    const policy = this.policy;
    if (policy === 'aprovar-tudo') return Promise.resolve(true);
    if (tool.kind === 'core') return Promise.resolve(true);
    if (policy === 'aprovar-leitura' && (tool.kind === 'read' || tool.kind === 'search')) {
      return Promise.resolve(true);
    }
    const id = `${callId}-${String(this.nextPermission++)}`;
    return new Promise((resolve) => {
      this.permissions.set(id, resolve);
      this.transition(['pensando', 'executando'], 'aguardando-permissão');
      this.emit({
        type: 'permission',
        id,
        title,
        options: [
          { id: 'allow', name: l10n.t('Allow'), kind: 'allow_once' },
          { id: 'reject', name: l10n.t('Deny'), kind: 'reject_once' },
        ],
      });
    });
  }

  private resolveInside(file: string): string {
    const target = path.resolve(this.cwd, file || '.');
    if (!isInside(this.cwd, target)) throw new Error(l10n.t('path outside the agent worktree'));
    return target;
  }

  private addBuiltinTools(): void {
    const add = (tool: LocalTool): void => {
      this.tools.set(tool.spec.function.name, tool);
    };
    const fn = (
      name: string,
      description: string,
      parameters: Record<string, unknown>,
    ): ToolSpec => ({ type: 'function', function: { name, description, parameters } });

    add({
      spec: fn(
        'read_file',
        l10n.t('Reads a text file from the worktree. Use line and limit for large files.'),
        schema(
          {
            path: { type: 'string' },
            line: { type: 'integer', description: l10n.t('First line, starting at 1') },
            limit: { type: 'integer' },
          },
          ['path'],
        ),
      ),
      kind: 'read',
      title: (a) => l10n.t('Read {0}', str(a, 'path')),
      run: async (a) => {
        const text = await readFile(this.resolveInside(str(a, 'path')), 'utf8');
        const line = typeof a.line === 'number' ? a.line : undefined;
        const limit = typeof a.limit === 'number' ? a.limit : undefined;
        if (line === undefined && limit === undefined) return text;
        const lines = text.split('\n');
        const start = Math.max((line ?? 1) - 1, 0);
        return lines.slice(start, limit === undefined ? undefined : start + limit).join('\n');
      },
    });
    add({
      spec: fn(
        'list_dir',
        l10n.t('Lists files and folders of a worktree directory.'),
        schema({ path: { type: 'string' } }, []),
      ),
      kind: 'read',
      title: (a) => l10n.t('List {0}', str(a, 'path') || '.'),
      run: async (a) => {
        const entries = await readdir(this.resolveInside(str(a, 'path')), { withFileTypes: true });
        return entries
          .filter((e) => !SKIP_DIRS.has(e.name))
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort()
          .join('\n');
      },
    });
    add({
      spec: fn(
        'search',
        l10n.t('Searches the contents of the worktree files for a regular expression.'),
        schema({ pattern: { type: 'string' }, path: { type: 'string' } }, ['pattern']),
      ),
      kind: 'search',
      title: (a) => l10n.t('Search {0}', str(a, 'pattern')),
      run: (a) => this.search(str(a, 'pattern'), str(a, 'path')),
    });
    add({
      spec: fn(
        'write_file',
        l10n.t('Creates or replaces a worktree file with the entire content.'),
        schema({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
      ),
      kind: 'edit',
      title: (a) => l10n.t('Write {0}', str(a, 'path')),
      run: async (a) => {
        const target = this.resolveInside(str(a, 'path'));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, str(a, 'content'), 'utf8');
        this.emit({ type: 'file', path: path.relative(this.cwd, target) });
        return 'ok';
      },
    });
    add({
      spec: fn(
        'edit_file',
        l10n.t('Replaces an exact snippet of a file with another. old must appear exactly once.'),
        schema({ path: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' } }, [
          'path',
          'old',
          'new',
        ]),
      ),
      kind: 'edit',
      title: (a) => l10n.t('Edit {0}', str(a, 'path')),
      run: async (a) => {
        const target = this.resolveInside(str(a, 'path'));
        const text = await readFile(target, 'utf8');
        const old = str(a, 'old');
        const count = old ? text.split(old).length - 1 : 0;
        if (count !== 1) {
          return l10n.t(
            'Error: the snippet appears {0} times; send a unique snippet.',
            String(count),
          );
        }
        await writeFile(
          target,
          text.replace(old, () => str(a, 'new')),
          'utf8',
        );
        this.emit({ type: 'file', path: path.relative(this.cwd, target) });
        return 'ok';
      },
    });
    add({
      spec: fn(
        'run_command',
        l10n.t('Runs a shell command in the worktree and returns the output (tests, build, git).'),
        schema({ command: { type: 'string' } }, ['command']),
      ),
      kind: 'execute',
      title: (a) => str(a, 'command'),
      run: (a) => this.command(str(a, 'command')),
    });
  }

  private async addMcp(server: McpStdioServerRef): Promise<void> {
    const client = new McpStdioClient(server, this.cwd, agentEnv(this.hostEnv, this.options.env));
    try {
      await client.open();
      const tools = await client.tools();
      this.mcp.push(client);
      for (const tool of tools) {
        // Nome com o servidor na frente, como os agentes ACP fazem, sem colidir com as embutidas.
        const name = `${server.name}__${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
        this.tools.set(name, {
          spec: {
            type: 'function',
            function: {
              name,
              description: tool.description ?? tool.name,
              parameters: tool.inputSchema,
            },
          },
          kind: server.name === CORE_MCP ? 'core' : 'other',
          title: () => `${server.name}: ${tool.name}`,
          run: (args) => client.call(tool.name, args),
        });
      }
    } catch (error) {
      client.close();
      this.emit({
        type: 'error',
        message: l10n.t(
          'MCP server {0} unavailable: {1}',
          server.name,
          error instanceof Error ? error.message : String(error),
        ),
      });
    }
  }

  private async search(pattern: string, under: string): Promise<string> {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'i');
    } catch {
      return l10n.t('Error: invalid regular expression.');
    }
    const results: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      if (results.length >= SEARCH_LIMIT) return;
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (results.length >= SEARCH_LIMIT) return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) await walk(full);
          continue;
        }
        const info = await stat(full).catch(() => undefined);
        if (!info || info.size > 1_000_000) continue;
        const text = await readFile(full, 'utf8').catch(() => '');
        if (text.includes('\0')) continue;
        text.split('\n').forEach((line, index) => {
          if (results.length < SEARCH_LIMIT && regex.test(line)) {
            results.push(
              `${path.relative(this.cwd, full)}:${String(index + 1)}: ${line.trim().slice(0, 200)}`,
            );
          }
        });
      }
    };
    await walk(this.resolveInside(under));
    return results.length > 0 ? results.join('\n') : l10n.t('Nothing found.');
  }

  private command(command: string): Promise<string> {
    const signal = this.abort?.signal;
    return new Promise((resolve) => {
      exec(
        command,
        {
          cwd: this.cwd,
          env: agentEnv(this.hostEnv, this.options.env),
          timeout: COMMAND_TIMEOUT_MS,
          maxBuffer: 20 * 1024 * 1024,
          ...(signal ? { signal } : {}),
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
          resolve(
            clip(
              `${stdout}${stderr ? `\n${stderr}` : ''}\n(${l10n.t('exit code {0}', String(code))})`,
            ),
          );
        },
      );
    });
  }

  private addUsage(usage: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  }): void {
    const input = usage.prompt_tokens ?? 0;
    const output = usage.completion_tokens ?? 0;
    this.totals = {
      inputTokens: this.totals.inputTokens + input,
      outputTokens: this.totals.outputTokens + output,
      totalTokens: this.totals.totalTokens + (usage.total_tokens ?? input + output),
    };
    this.emit({ type: 'usage', usage: this.usage() });
  }

  private transition(from: readonly AgentState[], to: AgentState): void {
    if (from.includes(this.current)) this.setState(to);
  }

  private setState(state: AgentState, reason?: StopReason): void {
    if (state === this.current) return;
    if (state === 'pensando' || state === 'executando') {
      // Eventos atrasados não tiram o agente da pausa nem de um estado final.
      if (this.current === 'pausado' || isFinalAgentState(this.current)) return;
    }
    const previous = this.current;
    this.current = state;
    this.emit({ type: 'state', state, previous, ...(reason ? { reason } : {}) });
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

interface StreamChunk {
  readonly choices?: {
    readonly delta?: {
      readonly content?: string | null;
      readonly reasoning_content?: string;
      readonly reasoning?: string;
      readonly tool_calls?: {
        readonly index?: number;
        readonly id?: string;
        readonly function?: { readonly name?: string; readonly arguments?: string };
      }[];
    };
  }[];
  readonly usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}
