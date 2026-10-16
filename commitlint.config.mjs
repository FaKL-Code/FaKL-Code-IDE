/**
 * Conventional Commits. Os escopos aceitos espelham as áreas do repositório
 * (SDD seção 5.2) para que o changelog agrupe as mudanças por componente.
 * @type {import('@commitlint/types').UserConfig}
 */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      2,
      'always',
      [
        // infraestrutura do repositório
        'repo',
        'deps',
        'ci',
        'release',
        'docs',
        // build da IDE
        'upstream',
        'patches',
        'branding',
        'build',
        // pacotes
        'core',
        'protocol',
        'adapters',
        'mcp-server',
        'cli',
        'settings-sync',
        'ui-kit',
        'integrations',
        'security',
        // extensões embutidas
        'agents',
        'vault',
        'github',
        'remote',
        'cafe',
        'remote-ctl',
        'ssh',
        'hostinger',
        'lovable',
        'settings',
        // apps
        'remote-pwa',
        'relay',
        'voz',
        'landing',
        'i18n',
      ],
    ],
    'subject-case': [0],
  },
};
