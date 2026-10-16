import { l10n } from '@fakl/i18n';

import { errorMessage, HttpError, readBody, type FetchLike } from '../http.js';

export const HOSTINGER_API = 'https://developers.hostinger.com';

export interface HostingerVps {
  readonly id: number;
  readonly hostname: string;
  readonly state: string;
  readonly plan?: string;
  readonly cpus?: number;
  readonly memory?: number;
  readonly disk?: number;
  readonly ipv4?: readonly { readonly address: string }[];
  readonly ipv6?: readonly { readonly address: string }[];
  readonly created_at?: string;
}

export interface HostingerAction {
  readonly id: number;
  readonly name: string;
  /** success, error, delayed, sent ou created. */
  readonly state: string;
  readonly created_at?: string;
  readonly updated_at?: string;
}

export interface HostingerSnapshot {
  readonly id: number;
  readonly restore_time?: number;
  readonly created_at: string;
  readonly expires_at?: string;
}

export const FIREWALL_PROTOCOLS = [
  'TCP',
  'UDP',
  'ICMP',
  'ICMPv6',
  'GRE',
  'ESP',
  'AH',
  'any',
  'SSH',
  'HTTP',
  'HTTPS',
  'MySQL',
  'PostgreSQL',
] as const;
export type FirewallProtocol = (typeof FIREWALL_PROTOCOLS)[number];

export interface FirewallRule {
  readonly id: number;
  /** `accept` ou `drop`. */
  readonly action?: string;
  readonly protocol: string;
  /** Porta ou faixa (`8000:8100`); `any` para todas. */
  readonly port?: string;
  /** `any` ou `custom`. */
  readonly source?: string;
  /** IP ou CIDR quando a origem é `custom`. */
  readonly source_detail?: string;
}

export interface FirewallRuleInput {
  readonly protocol: FirewallProtocol;
  readonly port: string;
  readonly source: 'any' | 'custom';
  readonly source_detail: string;
}

export interface HostingerFirewall {
  readonly id: number;
  readonly name: string;
  readonly is_synced?: boolean;
  readonly rules?: readonly FirewallRule[];
  readonly created_at?: string;
  readonly updated_at?: string;
}

export const DNS_TYPES = [
  'A',
  'AAAA',
  'CNAME',
  'ALIAS',
  'MX',
  'TXT',
  'NS',
  'SOA',
  'SRV',
  'CAA',
] as const;
export type DnsType = (typeof DNS_TYPES)[number];

export interface DnsRecordSet {
  /** `@` para a raiz do domínio. */
  readonly name: string;
  readonly type: DnsType;
  readonly ttl?: number;
  readonly records: readonly { readonly content: string; readonly is_disabled?: boolean }[];
}

export interface HostingerDomain {
  readonly id: number;
  readonly domain: string | null;
  readonly type?: string;
  readonly status?: string;
  readonly created_at?: string;
  readonly expires_at?: string | null;
}

export interface HostingerClientOptions {
  readonly token: () => string | undefined;
  readonly fetch?: FetchLike;
  readonly baseUrl?: string;
}

/**
 * Cliente da API pública da Hostinger (SDD 11.3): VPS (estado, reinício,
 * snapshot e ações), zonas DNS e domínios. O token vem do cofre.
 */
export class HostingerClient {
  private readonly fetch: FetchLike;
  private readonly baseUrl: string;

  constructor(private readonly options: HostingerClientOptions) {
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.baseUrl = (options.baseUrl ?? HOSTINGER_API).replace(/\/+$/, '');
  }

  get authenticated(): boolean {
    return Boolean(this.options.token());
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = this.options.token();
    if (!token) throw new HttpError(401, l10n.t('no Hostinger token'));
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': 'FaKL-Code',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await readBody(response);
    if (!response.ok) {
      throw new HttpError(
        response.status,
        `Hostinger ${String(response.status)}: ${errorMessage(data, response.statusText)}`,
        data,
      );
    }
    return data as T;
  }

  vpsList(): Promise<HostingerVps[]> {
    return this.request('GET', '/api/vps/v1/virtual-machines');
  }

  vps(id: number): Promise<HostingerVps> {
    return this.request('GET', `/api/vps/v1/virtual-machines/${String(id)}`);
  }

  restart(id: number): Promise<HostingerAction> {
    return this.request('POST', `/api/vps/v1/virtual-machines/${String(id)}/restart`);
  }

  /** O snapshot atual, se houver (a Hostinger guarda um por VPS). */
  async snapshot(id: number): Promise<HostingerSnapshot | undefined> {
    try {
      const snapshot = await this.request<HostingerSnapshot | null | []>(
        'GET',
        `/api/vps/v1/virtual-machines/${String(id)}/snapshot`,
      );
      return snapshot && !Array.isArray(snapshot) && snapshot.id ? snapshot : undefined;
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return undefined;
      throw error;
    }
  }

  /** Cria um snapshot; substitui o anterior. */
  createSnapshot(id: number): Promise<HostingerAction> {
    return this.request('POST', `/api/vps/v1/virtual-machines/${String(id)}/snapshot`);
  }

  restoreSnapshot(id: number): Promise<HostingerAction> {
    return this.request('POST', `/api/vps/v1/virtual-machines/${String(id)}/snapshot/restore`);
  }

  action(vpsId: number, actionId: number): Promise<HostingerAction> {
    return this.request(
      'GET',
      `/api/vps/v1/virtual-machines/${String(vpsId)}/actions/${String(actionId)}`,
    );
  }

  /** Espera uma ação terminar; devolve o estado final (`success` ou `error`). */
  async waitAction(
    vpsId: number,
    actionId: number,
    options: {
      timeoutMs?: number;
      intervalMs?: number;
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ): Promise<HostingerAction> {
    const sleep =
      options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const interval = options.intervalMs ?? 5_000;
    const attempts = Math.max(1, Math.ceil((options.timeoutMs ?? 15 * 60_000) / interval));
    for (let i = 0; i < attempts; i++) {
      const action = await this.action(vpsId, actionId);
      if (action.state === 'success' || action.state === 'error') return action;
      await sleep(interval);
    }
    throw new HttpError(408, l10n.t('the Hostinger action did not finish in time'));
  }

  /** Firewalls da conta, com as regras de cada um. */
  async firewalls(): Promise<HostingerFirewall[]> {
    const result = await this.request<HostingerFirewall[] | { data?: HostingerFirewall[] }>(
      'GET',
      '/api/vps/v1/firewall',
    );
    return Array.isArray(result) ? result : (result.data ?? []);
  }

  firewall(id: number): Promise<HostingerFirewall> {
    return this.request('GET', `/api/vps/v1/firewall/${String(id)}`);
  }

  createFirewall(name: string): Promise<HostingerFirewall> {
    return this.request('POST', '/api/vps/v1/firewall', { name });
  }

  deleteFirewall(id: number): Promise<unknown> {
    return this.request('DELETE', `/api/vps/v1/firewall/${String(id)}`);
  }

  createFirewallRule(firewallId: number, rule: FirewallRuleInput): Promise<unknown> {
    return this.request('POST', `/api/vps/v1/firewall/${String(firewallId)}/rules`, rule);
  }

  updateFirewallRule(
    firewallId: number,
    ruleId: number,
    rule: FirewallRuleInput,
  ): Promise<unknown> {
    return this.request(
      'PUT',
      `/api/vps/v1/firewall/${String(firewallId)}/rules/${String(ruleId)}`,
      rule,
    );
  }

  deleteFirewallRule(firewallId: number, ruleId: number): Promise<unknown> {
    return this.request(
      'DELETE',
      `/api/vps/v1/firewall/${String(firewallId)}/rules/${String(ruleId)}`,
    );
  }

  /** Liga o firewall a um VPS; um VPS usa um firewall por vez. */
  activateFirewall(firewallId: number, vpsId: number): Promise<HostingerAction> {
    return this.request(
      'POST',
      `/api/vps/v1/firewall/${String(firewallId)}/activate/${String(vpsId)}`,
    );
  }

  deactivateFirewall(firewallId: number, vpsId: number): Promise<HostingerAction> {
    return this.request(
      'POST',
      `/api/vps/v1/firewall/${String(firewallId)}/deactivate/${String(vpsId)}`,
    );
  }

  /** Reaplica as regras do firewall num VPS já ligado a ele. */
  syncFirewall(firewallId: number, vpsId: number): Promise<HostingerAction> {
    return this.request('POST', `/api/vps/v1/firewall/${String(firewallId)}/sync/${String(vpsId)}`);
  }

  dnsRecords(domain: string): Promise<DnsRecordSet[]> {
    return this.request('GET', `/api/dns/v1/zones/${encodeURIComponent(domain)}`);
  }

  /**
   * Cria ou atualiza registros. Com `overwrite`, os registros de mesmo nome e
   * tipo são trocados pelos novos; sem ele, os novos se somam aos que existem.
   */
  updateDns(domain: string, zone: readonly DnsRecordSet[], overwrite = true): Promise<unknown> {
    return this.request('PUT', `/api/dns/v1/zones/${encodeURIComponent(domain)}`, {
      overwrite,
      zone,
    });
  }

  deleteDns(domain: string, filters: readonly { name: string; type: DnsType }[]): Promise<unknown> {
    return this.request('DELETE', `/api/dns/v1/zones/${encodeURIComponent(domain)}`, { filters });
  }

  domains(): Promise<HostingerDomain[]> {
    return this.request('GET', '/api/domains/v1/portfolio');
  }
}

/** Primeiro IPv4 de um VPS, para o gerenciador de SSH. */
export function vpsAddress(vps: HostingerVps): string | undefined {
  return vps.ipv4?.[0]?.address ?? vps.ipv6?.[0]?.address;
}
