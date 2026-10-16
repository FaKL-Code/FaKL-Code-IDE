import { describe, expect, it } from 'vitest';

import { classifyCommand, parseSshConfig, policyVerdict } from '../src/index.js';

describe('parseSshConfig', () => {
  it('lê hosts exatos, ignora curingas e Match, e guarda os Include', () => {
    const parsed = parseSshConfig(`
# comentário
Include config.d/*
Host *
  User padrao
Host vps prod-1
  HostName 203.0.113.10
  User deploy
  Port 2222
  IdentityFile ~/.ssh/id_ed25519
Host jump
  HostName=jump.example.com
  ProxyJump bastion
Match host vps
  User outro
Host vps
  User ignorado
`);
    expect(parsed.includes).toEqual(['config.d/*']);
    expect(parsed.hosts).toEqual([
      {
        alias: 'vps',
        hostname: '203.0.113.10',
        user: 'deploy',
        port: 2222,
        identityFile: '~/.ssh/id_ed25519',
      },
      {
        alias: 'prod-1',
        hostname: '203.0.113.10',
        user: 'deploy',
        port: 2222,
        identityFile: '~/.ssh/id_ed25519',
      },
      { alias: 'jump', hostname: 'jump.example.com', proxyJump: 'bastion' },
    ]);
  });
});

describe('classifyCommand', () => {
  it.each([
    'ls -la /var/www',
    'tail -n 100 /var/log/nginx/error.log',
    'journalctl -u app --since today | grep ERROR',
    'docker ps -a',
    'docker compose logs --tail 50 web',
    'systemctl status nginx',
    'df -h && free -m',
    'cat /etc/os-release 2>&1',
    'grep -r foo . > /dev/null',
  ])('leitura: %s', (command) => {
    expect(classifyCommand(command)).toBe('leitura');
  });

  it.each([
    'systemctl restart nginx',
    'sudo cat /etc/shadow',
    'echo oi > /etc/motd',
    'ls $(rm x)',
    'cat `id`',
    'docker compose up -d',
    'npm install',
    'find . -name "*.log" -delete',
    'curl -X POST https://example.com',
    'git pull',
  ])('escrita: %s', (command) => {
    expect(classifyCommand(command)).toBe('escrita');
  });

  it.each([
    'rm -rf /var/www/app',
    'sudo reboot',
    'psql -c "DROP TABLE users"',
    'git push --force origin main',
    'docker system prune -af',
    'dd if=/dev/zero of=/dev/sda',
    'kubectl delete pod x',
  ])('destrutivo: %s', (command) => {
    expect(classifyCommand(command)).toBe('destrutivo');
  });
});

describe('policyVerdict', () => {
  it('aplica a tabela do SDD 11.2', () => {
    expect(policyVerdict('livre', 'escrita')).toBe('executar');
    expect(policyVerdict('livre', 'destrutivo')).toBe('confirmar');
    expect(policyVerdict('leitura', 'leitura')).toBe('executar');
    expect(policyVerdict('leitura', 'escrita')).toBe('confirmar');
    expect(policyVerdict('confirmar', 'leitura')).toBe('confirmar');
    expect(policyVerdict('bloqueado', 'leitura')).toBe('recusar');
  });
});
