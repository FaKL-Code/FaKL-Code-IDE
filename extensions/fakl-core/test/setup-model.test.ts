import { useLocale } from '@fakl/i18n';
import type { ProviderStatus } from '@fakl/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import {
  capRows,
  contextKeys,
  EMPTY_PROGRESS,
  providerCommand,
  providerRows,
  setupProgress,
  setupView,
  stepViews,
  THEME_NAME,
  withStep,
  type SetupSnapshot,
} from '../src/setup-model.js';

const provider = (over: Partial<ProviderStatus> & Pick<ProviderStatus, 'id'>): ProviderStatus => ({
  nome: over.id,
  tipo: 'cli',
  instalado: false,
  chave: false,
  pronto: false,
  perfis: [],
  ...over,
});

const claude = provider({
  id: 'anthropic',
  nome: 'Claude Code',
  instalado: true,
  logado: true,
  modo: 'assinatura',
  pronto: true,
  versao: '2.1.0',
  perfis: ['claude'],
  instalar: 'npm i -g @anthropic-ai/claude-code',
  login: 'claude auth login',
  chaveEnv: 'ANTHROPIC_API_KEY',
});
const codexSemLogin = provider({
  id: 'openai',
  nome: 'Codex',
  instalado: true,
  instalar: 'npm i -g @openai/codex',
  login: 'codex login',
  chaveEnv: 'OPENAI_API_KEY',
});
const geminiAusente = provider({
  id: 'google',
  nome: 'Gemini CLI',
  instalar: 'npm i -g @google/gemini-cli',
  login: 'gemini',
  chaveEnv: 'GEMINI_API_KEY',
});
const ollama = provider({
  id: 'ollama',
  nome: 'Ollama',
  tipo: 'local',
  instalar: 'Instale o Ollama e rode ollama serve',
});

const offline: SetupSnapshot = { conectado: false, cliNoPath: false };
const online: SetupSnapshot = {
  conectado: true,
  tema: 'Default Dark Modern',
  provedores: [claude, codexSemLogin, geminiAusente, ollama],
  permissoes: 'perguntar',
  tetos: { anthropic: { custoUsd: 20 } },
  github: { conectado: false },
  fontes: 0,
  vault: { ativo: false },
  sshHosts: 3,
  hostinger: { conectado: false },
  lovable: 0,
  email: 0,
  remoto: { aparelhos: 0 },
  voz: { configurado: false },
  cliNoPath: false,
};

const byId = (snapshot: SetupSnapshot, progress = EMPTY_PROGRESS) =>
  Object.fromEntries(stepViews(snapshot, progress).map((step) => [step.id, step]));

describe('jornada de configuração', () => {
  it('sem o Core, as etapas que dependem dele ficam indisponíveis e sem botões', () => {
    const steps = byId(offline);
    expect(steps.ia?.estado).toBe('indisponivel');
    expect(steps.ia?.acoes).toEqual([]);
    expect(steps.github?.estado).toBe('indisponivel');
    // Tema, importação, sync e CLI não dependem do Core.
    expect(steps.tema?.estado).toBe('pendente');
    expect(steps.importar?.estado).toBe('pendente');
    expect(steps.sync?.estado).toBe('pendente');
  });

  it('a IA conta como feita com um provedor pronto, qualquer que seja', () => {
    expect(byId(online).ia).toMatchObject({ estado: 'feito', detalhe: '1 ready: Claude Code.' });
    const none = { ...online, provedores: [codexSemLogin, geminiAusente] };
    expect(byId(none).ia).toMatchObject({
      estado: 'pendente',
      detalhe: 'No provider ready yet; the IDE works without AI.',
    });
    const onlyLocal = {
      ...online,
      provedores: [{ ...ollama, pronto: true, modo: 'local' as const }],
    };
    expect(byId(onlyLocal).ia?.estado).toBe('feito');
  });

  it('cada integração lê o estado real', () => {
    const steps = byId({
      ...online,
      github: { conectado: true, usuario: 'ana' },
      vault: { ativo: true, caminho: '~/Vault' },
      fontes: 2,
      remoto: { relay: 'https://relay.exemplo.com', aparelhos: 1 },
      voz: { configurado: true, modo: 'groq' },
      sync: 'ana/fakl-settings',
    });
    expect(steps.github).toMatchObject({ estado: 'feito', detalhe: 'Signed in as ana.' });
    expect(steps.vault?.detalhe).toBe('Vault at ~/Vault.');
    expect(steps.fontes?.estado).toBe('feito');
    expect(steps.ssh).toMatchObject({ estado: 'feito', detalhe: '3 hosts available.' });
    expect(steps.remoto).toMatchObject({
      estado: 'feito',
      detalhe: 'Relay relay.exemplo.com; 1 paired device.',
    });
    expect(steps.remoto?.acoes.map((action) => action.id)).toContain('fakl.remote.pair');
    expect(steps.voz?.detalhe).toBe('Mode: groq.');
    expect(steps.sync?.estado).toBe('feito');
    expect(steps.hostinger?.estado).toBe('pendente');
  });

  it('tema: o FaKL Noite já conta como feito; outro tema, só quando a pessoa confirma', () => {
    expect(byId({ ...online, tema: THEME_NAME }).tema?.estado).toBe('feito');
    expect(byId({ ...online, tema: THEME_NAME }).tema?.acoes.map((a) => a.id)).toEqual([
      'workbench.action.selectTheme',
    ]);
    expect(byId(online).tema?.estado).toBe('pendente');
    expect(byId(online, withStep(EMPTY_PROGRESS, 'feitas', 'tema')).tema?.estado).toBe('feito');
  });

  it('pular marca a etapa; fazer depois tira o pulado', () => {
    const skipped = withStep(EMPTY_PROGRESS, 'puladas', 'github');
    expect(byId(online, skipped).github?.estado).toBe('pulado');
    const done = withStep(skipped, 'feitas', 'importar');
    expect(done.puladas).toEqual(['github']);
    const redone = withStep(withStep(EMPTY_PROGRESS, 'puladas', 'cli'), 'feitas', 'cli');
    expect(redone).toEqual({ puladas: [], feitas: ['cli'] });
    // Uma etapa feita de verdade continua feita mesmo pulada.
    expect(
      byId({ ...online, fontes: 1 }, withStep(EMPTY_PROGRESS, 'puladas', 'fontes')).fontes?.estado,
    ).toBe('feito');
  });

  it('as integrações escolhidas valem no progresso; as essenciais, sempre', () => {
    const progress = { ...EMPTY_PROGRESS, interesses: ['voz' as const] };
    const steps = stepViews(online, progress);
    expect(steps.filter((step) => step.escolhida).map((step) => step.id)).toEqual([
      'idioma',
      'importar',
      'tema',
      'ia',
      'permissoes',
      'voz',
    ]);
    // Só a IA está feita entre as escolhidas.
    expect(setupProgress(steps)).toEqual({ feitas: 1, total: 6 });
  });

  it('provedores: instalar quem falta, login de quem está instalado, chave para os CLIs', () => {
    const rows = Object.fromEntries(
      providerRows(online.provedores ?? []).map((row) => [row.id, row]),
    );
    expect(rows.anthropic?.pronto).toBe(true);
    expect(rows.anthropic?.linha).toContain('subscription');
    expect(rows.anthropic?.acoes.map((a) => a.id)).toEqual(['chave']);
    expect(rows.openai).toMatchObject({ linha: 'installed; sign-in missing' });
    expect(rows.openai?.acoes.map((a) => a.id)).toEqual(['login', 'chave']);
    expect(rows.google?.acoes.map((a) => a.id)).toEqual(['instalar', 'chave']);
    // Servidor local: sem comando, só a instrução.
    expect(rows.ollama).toMatchObject({
      linha: 'local server not found',
      aviso: 'Instale o Ollama e rode ollama serve',
      acoes: [],
    });
    expect(providerCommand(codexSemLogin, 'login')).toBe('codex login');
    expect(providerCommand(geminiAusente, 'instalar')).toBe('npm i -g @google/gemini-cli');
    expect(providerCommand(claude, 'login')).toBeUndefined();
    expect(providerCommand(ollama, 'instalar')).toBeUndefined();
    const withKey = providerRows([{ ...codexSemLogin, chave: true, pronto: true, modo: 'chave' }]);
    expect(withKey[0]?.acoes.map((a) => a.id)).toEqual(['removerChave']);
  });

  it('tetos só para provedores prontos que gastam', () => {
    expect(
      capRows([claude, codexSemLogin, { ...ollama, pronto: true }], {
        anthropic: { custoUsd: 20 },
      }),
    ).toEqual([{ provedor: 'anthropic', nome: 'Claude Code', custoUsd: 20 }]);
  });

  it('a tela leva provedores, permissões e as context keys do walkthrough', () => {
    const view = setupView(online, EMPTY_PROGRESS, 'ia');
    expect(view.abrir).toBe('ia');
    expect(view.interessesEscolhidos).toBe(false);
    expect(view.provedores).toHaveLength(4);
    expect(view.permissoes?.atual).toBe('perguntar');
    expect(view.permissoes?.opcoes.map((o) => o.id)).toEqual([
      'perguntar',
      'aprovar-leitura',
      'aprovar-tudo',
      'autopilot',
    ]);
    const keys = contextKeys(view.etapas);
    expect(keys['fakl.setup.ia']).toBe(true);
    expect(keys['fakl.setup.github']).toBe(false);
    expect(setupView(offline, EMPTY_PROGRESS).provedores).toBeUndefined();
  });

  describe('em português', () => {
    afterEach(() => {
      useLocale('en');
    });

    it('traduz etapas, detalhes e botões pelo catálogo da jornada', () => {
      useLocale('pt-BR');
      const steps = byId(online);
      expect(steps.ia).toMatchObject({
        titulo: 'Provedores de IA',
        detalhe: '1 pronto: Claude Code.',
      });
      expect(steps.idioma?.acoes.map((action) => action.rotulo)).toEqual([
        'Trocar o idioma',
        'Manter English',
      ]);
      expect(providerRows([codexSemLogin])[0]?.linha).toBe('instalado; falta fazer login');
    });

    it('o nome do idioma atual aparece no próprio idioma', () => {
      useLocale('pt-br');
      expect(byId({ ...online, idioma: 'pt-br' }).idioma?.detalhe).toBe(
        'Idioma da interface: Português (Brasil).',
      );
    });
  });
});
