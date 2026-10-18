/**
 * Varredura estática de skills, agentes e servidores MCP antes de instalar
 * (ADR 0042). É heurística: acha padrões conhecidos de prompt injection,
 * execução remota, envio de dados e configuração arriscada de MCP. Achar nada
 * NÃO prova que o item é seguro, e achar algo não prova que é malicioso.
 *
 * Módulo puro: não lê disco nem rede. Quem chama entrega os arquivos já lidos.
 */

import type { ResourceRisk, ResourceRiskSeverity } from '@fakl/protocol';

export type ResourceScanKind = 'agent' | 'skill' | 'mcp';

export interface ResourceScanFile {
  /** Caminho relativo ao item (`SKILL.md`, `scripts/setup.sh`, `mcps.json`). */
  readonly caminho: string;
  readonly conteudo: string;
}

export interface ResourceScanInput {
  readonly tipo: ResourceScanKind;
  readonly nome: string;
  /**
   * Agente: o `.md`. Skill: os arquivos de texto da pasta. MCP: um arquivo
   * cujo conteúdo é o JSON da definição do servidor (só o objeto dele).
   */
  readonly arquivos: readonly ResourceScanFile[];
}

/** Ids estáveis das regras; a interface traduz cada um. */
export const RESOURCE_RULES = [
  'prompt-injection',
  'unicode-invisivel',
  'base64-longo',
  'baixa-e-executa',
  'executa-texto',
  'envio-externo',
  'le-segredos',
  'sem-confirmacao',
  'mcp-shell',
  'mcp-sem-versao',
  'mcp-dominio-estranho',
] as const;

export type ResourceRuleId = (typeof RESOURCE_RULES)[number];

const SEVERITY_ORDER: Record<ResourceRiskSeverity, number> = { alta: 0, media: 1, baixa: 2 };

const MAX_FINDINGS = 60;
const SNIPPET_MAX = 120;
const BASE64_MIN = 200;

type Severity = ResourceRiskSeverity | ((line: string) => ResourceRiskSeverity);

interface LineRule {
  readonly regra: ResourceRuleId;
  readonly severidade: Severity;
  readonly pattern: RegExp;
}

const INJECTION = [
  String.raw`ignore\s+(?:all\s+|any\s+|the\s+|your\s+)*(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?|messages?)`,
  String.raw`disregard\s+(?:all\s+|any\s+|the\s+|your\s+)*(?:previous|prior|above|earlier|system)\s+(?:instructions?|prompts?|rules?)`,
  String.raw`forget\s+(?:all\s+|everything\s+|your\s+)*(?:previous\s+|prior\s+)?instructions?`,
  String.raw`ignore\s+(?:the\s+)?system\s+prompt`,
  String.raw`do\s+not\s+(?:tell|inform)\s+the\s+user`,
  String.raw`don'?t\s+(?:tell|inform)\s+the\s+user`,
  String.raw`without\s+(?:telling|informing|notifying)\s+the\s+user`,
  String.raw`(?:reveal|print|show|repeat)\s+(?:me\s+)?your\s+(?:system\s+prompt|hidden\s+instructions)`,
  String.raw`ignor[ea]\s+(?:todas\s+)?(?:as\s+)?instru[cç][õo]es\s+(?:anteriores|acima|do\s+sistema|de\s+sistema)`,
  String.raw`desconsidere\s+(?:todas\s+)?(?:as\s+)?instru[cç][õo]es\s+(?:anteriores|acima|do\s+sistema)`,
  String.raw`esque[cç]a\s+(?:todas\s+)?(?:as\s+)?(?:suas\s+)?instru[cç][õo]es`,
  String.raw`n[ãa]o\s+(?:conte|diga|avise|informe|mencione)\s+(?:isso\s+)?(?:ao|para\s+o|pro)\s+usu[áa]rio`,
  String.raw`sem\s+(?:avisar|informar|contar\s+ao)\s+(?:o\s+)?usu[áa]rio`,
].join('|');

/** Verbos de enviar, perto de um destino externo, agravam o achado. */
const SEND_VERB =
  /\b(?:curl|wget|invoke-restmethod|invoke-webrequest|irm|iwr|fetch|post|upload|send|enviar?|envie|mandar?|exfil\w*)\b|(?:^|\s)(?:-d|--data(?:-\w+)?|-F|--form)\b/i;

/** Destinos que servem para receber dados de quem não é dono do serviço. */
const EXTERNAL_SINK =
  /(?:webhook\.site|requestbin\.\w+|pipedream\.net|pastebin\.com|paste\.ee|hastebin\.com|transfer\.sh|file\.io|0x0\.st|ngrok(?:-free)?\.(?:io|app|dev)|trycloudflare\.com|loca\.lt|serveo\.net|oast\.\w+|interact\.sh|burpcollaborator\.net|discord(?:app)?\.com\/api\/webhooks|hooks\.slack\.com\/services|api\.telegram\.org\/bot)/i;

const SECRET_PATH =
  /(?:~\/\.ssh|\.ssh\/|\bid_(?:rsa|ed25519|ecdsa|dsa)\b|(?:~\/|\/)\.aws\b|\.aws\/credentials|(?<![\w-])\.env(?![\w.-]*(?:example|sample|template))(?:\.[a-z]+)?\b|\.npmrc\b|\.netrc\b|\.git-credentials\b|\.kube\/config|\.docker\/config\.json|\.gnupg\b|\bkeychain\b|\bcofre\s+de\s+(?:tokens?|segredos)\b|\btoken\s+(?:vault|store)\b|\bcredential\s+(?:vault|store)\b)/i;

const READ_VERB =
  /\b(?:cat|type|read|reads|ler|leia|get-content|gc|copy|cp|copiar|copie|print|show|mostre|exiba|dump|list|liste|collect|colete|include|inclua|attach|anexe|steal)\b/i;

const NETWORK_COMMAND =
  /\b(?:curl|wget|invoke-restmethod|invoke-webrequest|irm|iwr|nc|ncat|scp)\b/i;

const LINE_RULES: readonly LineRule[] = [
  { regra: 'prompt-injection', severidade: 'alta', pattern: new RegExp(INJECTION, 'i') },
  {
    regra: 'baixa-e-executa',
    severidade: 'alta',
    pattern:
      /\b(?:curl|wget|invoke-webrequest|invoke-restmethod|iwr|irm|fetch)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b|\b(?:iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n|]*\|\s*(?:iex|invoke-expression)\b|\bbase64\s+(?:-d|--decode)[^\n|]*\|\s*(?:ba|z)?sh\b/i,
  },
  {
    regra: 'executa-texto',
    severidade: (line) => (/\binvoke-expression\b|\biex\s*[(\s$]/i.test(line) ? 'media' : 'baixa'),
    pattern: /\binvoke-expression\b|\biex\s*[(\s$]|\beval\s*[("'$`]|\beval\s+"?\$/i,
  },
  {
    regra: 'envio-externo',
    severidade: (line) => (SEND_VERB.test(line) ? 'alta' : 'media'),
    pattern: EXTERNAL_SINK,
  },
  {
    regra: 'le-segredos',
    severidade: (line) => {
      if (NETWORK_COMMAND.test(line)) return 'alta';
      // `cp .env.example .env` é o passo de configuração mais comum que existe.
      if (/example|sample|template/i.test(line)) return 'baixa';
      return READ_VERB.test(line) ? 'media' : 'baixa';
    },
    pattern: SECRET_PATH,
  },
  {
    regra: 'sem-confirmacao',
    severidade: (line) => (/--dangerously-skip-permissions/i.test(line) ? 'alta' : 'media'),
    pattern:
      /--dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox|\bbypassPermissions\b|--yolo\b|\b(?:disable|turn\s+off|skip|bypass)\s+(?:all\s+)?(?:permission|confirmation|approval)s?(?:\s+prompts?)?\b|\bnever\s+ask\s+(?:the\s+user\s+)?for\s+(?:confirmation|permission|approval)|\bwithout\s+asking\s+(?:the\s+user\s+)?for\s+(?:confirmation|permission|approval)|\bauto-?approve\s+(?:all|everything)|(?:desative|desligue|ignore|pule)\s+(?:todas\s+)?as?\s+(?:confirma[cç][õo]es|permiss[õo]es|aprova[cç][õo]es)|nunca\s+(?:pe[cç]a|pergunte)\s+(?:ao\s+usu[áa]rio\s+)?(?:confirma[cç][ãa]o|permiss[ãa]o)|sem\s+pedir\s+(?:confirma[cç][ãa]o|permiss[ãa]o|aprova[cç][ãa]o)/i,
  },
];

const BIDI = /[\u202A-\u202E\u2066-\u2069]/;
const ZERO_WIDTH = /[\u200B-\u200D\u2060\u180E]/;
const TAG_CHARS = /[\u{E0000}-\u{E007F}]/u;
const INVISIBLE_ALL =
  /[\u202A-\u202E\u2066-\u2069\u200B-\u200D\u2060\u180E\uFEFF\u{E0000}-\u{E007F}]/gu;
const BASE64_BLOB = new RegExp(`[A-Za-z0-9+/_-]{${BASE64_MIN},}={0,2}`);

/** Linha curta para mostrar; os invisíveis viram `_` para o leitor ver onde estavam. */
function snippet(line: string): string {
  const flat = line.replace(INVISIBLE_ALL, '_').replace(/\s+/g, ' ').trim();
  return flat.length > SNIPPET_MAX ? `${flat.slice(0, SNIPPET_MAX - 1).trimEnd()}…` : flat;
}

/** Caminhos e URLs longos casam o alfabeto do base64; sem `+` nem `=` e cheios de separadores viram falso positivo. */
function isLikelyPath(text: string): boolean {
  return !/[+=]/.test(text) && (text.match(/[/_-]/g)?.length ?? 0) > text.length / 8;
}

function scanText(file: ResourceScanFile): ResourceRisk[] {
  const risks: ResourceRisk[] = [];
  const lines = file.conteudo.split(/\r\n|\r|\n/);
  lines.forEach((raw, index) => {
    // Um BOM no começo do arquivo é normal; só vale o que está no meio.
    const line = index === 0 ? raw.replace(/^\uFEFF/, '') : raw;
    const push = (regra: ResourceRuleId, severidade: ResourceRiskSeverity): void => {
      risks.push({
        regra,
        severidade,
        arquivo: file.caminho,
        linha: index + 1,
        trecho: snippet(line),
      });
    };
    if (BIDI.test(line) || TAG_CHARS.test(line)) push('unicode-invisivel', 'alta');
    else if (ZERO_WIDTH.test(line) || line.includes('\uFEFF')) push('unicode-invisivel', 'media');
    const blob = BASE64_BLOB.exec(line);
    if (blob && !isLikelyPath(blob[0])) {
      // Imagem ou fonte embutida (`data:image/...;base64,`) é comum e inofensiva por si só.
      push('base64-longo', /data:(?:image|font)\/[\w.+-]+;base64,/i.test(line) ? 'baixa' : 'media');
    }
    for (const rule of LINE_RULES) {
      if (!rule.pattern.test(line)) continue;
      push(
        rule.regra,
        typeof rule.severidade === 'function' ? rule.severidade(line) : rule.severidade,
      );
    }
  });
  return risks;
}

const SHELLS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'fish',
  'cmd',
  'cmd.exe',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
]);
const RUNNERS = new Set(['npx', 'npx.cmd', 'bunx', 'pnpx', 'uvx', 'pipx']);
const TUNNEL_HOST = new RegExp(
  `(?:${EXTERNAL_SINK.source}|serveousercontent\\.com|lhr\\.life|ngrok\\.\\w+)`,
  'i',
);

function baseName(command: string): string {
  return (command.split(/[\\/]/).pop() ?? command).toLowerCase();
}

/** `pacote@1.2.3`, `@escopo/pacote@1.2.3` ou `pacote==1.2.3`: versão exata, não `latest` nem faixa. */
function isPinned(spec: string): boolean {
  const at = spec.lastIndexOf('@');
  const version = spec.includes('==')
    ? (spec.split('==')[1] ?? '')
    : at > 0
      ? spec.slice(at + 1)
      : '';
  return /^v?\d+(?:\.\d+){1,3}(?:[-+][\w.-]+)?$/.test(version);
}

function firstPackageArg(args: readonly string[], command: string): string | undefined {
  const rest = command === 'pipx' && args[0] === 'run' ? args.slice(1) : args;
  return rest.find((arg) => !arg.startsWith('-'));
}

function lineOf(content: string, needle: string): number {
  const at = content.indexOf(needle);
  return at < 0 ? 1 : content.slice(0, at).split('\n').length;
}

function isLocalHost(host: string): boolean {
  return (
    host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')
  );
}

function scanMcp(file: ResourceScanFile): ResourceRisk[] {
  let server: unknown;
  try {
    server = JSON.parse(file.conteudo);
  } catch {
    return [];
  }
  if (typeof server !== 'object' || server === null || Array.isArray(server)) return [];
  const raw = server as Record<string, unknown>;
  const risks: ResourceRisk[] = [];
  const push = (
    regra: ResourceRuleId,
    severidade: ResourceRiskSeverity,
    needle: string,
    trecho: string,
  ): void => {
    risks.push({
      regra,
      severidade,
      arquivo: file.caminho,
      linha: lineOf(file.conteudo, needle),
      trecho: snippet(trecho),
    });
  };
  const args = Array.isArray(raw.args)
    ? raw.args.filter((arg): arg is string => typeof arg === 'string')
    : [];
  if (typeof raw.command === 'string' && raw.command !== '') {
    const command = baseName(raw.command);
    const full = [raw.command, ...args].join(' ');
    if (SHELLS.has(command)) {
      push('mcp-shell', 'alta', '"command"', full);
    } else if (RUNNERS.has(command)) {
      const spec = firstPackageArg(args, command);
      // Sem versão fixa o que roda é "o que estiver publicado hoje": comum, por isso só aviso leve.
      if (spec && !isPinned(spec)) push('mcp-sem-versao', 'baixa', '"command"', full);
    }
  }
  if (typeof raw.url === 'string' && raw.url !== '') {
    let url: URL | undefined;
    try {
      url = new URL(raw.url);
    } catch {
      push('mcp-dominio-estranho', 'media', '"url"', raw.url);
    }
    if (url) {
      const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
      if (!isLocalHost(host)) {
        if (TUNNEL_HOST.test(host)) push('mcp-dominio-estranho', 'alta', '"url"', raw.url);
        else if (
          /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ||
          host.includes(':') ||
          host.split('.').some((part) => part.startsWith('xn--')) ||
          url.protocol === 'http:'
        ) {
          push('mcp-dominio-estranho', 'media', '"url"', raw.url);
        }
      }
    }
  }
  return risks;
}

/**
 * Varre um recurso e devolve os achados, dos mais graves aos menos, no máximo
 * um por regra e linha. Sem achado, a lista é vazia (o que não é garantia).
 */
export function scanResource(input: ResourceScanInput): ResourceRisk[] {
  const risks: ResourceRisk[] = [];
  for (const file of input.arquivos) {
    const text = scanText(file);
    if (input.tipo === 'mcp') {
      const structural = scanMcp(file);
      // O destino de túnel já sai como `mcp-dominio-estranho`: não repetir como envio.
      const covered = new Set(structural.map((risk) => risk.linha));
      risks.push(
        ...structural,
        ...text.filter((risk) => !(risk.regra === 'envio-externo' && covered.has(risk.linha))),
      );
    } else {
      risks.push(...text);
    }
  }
  const seen = new Set<string>();
  const unique = risks.filter((risk) => {
    const id = `${risk.regra}:${risk.arquivo}:${risk.linha}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  unique.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severidade] - SEVERITY_ORDER[b.severidade] ||
      a.arquivo.localeCompare(b.arquivo) ||
      a.linha - b.linha,
  );
  return unique.slice(0, MAX_FINDINGS);
}
