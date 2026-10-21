import { l10n } from '@fakl/i18n';

/**
 * O que o agente precisa saber da interface da IDE para não ficar procurando:
 * um índice curto vai no prompt de toda sessão e o texto de cada tema vem sob
 * demanda, pela ferramenta `ajuda_ide`. Tudo que está no prompt é reenviado a
 * cada requisição, então o índice fica pequeno de propósito.
 */
export interface TemaDoGuia {
  readonly id: string;
  readonly titulo: () => string;
  readonly texto: () => string;
}

export const TEMAS_DO_GUIA: readonly TemaDoGuia[] = [
  {
    id: 'mesa',
    titulo: () => l10n.t('The Desk'),
    texto: () =>
      l10n.t(
        'The Desk is a board where each agent is a card. Open it with "FaKL: Open the Desk". Click the desk to place a new agent, a note or the app preview; drag the desk (or hold Space) to move around; "Arrange as a tree" puts the maestro on top and the subagents below; "Desk in focus" hides the IDE bars. To clean the desk, press "Clear finished" in the side panel (or run "FaKL: Clear finished agents"): it removes the cards of agents that already ended. Agents still working are kept.',
      ),
  },
  {
    id: 'agentes',
    titulo: () => l10n.t('Agents'),
    texto: () =>
      l10n.t(
        'Start an agent with "FaKL: New agent"; talk to it with "FaKL: Open agents chat". Each agent has a profile (provider, model, rules): create or edit them in the Profiles view. In a git repository the agent works in its own worktree and branch, and you review and apply its diff from the chat. Pause, resume or stop it from its menu. If an agent goes in circles (many tool calls, the same call again and again, or too many input tokens in one turn) the IDE pauses it and says why; resuming gives it a fresh turn.',
      ),
  },
  {
    id: 'chaves',
    titulo: () => l10n.t('API keys and providers'),
    texto: () =>
      l10n.t(
        'Agents use your subscription login, or an API key you store with "FaKL: Set API key" (kept in the system keychain; "FaKL: Remove API key" undoes it). A key that only exists in the shell environment does not reach the agents. Gemini works only with an API key (Google AI Studio). "FaKL: Doctor" checks what is missing on this computer and warns when a key is set on the system instead of in the IDE.',
      ),
  },
  {
    id: 'economia',
    titulo: () => l10n.t('Token saving'),
    texto: () =>
      l10n.t(
        'The IDE shortens the answers of its own tools, warns about repeated reads and sends tasks to a cheaper profile when it can. See it in the status bar ("Show token saving") and change the mode with "Change token saving mode" (desligado, equilibrado or agressivo, key `economia` in ~/.fakl/config.yaml). The `freio` key sets the limits per agent turn (tokens, passos, repeticoes); 0 turns one off. Each request resends the whole conversation and all tool definitions, so short chats and few tools cost less.',
      ),
  },
  {
    id: 'vault',
    titulo: () => l10n.t('The vault'),
    texto: () =>
      l10n.t(
        'The vault is the user\'s Markdown notes folder, set up with "FaKL: Set up the vault". Agents read it with vault_search, vault_semantic_search, vault_read and write with vault_write and vault_append_daily. In the IDE: "Search the vault", "Open today\'s note", "New vault note" and the vault graph.',
      ),
  },
  {
    id: 'cafe',
    titulo: () => l10n.t('Café and CI kitchen'),
    texto: () =>
      l10n.t(
        'The cyber café ("FaKL: Open the cyber café") shows what the agents are doing and what they cost. The CI kitchen ("FaKL: Open the CI kitchen") follows the GitHub Actions runs of the repositories chosen with "FaKL: Follow the CI of a repository".',
      ),
  },
  {
    id: 'config',
    titulo: () => l10n.t('Settings and files'),
    texto: () =>
      l10n.t(
        'Settings live in ~/.fakl/config.yaml (profiles in ~/.fakl/profiles, MCP servers in ~/.fakl/mcp.json, data in ~/.fakl/data). "FaKL: Set up" opens the guided setup. Agent worktrees are in ~/.fakl/worktrees. Agents started with no folder open work in ~/FaKL/agentes.',
      ),
  },
];

export function temaDoGuia(id: string): TemaDoGuia | undefined {
  return TEMAS_DO_GUIA.find((tema) => tema.id === id.trim().toLowerCase());
}

/** Índice curto para o prompt de toda sessão; o texto de cada tema vem de `ajuda_ide`. */
export function guiaIndice(comFerramenta = true): string {
  const ids = TEMAS_DO_GUIA.map((tema) => tema.id).join(', ');
  return [
    l10n.t(
      'You are running inside FaKL-Code, an IDE with agents. If the user asks how something in the IDE works (the Desk, agents, keys, vault, café, settings), do not search the web or the file system for it:',
    ),
    comFerramenta
      ? l10n.t('call the ajuda_ide tool with one of these topics: {0}.', ids)
      : l10n.t('read the guide below.'),
  ].join(' ');
}

/** Todos os temas juntos, para o modo conversa (sem ferramentas). */
export function guiaCompleto(): string {
  return TEMAS_DO_GUIA.map((tema) => `${tema.titulo()}: ${tema.texto()}`).join('\n\n');
}

/** Prompt das conversas simples: responder direto, sem ferramentas, com o guia inteiro à mão. */
export function promptDeConversa(): string {
  return [
    l10n.t(
      'This is a plain conversation. Answer directly from what you know. Do not use tools, search the web or read files unless the user explicitly asks you to; if you do not know something, say so instead of searching.',
    ),
    guiaIndice(false),
    guiaCompleto(),
  ].join('\n\n');
}

/** Resposta da ferramenta `ajuda_ide`. */
export function ajudaDaIde(tema: unknown): string {
  if (typeof tema === 'string' && tema.trim() !== '') {
    const achado = temaDoGuia(tema);
    if (achado) return `${achado.titulo()}\n\n${achado.texto()}`;
  }
  return [
    l10n.t('Topics of the IDE guide (call again with one of them):'),
    ...TEMAS_DO_GUIA.map((item) => `- ${item.id}: ${item.titulo()}`),
  ].join('\n');
}

/** Ferramenta de um conjunto: o peso que ela soma em toda requisição do agente. */
export interface FerramentaMedida {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

/** Tokens estimados (4 caracteres por token) das definições de ferramentas, reenviadas a cada requisição. */
export function pesoDasFerramentas(ferramentas: readonly FerramentaMedida[]): {
  readonly ferramentas: number;
  readonly tokens: number;
} {
  const caracteres = ferramentas.reduce(
    (soma, f) => soma + JSON.stringify({ n: f.name, d: f.description, s: f.inputSchema }).length,
    0,
  );
  return { ferramentas: ferramentas.length, tokens: Math.ceil(caracteres / 4) };
}
