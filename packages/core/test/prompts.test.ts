import { defaultProfiles, localProfile, providerProfiles } from '@fakl/agents';
import type { AgentProfileDefinition } from '@fakl/protocol';
import { describe, expect, it } from 'vitest';

import { chatMaestroPrompt, fallbackProfile, maestroPrompt, profileGuide } from '../src/index.js';

const task = {
  id: 'tarefa-1',
  titulo: 'Implementar recurso',
  repoPath: '/repo',
  status: 'nova' as const,
  criadaEm: '2026-10-13T00:00:00.000Z',
  runs: [],
};

function guideOf(profiles: readonly AgentProfileDefinition[]): string {
  const prompt = maestroPrompt({
    task,
    limits: {},
    branch: 'fakl/tarefa-1',
    base: 'main',
    profiles,
  });
  const section = prompt
    .split('\n\n')
    .find((candidate) => candidate.startsWith('Escolha de perfil e custo:'));
  expect(section).toBeDefined();
  return section ?? '';
}

describe('prompts do maestro', () => {
  it('monta o guia de perfis com os perfis desta máquina, por nível de custo', () => {
    const section = guideOf(defaultProfiles());
    expect(section).toContain('perfil mais barato');
    expect(section).toContain('depois de falha verificada');
    expect(section).toContain('leve (claude-haiku, codex-luna, gemini)');
    expect(section).toContain('padrão (claude, claude-sonnet, codex)');
    expect(section).toContain('pesado (claude-opus)');
    expect(section).toContain('  - claude-opus (Claude): arquitetura');
    expect(section).toContain('reparta entre Claude, Codex, Gemini');
    expect(section).toContain('revisor de provedor diferente do implementador (Claude ↔ Codex)');
  });

  it('só Claude: sem citar outros provedores e revisão com outro perfil dele', () => {
    const section = guideOf(providerProfiles().anthropic);
    expect(section).not.toMatch(/Codex|Gemini|codex|gemini|provedor diferente/);
    expect(section).toContain('Só há um provedor (Claude)');
    expect(section).toContain('perfil diferente do implementador');
  });

  it('só Codex', () => {
    const section = guideOf(providerProfiles().openai);
    expect(section).not.toMatch(/Claude|Gemini|Haiku|Sonnet|Opus/);
    expect(section).toContain('Só há um provedor (Codex)');
    expect(section).toContain('leve (codex-luna) → padrão (codex)');
  });

  it('só Gemini: um perfil, sem revisão cruzada', () => {
    const section = guideOf(providerProfiles().google);
    expect(section).not.toMatch(/Claude|Codex|provedor diferente/);
    expect(section).toContain('Só há um perfil (gemini)');
  });

  it('só modelo local: subtarefas pequenas', () => {
    const section = guideOf([localProfile('ollama', 'qwen2.5-coder')]);
    expect(section).toContain('Só há modelos locais');
    expect(section).toContain('ollama (Ollama)');
  });

  it('dois provedores com modelo local: revisão cruzada e local só para o pequeno', () => {
    const section = guideOf([
      ...providerProfiles().openai,
      ...providerProfiles().google,
      localProfile('lmstudio', 'qwen3'),
    ]);
    expect(section).toContain('(Codex ↔ Gemini)');
    expect(section).toContain('Modelo local (lmstudio) só para tarefas pequenas');
    expect(section).not.toMatch(/Claude|Haiku|Sonnet|Opus/);
  });

  it('nenhum perfil: o maestro trabalha sozinho', () => {
    expect(profileGuide([])).toContain('Não há perfis de agente configurados');
    expect(guideOf([])).not.toContain('spawn_agent com');
  });

  it('inclui o guia no chat maestro com os perfis passados', () => {
    const chat = chatMaestroPrompt(undefined, providerProfiles().google);
    expect(chat).toContain('Escolha de perfil e custo:');
    expect(chat).toContain('Só há um perfil (gemini)');
    expect(chat).not.toMatch(/Claude|Codex/);
    expect(chatMaestroPrompt()).toContain('Escolha de perfil e custo:');
    expect(chatMaestroPrompt()).toContain('- get_resource:');
    expect(chatMaestroPrompt()).not.toContain('docs/catalogo-agentes-skills.md');
  });

  it('com a economia ligada, o maestro da tarefa recebe a orientação dela', () => {
    const context = { task, limits: {}, branch: 'fakl/tarefa-1', base: 'main', profiles: [] };
    const economico = maestroPrompt({ ...context, economia: true });
    expect(economico).toContain('Economia de tokens ligada');
    expect(economico).toContain('um perfil mais barato que o seu');
    expect(economico).toContain('só os comandos que importam');
    expect(maestroPrompt(context)).not.toContain('Economia de tokens ligada');
    // A parte das rodadas é da tarefa: o chat não tem run_checks.
    expect(chatMaestroPrompt(undefined, [], true)).toContain('Economia de tokens ligada');
    expect(chatMaestroPrompt(undefined, [], true)).not.toContain('run_checks');
  });

  it('ensina a ler e alimentar a memória do vault', () => {
    const prompt = maestroPrompt({
      task,
      limits: {},
      branch: 'fakl/tarefa-1',
      base: 'main',
      profiles: [],
    });
    for (const text of [prompt, chatMaestroPrompt()]) {
      expect(text).toContain('Memória (vault)');
      expect(text).toContain('Projetos/<projeto>/ADRs/NNNN-titulo-em-kebab.md');
      expect(text).toContain('Agentes/Memória/');
      expect(text).toContain('## Decisões (ADRs)');
    }
  });
});

describe('fallbackProfile', () => {
  it('usa o sugerido quando existe', () => {
    expect(fallbackProfile(['claude-sonnet'], ['claude', 'claude-sonnet'])).toBe('claude-sonnet');
  });

  it('cai para um parente do sugerido, depois para quem delega', () => {
    expect(fallbackProfile(['claude-sonnet'], ['codex', 'claude'], 'codex')).toBe('claude');
    expect(fallbackProfile(['claude'], ['claude-haiku', 'claude-opus'])).toBe('claude-haiku');
    expect(fallbackProfile(['claude-opus'], ['gemini', 'ollama'], 'ollama')).toBe('ollama');
    expect(fallbackProfile(['claude-opus'], ['gemini'])).toBe('gemini');
    expect(fallbackProfile(['claude-opus'], [])).toBeUndefined();
  });
});
