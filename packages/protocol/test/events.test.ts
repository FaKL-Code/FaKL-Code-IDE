import { describe, expect, it } from 'vitest';

import { EVENT_TOPICS, isEventTopic, topicMatches } from '../src/index.js';

describe('events', () => {
  it('reconhece os tópicos do SDD', () => {
    expect(isEventTopic('agent.state')).toBe(true);
    expect(isEventTopic('agent.unknown')).toBe(false);
    expect(new Set(EVENT_TOPICS).size).toBe(EVENT_TOPICS.length);
  });

  it('casa padrões exatos, com curinga e globais', () => {
    expect(topicMatches('run.done', 'run.done')).toBe(true);
    expect(topicMatches('run.done', 'run.round')).toBe(false);
    expect(topicMatches('agent.*', 'agent.output')).toBe(true);
    expect(topicMatches('agent.*', 'run.done')).toBe(false);
    expect(topicMatches('*', 'vault.sync')).toBe(true);
  });

  it('não confunde prefixos parecidos', () => {
    expect(topicMatches('run.*', 'remote.device')).toBe(false);
  });
});
