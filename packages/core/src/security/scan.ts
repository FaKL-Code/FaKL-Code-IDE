/**
 * Varredura de segredos (SDD 14.1): acha tokens e chaves conhecidos num texto
 * antes de ele ir para um log, uma nota do vault ou um push.
 */

import { l10n } from '@fakl/i18n';

export interface SecretFinding {
  readonly tipo: string;
  /** Posição no texto. */
  readonly inicio: number;
  readonly fim: number;
  /** Prévia mascarada, segura para mostrar. */
  readonly previa: string;
}

/** `tipo` é função: o nome sai no idioma da interface, escolhido depois de carregar o módulo. */
const PATTERNS: readonly { tipo: () => string; pattern: RegExp }[] = [
  {
    tipo: () => l10n.t('GitHub token'),
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,255})\b/g,
  },
  { tipo: () => l10n.t('Anthropic key'), pattern: /\bsk-ant-[A-Za-z0-9_-]{32,}/g },
  {
    tipo: () => l10n.t('OpenAI key'),
    pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g,
  },
  { tipo: () => l10n.t('Google key'), pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { tipo: () => l10n.t('AWS key'), pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { tipo: () => l10n.t('Slack token'), pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { tipo: () => l10n.t('Stripe key'), pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/g },
  { tipo: () => l10n.t('npm token'), pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  {
    tipo: () => l10n.t('private key'),
    pattern:
      /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----|$)/g,
  },
  {
    tipo: () => 'JWT',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  {
    tipo: () => l10n.t('password in URL'),
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]{3,}@[^\s/]+/gi,
  },
];

function mask(value: string): string {
  const flat = value.replace(/\s+/g, ' ');
  return flat.length <= 8 ? '****' : `${flat.slice(0, 4)}…${flat.slice(-2)}`;
}

/**
 * Acha segredos no texto. `conhecidos` são valores exatos que o Core guarda
 * (os tokens do cofre), achados mesmo sem um formato reconhecível.
 */
export function scanSecrets(text: string, conhecidos: readonly string[] = []): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const { tipo, pattern } of PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const inicio = match.index;
      findings.push({
        tipo: tipo(),
        inicio,
        fim: inicio + match[0].length,
        previa: mask(match[0]),
      });
    }
  }
  for (const secret of conhecidos) {
    if (secret.length < 8) continue;
    let from = 0;
    for (;;) {
      const at = text.indexOf(secret, from);
      if (at < 0) break;
      findings.push({
        tipo: l10n.t('keychain secret'),
        inicio: at,
        fim: at + secret.length,
        previa: mask(secret),
      });
      from = at + secret.length;
    }
  }
  // Ordena e junta sobreposições (o mesmo token pode casar dois padrões).
  findings.sort((a, b) => a.inicio - b.inicio || b.fim - a.fim);
  const merged: SecretFinding[] = [];
  for (const finding of findings) {
    const last = merged.at(-1);
    if (last && finding.inicio < last.fim) {
      if (finding.fim > last.fim) merged[merged.length - 1] = { ...last, fim: finding.fim };
      continue;
    }
    merged.push(finding);
  }
  return merged;
}

/** Troca cada segredo achado por `[segredo removido: tipo]` (no idioma da interface). */
export function redactSecrets(text: string, conhecidos: readonly string[] = []): string {
  const findings = scanSecrets(text, conhecidos);
  if (findings.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const finding of findings) {
    out += `${text.slice(cursor, finding.inicio)}${l10n.t('[secret removed: {0}]', finding.tipo)}`;
    cursor = finding.fim;
  }
  return out + text.slice(cursor);
}
