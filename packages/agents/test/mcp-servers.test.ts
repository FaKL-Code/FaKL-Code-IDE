import { describe, expect, it } from 'vitest';

import { prepareMcpServers, type McpServerRef } from '../src/index.js';

const servers: McpServerRef[] = [
  {
    name: 'git',
    command: 'uvx',
    args: ['mcp-server-git', '--repository', '${workspaceFolder}'],
    env: { HOME_COPY: '${userHome}/x' },
  },
  { name: 'context7', command: 'npx', args: ['-y', '@upstash/context7-mcp'], env: {} },
  {
    type: 'http',
    name: 'remoto',
    url: 'https://example.com/${workspaceFolder}',
    headers: { Authorization: 'Bearer abc' },
  },
];

describe('prepareMcpServers', () => {
  it('expande as variáveis do VS Code no diretório do agente', () => {
    const [git, , remoto] = prepareMcpServers(servers, '/repo/wt', 'linux', '/home/u');
    expect(git).toMatchObject({
      command: 'uvx',
      args: ['mcp-server-git', '--repository', '/repo/wt'],
      env: { HOME_COPY: '/home/u/x' },
    });
    expect(remoto).toEqual({
      type: 'http',
      name: 'remoto',
      url: 'https://example.com//repo/wt',
      headers: { Authorization: 'Bearer abc' },
    });
  });

  it('roda os shims .cmd pelo cmd /c só no Windows', () => {
    const windows = prepareMcpServers(servers, 'C:\\repo', 'win32', 'C:\\Users\\u');
    expect(windows[1]).toMatchObject({
      command: 'cmd',
      args: ['/c', 'npx', '-y', '@upstash/context7-mcp'],
    });
    expect(windows[0]).toMatchObject({ command: 'uvx' });
    expect(prepareMcpServers(servers, '/repo', 'darwin')[1]).toMatchObject({ command: 'npx' });
  });
});
