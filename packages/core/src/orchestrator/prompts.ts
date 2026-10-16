import type { AgentProfile } from '@fakl/agents';
import { l10n } from '@fakl/i18n';
import { dirname } from 'node:path';

import {
  isLocalProvider,
  providerName,
  type DoneCriteria,
  type McpResourceSummary,
  type ResourceContent,
  type ResourceInfo,
  type Round,
  type RunLimits,
  type Task,
} from '@fakl/protocol';

import { resourceLine, splitFrontmatter } from '../resources.js';

function criteriaText(criterio: DoneCriteria | undefined): string {
  if (!criterio)
    return l10n.t(
      'No criteria defined: use your judgment and explain in the summary how you verified.',
    );
  const parts: string[] = [];
  if (criterio.comandos?.length) {
    parts.push(
      `${l10n.t('Commands that must exit with code 0:')}\n${criterio.comandos.map((c) => `- \`${c}\``).join('\n')}`,
    );
  }
  if (criterio.checklist?.length) {
    parts.push(`${l10n.t('Checklist:')}\n${criterio.checklist.map((c) => `- ${c}`).join('\n')}`);
  }
  if (criterio.revisao?.perfil) {
    parts.push(
      criterio.revisao.exigeAprovacao
        ? l10n.t(
            'Review: an agent with profile `{0}` and role `revisor` reviews the diff and must approve it.',
            criterio.revisao.perfil,
          )
        : l10n.t(
            'Review: an agent with profile `{0}` and role `revisor` reviews the diff.',
            criterio.revisao.perfil,
          ),
    );
  }
  return parts.join('\n\n') || l10n.t('No criteria defined.');
}

function limitsText(limits: RunLimits): string {
  const lines: string[] = [];
  if (limits.rodadas) lines.push(l10n.t('- rounds: {0}', String(limits.rodadas.valor)));
  if (limits.tempoMin) lines.push(l10n.t('- time: {0} min', String(limits.tempoMin.valor)));
  if (limits.tokens) lines.push(l10n.t('- tokens: {0}', String(limits.tokens.valor)));
  if (limits.custoUsd)
    lines.push(l10n.t('- cost: {0}', l10n.t('${0}', limits.custoUsd.valor.toFixed(2))));
  lines.push(l10n.t('- maximum maestro depth: {0}', String(limits.profundidadeMaxima ?? 2)));
  return lines.join('\n');
}

/** Agentes, skills e servidores MCP instalados na IDE, para o maestro escolher. */
export interface ResourceSummary {
  readonly agents: readonly ResourceInfo[];
  readonly skills: readonly ResourceInfo[];
  readonly mcps?: readonly McpResourceSummary[];
  /** Itens oferecidos pelas fontes de recursos (instalados ou não). */
  readonly disponiveis?: number;
}

function hasResources(resources: ResourceSummary | undefined): resources is ResourceSummary {
  return (
    !!resources &&
    resources.agents.length + resources.skills.length + (resources.mcps?.length ?? 0) > 0
  );
}

/** Sem nada instalado e sem fontes, o maestro não recebe guia nem lista de recursos. */
function knowsResources(resources: ResourceSummary | undefined): boolean {
  return (resources?.disponiveis ?? 0) > 0 || hasResources(resources);
}

/** Níveis de custo (valor do perfil) com o rótulo mostrado ao maestro. */
function tiers(): readonly (readonly [string, string])[] {
  return [
    [l10n.t('light'), 'baixo'],
    [l10n.t('standard'), 'médio'],
    [l10n.t('heavy'), 'alto'],
  ];
}
const GUIDE_PROFILES_MAX = 20;

function isLocal(profile: AgentProfile): boolean {
  return profile.adaptador === 'ollama' || isLocalProvider(profile.provedor);
}

/**
 * Guia de escolha de perfil do maestro, montado com os perfis que existem
 * nesta máquina (ADR 0035): níveis de custo, pontos fortes e como revisar
 * conforme haja um ou mais provedores. Os ids, o custo e a instalação também
 * vêm de list_profiles.
 */
export function profileGuide(profiles: readonly AgentProfile[]): string {
  const title = l10n.t('Profile and cost selection:');
  if (profiles.length === 0) {
    return `${title}\n${l10n.t('- There are no agent profiles configured: do the work yourself, without spawn_agent.')}`;
  }
  const tierList = tiers()
    .map(([label, cost]) => {
      const ids = profiles
        .filter((profile) => (profile.custoRelativo ?? 'médio') === cost)
        .map((profile) => profile.id);
      return ids.length > 0 ? `${label} (${ids.join(', ')})` : '';
    })
    .filter(Boolean);
  const lines = [
    l10n.t(
      '- See ids, cost and installation in list_profiles. Start with the cheapest profile that delivers consistent results and only move up a tier after a verified failure (red test or rejected review): {0}.',
      tierList.join(' → '),
    ),
  ];
  const shown = profiles.slice(0, GUIDE_PROFILES_MAX);
  lines.push(
    `${l10n.t('- Strengths:')}\n${shown
      .map((profile) => {
        const strengths = profile.pontosFortes?.length
          ? `: ${profile.pontosFortes.join(', ')}`
          : '';
        return `  - ${profile.id} (${providerName(profile.provedor)})${strengths}`;
      })
      .join('\n')}${
      profiles.length > shown.length
        ? `\n${l10n.t('  - … {0} more in list_profiles', String(profiles.length - shown.length))}`
        : ''
    }`,
  );
  const providers = [...new Set(profiles.map((profile) => profile.provedor))];
  const names = providers.map(providerName);
  if (providers.length >= 2) {
    lines.push(
      l10n.t(
        '- Routine implementation: split it among {0} so you do not exhaust the quota of just one.',
        names.join(', '),
      ),
      l10n.t(
        '- Use a reviewer from a different provider than the implementer ({0}).',
        names.slice(0, 2).join(' ↔ '),
      ),
    );
  } else if (profiles.length >= 2) {
    lines.push(
      l10n.t(
        '- There is only one provider ({0}): for review, use a profile different from the implementer, preferably one tier up.',
        names[0] ?? '',
      ),
    );
  } else {
    lines.push(
      l10n.t(
        '- There is only one profile ({0}): the review is a subagent of it with the revisor role, or yourself, reading the diff carefully before merging.',
        profiles[0]?.id ?? '',
      ),
    );
  }
  const local = profiles.filter(isLocal);
  if (local.length > 0 && local.length < profiles.length) {
    lines.push(
      l10n.t(
        '- Local model ({0}) only for small tasks or data that cannot leave the machine.',
        local.map((profile) => profile.id).join(', '),
      ),
    );
  } else if (local.length > 0) {
    lines.push(
      l10n.t(
        '- There are only local models: split the work into small, well-defined subtasks, with verifiable done criteria.',
      ),
    );
  }
  return `${title}\n${lines.join('\n')}`;
}

/**
 * Como achar e usar agentes, skills e servidores MCP gastando pouco contexto:
 * a busca devolve poucas linhas e o Core injeta o conteúdo no subagente.
 */
function resourceGuide(): string {
  return [
    l10n.t('Agents, skills and MCP servers:'),
    l10n.t(
      "- Before delegating, call find_resources with the subtask in a few words. It searches the installed ones and the user's resource sources (which work without installing) and returns the most relevant, with tier and suggested profile.",
    ),
    l10n.t(
      '- For the subagent to follow an agent or skill, pass `agente` and `skills` in spawn_agent: the Core injects the content into its instructions, without going through your context. Without profileId, the profile suggested by the agent (or by the first skill) applies.',
    ),
    l10n.t(
      '- get_resource only to read a resource before deciding; do not paste the content into the instructions.',
    ),
    l10n.t(
      '- Installed and ready MCP servers reach every subagent: say in the instructions which one to use. A server that is only in a source, or with a missing secret, only works after the user installs it in the AI Resources tab; ask with ask_human if it is essential.',
    ),
  ].join('\n');
}

/**
 * Como usar e alimentar a memória do vault. O Core já grava a nota da sessão,
 * o devlog e a linha do diário ao fim de cada execução; ADRs e aprendizados
 * dependem do agente.
 */
export function memoryGuide(): string {
  return [
    l10n.t('Memory (vault), when the vault_* tools are available:'),
    l10n.t(
      '- Before planning, read what is already known: vault_search in `pasta:Projetos/<projeto>` (the repository folder name; the search finds the folder in any letter case) and in `pasta:Agentes/Memória`, and vault_read on the index note `Projetos/<projeto>/<projeto>`.',
    ),
    l10n.t(
      '- At the end, the session note, the entry in `Projetos/<projeto>/Devlog` and the line in the daily note are written automatically from the finish summary. Write the summary with them in mind: what changed, why and what is still pending.',
    ),
    l10n.t(
      '- An architecture, technology or process decision becomes an ADR: vault_write to `Projetos/<projeto>/ADRs/NNNN-titulo-em-kebab.md`, numbered after the existing ones, with frontmatter `tipo: adr`, `status: aceita`, `data`, `projeto: "[[<projeto>]]"` and the sections Contexto, Decisão, Consequências and Alternativas. Then put its link in the "## Decisões (ADRs)" section of the index note. If the repository has `docs/adr`, write the ADR there too.',
    ),
    l10n.t(
      '- A durable learning about the user or the project (preference, correction, pitfall) goes in a note in `Agentes/Memória/` with a [[...]] link to the project. Update the existing note instead of creating another.',
    ),
    l10n.t(
      '- Link notes with [[links]]. A note without a link to the project is left loose in the vault.',
    ),
  ].join('\n');
}

/** Versão curta para o chat, que já leva a lista de recursos. */
export function memoryHint(): string {
  return l10n.t(
    'Memory (vault): before changing a project, read `Projetos/<projeto>` and `Agentes/Memória` with vault_search. An architecture decision becomes an ADR in `Projetos/<projeto>/ADRs/NNNN-titulo-em-kebab.md`, linked in the "## Decisões (ADRs)" section of the index note `Projetos/<projeto>/<projeto>`. A durable learning about the user goes in `Agentes/Memória/`. Link notes with [[links]].',
  );
}
const RESOURCE_LIST_MAX = 64;
const MCP_LIST_MAX = 24;

function mcpLine(server: McpResourceSummary): string {
  const line = [server.name, server.categoria, server.description].filter(Boolean).join(' — ');
  const short = line.length > 200 ? `${line.slice(0, 199).trimEnd()}…` : line;
  return server.faltando?.length
    ? l10n.t('{0} (missing secret {1})', short, server.faltando.join(', '))
    : short;
}

/** Lista compacta dos recursos instalados; vazia quando a biblioteca está vazia. */
export function resourcesSection(resources: ResourceSummary | undefined): string {
  if (!hasResources(resources)) return '';
  const parts =
    resources.agents.length + resources.skills.length > 0
      ? [
          (resources.disponiveis ?? 0) > 0
            ? l10n.t(
                'Agents and skills installed in the IDE (there are more in the resource sources: find_resources):',
              )
            : l10n.t('Agents and skills installed in the IDE:'),
        ]
      : [];
  const half = RESOURCE_LIST_MAX / 2;
  let agentCount = Math.min(
    resources.agents.length,
    resources.skills.length > 0 ? half : RESOURCE_LIST_MAX,
  );
  let skillCount = Math.min(
    resources.skills.length,
    resources.agents.length > 0 ? half : RESOURCE_LIST_MAX,
  );
  let remaining = RESOURCE_LIST_MAX - agentCount - skillCount;
  const extraAgents = Math.min(resources.agents.length - agentCount, remaining);
  agentCount += extraAgents;
  remaining -= extraAgents;
  skillCount += Math.min(resources.skills.length - skillCount, remaining);
  const agents = resources.agents.slice(0, agentCount);
  const skills = resources.skills.slice(0, skillCount);
  if (agents.length > 0) {
    parts.push(
      `${l10n.t('Agents:')}\n${agents.map((info) => `- ${resourceLine(info)}`).join('\n')}`,
    );
  }
  if (skills.length > 0) {
    parts.push(
      `${l10n.t('Skills:')}\n${skills.map((info) => `- ${resourceLine(info)}`).join('\n')}`,
    );
  }
  const omitted = resources.agents.length + resources.skills.length - agents.length - skills.length;
  if (omitted > 0) {
    parts.push(l10n.t('… {0} resources omitted to limit the prompt size.', String(omitted)));
  }
  const mcps = resources.mcps ?? [];
  if (mcps.length > 0) {
    const shown = mcps.slice(0, MCP_LIST_MAX);
    const more = mcps.length - shown.length;
    parts.push(
      `${l10n.t('MCP servers installed in the IDE (the ready ones reach every subagent):')}\n${shown
        .map((server) => `- ${mcpLine(server)}`)
        .join('\n')}${more > 0 ? `\n${l10n.t('… {0} servers omitted.', String(more))}` : ''}`,
    );
  }
  return parts.join('\n');
}

export interface MaestroContext {
  readonly task: Task;
  readonly limits: RunLimits;
  readonly branch: string;
  readonly base: string;
  readonly profiles: readonly AgentProfile[];
  /** Rodadas de uma execução anterior (escalada ou retomada). */
  readonly history?: readonly Round[];
  readonly previousSummary?: string;
  /** Seções a mais: integrações disponíveis, projeto Lovable. */
  readonly extra?: readonly string[];
  /** Agentes, skills e servidores MCP instalados na IDE. */
  readonly resources?: ResourceSummary;
}

/** Instruções do maestro (SDD 9.2). */
export function maestroPrompt(context: MaestroContext): string {
  const { task } = context;
  const fixed = Object.entries(task.papeisFixados ?? {});
  const sections = [
    l10n.t('You are the maestro of the task "{0}" in FaKL-Code.', task.titulo),
    task.descricao ? `${l10n.t('Goal:')}\n${task.descricao}` : '',
    [
      l10n.t('You coordinate other agents with the tools of the `fakl` MCP server:'),
      l10n.t(
        '- list_profiles: available profiles, with strengths, cost and whether they are installed;',
      ),
      l10n.t(
        '- spawn_agent: creates a subagent in its own worktree, from your branch (with `agente` and `skills`, it already receives those resources);',
      ),
      l10n.t('- send_message: sends instructions to one of your subagents;'),
      l10n.t(
        '- await_results: waits for subagents to finish their turn and brings back summary, branch, diff and cost;',
      ),
      l10n.t("- review_diff: shows a subagent's full diff;"),
      l10n.t("- merge_work: merges the subagents' branches into your branch;"),
      l10n.t(
        '- run_checks: runs the done criteria in your worktree (without arguments, it counts as a round);',
      ),
      l10n.t('- stop_agent: stops a subagent;'),
      l10n.t(
        '- ask_human: asks the user something and waits for the choice (the recommended one first: in autopilot, it applies immediately);',
      ),
      l10n.t(
        '- find_resources: the most useful agents, skills and MCP servers for a subtask, from the installed ones and the resource sources;',
      ),
      l10n.t('- get_resource: content of an agent or skill;'),
      l10n.t('- finish: ends the task with a verdict and a summary.'),
    ].join('\n'),
    profileGuide(context.profiles),
    knowsResources(context.resources) ? resourceGuide() : '',
    resourcesSection(context.resources),
    [
      l10n.t('How to work:'),
      l10n.t('1. Plan and split the work.'),
      l10n.t(
        '2. Delegate with spawn_agent, with complete instructions: the subagent does not see this conversation.',
      ),
      l10n.t('3. Wait with await_results, review with review_diff and merge with merge_work.'),
      l10n.t(
        '4. Run run_checks. If it fails, fix it yourself or delegate the fix, and run it again.',
      ),
      l10n.t(
        '5. When everything passes, call finish with verdict "sucesso" and a summary of what changed. If it cannot be done, finish with "falha" and the reason.',
      ),
      l10n.t(
        'Small tasks you can do directly in your worktree. Do not push and do not switch branches.',
      ),
    ].join('\n'),
    memoryGuide(),
    task.perfisPermitidos !== undefined
      ? task.perfisPermitidos.length > 0
        ? l10n.t(
            'Models allowed for delegation: {0}. Use only these profiles in spawn_agent.',
            task.perfisPermitidos.join(', '),
          )
        : l10n.t('You have no models allowed for delegation; complete the task directly.')
      : '',
    fixed.length > 0
      ? `${l10n.t('Roles pinned by the user (mandatory):')}\n${fixed.map(([papel, perfil]) => `- ${papel}: ${perfil}`).join('\n')}`
      : '',
    `${l10n.t('Done criteria:')}\n${criteriaText(task.criterio)}`,
    `${l10n.t('Limits for this run:')}\n${limitsText(context.limits)}`,
    `${l10n.t('Repository: {0}', task.repoPath)}\n${l10n.t('Your branch (the task branch): {0}, from {1}.', context.branch, context.base)}`,
    context.history?.length
      ? `${l10n.t('This run continues earlier work. Rounds so far:')}\n${context.history
          .map(
            (round) =>
              `${l10n.t('- round {0}: {1}', String(round.numero), round.veredito ?? l10n.t('no verdict'))}${round.verificacoes
                .filter((check) => !check.ok)
                .map((check) => l10n.t('; failed `{0}`', check.nome))
                .join('')}`,
          )
          .join(
            '\n',
          )}${context.previousSummary ? `\n${l10n.t('Previous summary: {0}', context.previousSummary)}` : ''}`
      : '',
    ...(context.extra ?? []),
  ];
  return sections.filter(Boolean).join('\n\n');
}

/**
 * Instruções de toda sessão do chat (Maestro Mode): ela também chama outros
 * agentes, e o Core abre uma execução implícita no primeiro spawn_agent.
 */
export function chatMaestroPrompt(
  resources?: ResourceSummary,
  profiles: readonly AgentProfile[] = [],
): string {
  return [
    [
      l10n.t(
        'You can call other agents (the profiles from list_profiles) with the tools of the `fakl` MCP server:',
      ),
      l10n.t(
        '- list_profiles: available profiles, with strengths, cost and whether they are installed;',
      ),
      l10n.t(
        '- spawn_agent: creates a subagent in its own worktree, from your branch, and sends it the instructions (with `agente` and `skills`, it already receives those resources);',
      ),
      l10n.t('- send_message: sends more instructions to one of your subagents;'),
      l10n.t(
        '- await_results: waits for subagents to finish their turn and brings back summary, branch, diff and cost;',
      ),
      l10n.t("- review_diff: shows a subagent's full diff;"),
      l10n.t("- merge_work: merges the subagents' branches into your branch;"),
      l10n.t('- stop_agent: stops a subagent;'),
      l10n.t('- ask_human: asks the user something and waits for the choice;'),
      l10n.t(
        '- find_resources: the most useful agents, skills and MCP servers for a subtask, from the installed ones and the resource sources;',
      ),
      l10n.t('- get_resource: content of an agent or skill.'),
      profileGuide(profiles),
      l10n.t(
        'When the user asks you to delegate, split the work, work in parallel or use another agent, use these tools instead of doing everything yourself. The subagent does not see this conversation: give complete instructions. Then wait with await_results, check with review_diff and merge with merge_work. Small tasks you do directly.',
      ),
    ].join('\n'),
    knowsResources(resources) ? resourceGuide() : '',
    resourcesSection(resources),
    memoryHint(),
  ]
    .filter(Boolean)
    .join('\n\n');
}

const RESOURCE_BODY_MAX = 40_000;

/**
 * Agentes e skills escolhidos pelo maestro no spawn_agent, com o corpo inteiro
 * (sem o frontmatter): o subagente segue as instruções sem o maestro colá-las.
 */
export function resourcesBriefing(resources: readonly ResourceContent[]): string {
  return resources
    .map(({ info, content }) => {
      let body = splitFrontmatter(content).body.trim();
      if (body.length > RESOURCE_BODY_MAX) {
        body = `${body.slice(0, RESOURCE_BODY_MAX)}\n\n${l10n.t('… (truncated; the full file is at {0})', info.path)}`;
      }
      const head =
        info.kind === 'agent'
          ? l10n.t('Agent "{0}": act as this specialist and follow its instructions.', info.name)
          : l10n.t(
              'Skill "{0}": follow these instructions. Files it mentions are in {1} (read-only).',
              info.name,
              dirname(info.path),
            );
      return `${head}\n\n${body}`;
    })
    .join('\n\n---\n\n');
}

/** Instruções de um subagente. */
export function workerPrompt(
  task: Task,
  papel: string,
  criterio?: string,
  resources: readonly ResourceContent[] = [],
): string {
  return [
    l10n.t(
      'You are a subagent with the role "{0}" in the task "{1}" of FaKL-Code, coordinated by a maestro.',
      papel,
      task.titulo,
    ),
    l10n.t(
      'Work only in your current directory (your own git worktree). Do not push, do not switch branches and do not touch anything outside it.',
    ),
    papel === 'revisor'
      ? l10n.t(
          'Review the requested code. End your reply with a line "VERDICT: APPROVED" or "VERDICT: REJECTED" and the list of what needs to change.',
        )
      : l10n.t(
          'When you finish, reply with a short summary: what you did, files changed and what is still pending.',
        ),
    criterio ? `${l10n.t('Criteria for this subtask:')}\n${criterio}` : '',
    resourcesBriefing(resources),
  ]
    .filter(Boolean)
    .join('\n\n');
}
