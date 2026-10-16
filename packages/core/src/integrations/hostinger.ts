import {
  DNS_TYPES,
  FIREWALL_PROTOCOLS,
  HostingerClient,
  vpsAddress,
  type DnsRecordSet,
  type DnsType,
  type FetchLike,
  type FirewallRuleInput,
  type HostingerVps,
} from '@fakl/integrations';
import type { HostingerStatus, SshHostInfo } from '@fakl/protocol';
import { l10n } from '@fakl/i18n';

import {
  objectParams,
  RpcError,
  stringParam,
  type CallContext,
  type Router,
} from '../rpc/router.js';
import type { SecretVault } from '../secrets.js';
import { apiError, approveIfAgent, audited, type IntegrationGuards } from './guard.js';
import type { SshService } from './ssh.js';

export interface HostingerServiceOptions extends IntegrationGuards {
  readonly secrets: SecretVault;
  readonly ssh?: SshService;
  readonly fetch?: FetchLike;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: (message: string) => void;
}

const DOMAIN = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

function vpsId(p: Record<string, unknown>): number {
  const value = p.vpsId;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw RpcError.invalidParams(l10n.t('vpsId must be the numeric VPS id'));
  }
  return value;
}

function domainParam(p: Record<string, unknown>): string {
  const domain = stringParam(p, 'dominio').toLowerCase();
  if (!DOMAIN.test(domain)) throw RpcError.invalidParams(l10n.t('invalid domain'));
  return domain;
}

function idParam(p: Record<string, unknown>, key: string): number {
  const value = p[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw RpcError.invalidParams(l10n.t('{0} must be a numeric id', key));
  }
  return value;
}

const PORT = /^(?:any|\d{1,5}(?::\d{1,5})?)$/;
const SOURCE = /^[0-9a-fA-F:.]+(?:\/\d{1,3})?$/;

/** Valida a regra de `hostinger.firewall.rule.upsert`. */
function ruleParam(p: Record<string, unknown>): FirewallRuleInput {
  const protocol = FIREWALL_PROTOCOLS.find(
    (name) => name.toLowerCase() === stringParam(p, 'protocolo').toLowerCase(),
  );
  if (!protocol) {
    throw RpcError.invalidParams(
      l10n.t('protocolo must be one of: {0}', FIREWALL_PROTOCOLS.join(', ')),
    );
  }
  const port = typeof p.porta === 'number' ? String(p.porta) : stringParam(p, 'porta');
  if (!PORT.test(port)) {
    throw RpcError.invalidParams(l10n.t('porta must be a number, a range (8000:8100) or any'));
  }
  const origem = typeof p.origem === 'string' && p.origem ? p.origem : 'any';
  if (origem !== 'any' && !SOURCE.test(origem)) {
    throw RpcError.invalidParams(l10n.t('origem must be any, an IP or a CIDR'));
  }
  return {
    protocol,
    port,
    source: origem === 'any' ? 'any' : 'custom',
    source_detail: origem,
  };
}

function describeRule(rule: FirewallRuleInput): string {
  return l10n.t(
    '{0} port {1} from {2}',
    rule.protocol,
    rule.port,
    rule.source_detail === 'any' ? l10n.t('any source') : rule.source_detail,
  );
}

/** Valida a lista de registros de `hostinger.dns.upsert`. */
function zoneParam(p: Record<string, unknown>): DnsRecordSet[] {
  const zone = p.registros;
  if (!Array.isArray(zone) || zone.length === 0) {
    throw RpcError.invalidParams(l10n.t('registros must be a non-empty list'));
  }
  return zone.map((raw: unknown, i): DnsRecordSet => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const name = typeof r.nome === 'string' && r.nome ? r.nome : undefined;
    const type = typeof r.tipo === 'string' ? r.tipo.toUpperCase() : '';
    const contents = Array.isArray(r.valores)
      ? r.valores.filter((v): v is string => typeof v === 'string' && v !== '')
      : typeof r.valor === 'string' && r.valor
        ? [r.valor]
        : [];
    if (!name || !DNS_TYPES.includes(type as DnsType) || contents.length === 0) {
      throw RpcError.invalidParams(
        l10n.t(
          'record {0}: provide nome, tipo ({1}) and valor',
          String(i + 1),
          DNS_TYPES.join(', '),
        ),
      );
    }
    const ttl = typeof r.ttl === 'number' && r.ttl >= 60 ? Math.floor(r.ttl) : undefined;
    return {
      name,
      type: type as DnsType,
      ...(ttl ? { ttl } : {}),
      records: contents.map((content) => ({ content })),
    };
  });
}

/**
 * Hostinger no Core (SDD 11.3): VPS, DNS e domínios pela API pública, com o
 * token do cofre. Reiniciar e mexer em DNS sempre pedem aprovação quando quem
 * pede é um agente. Os VPS entram no gerenciador de SSH, e um comando de
 * escrita de agente num deles só roda depois de um snapshot pronto (RF-508).
 */
export class HostingerService {
  readonly client: HostingerClient;
  private lastSnapshot = new Map<number, number>();

  constructor(private readonly options: HostingerServiceOptions) {
    this.client = new HostingerClient({
      token: () => options.secrets.get('hostinger.token'),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  async status(): Promise<HostingerStatus> {
    if (!this.client.authenticated) return { conectado: false };
    try {
      await this.vpsList();
      return { conectado: true };
    } catch (error) {
      return { conectado: false, erro: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Lista os VPS e põe os novos no gerenciador de SSH. */
  async vpsList(): Promise<HostingerVps[]> {
    const list = await this.client.vpsList();
    await this.options.ssh
      ?.syncHostinger(
        list.map((vps) => ({ id: vps.id, hostname: vps.hostname, address: vpsAddress(vps) })),
      )
      .catch((error: unknown) => {
        this.options.log?.(l10n.t('could not link the VPSs to SSH: {0}', String(error)));
      });
    return list;
  }

  /**
   * Snapshot antes de um comando de escrita (RF-508). A Hostinger guarda um
   * snapshot por VPS e criar outro substitui o anterior; um snapshot feito há
   * menos de 10 minutos por este Core é reaproveitado, para uma sequência de
   * comandos não refazer o snapshot a cada um.
   */
  async snapshotBeforeWrite(
    host: SshHostInfo,
  ): Promise<{ ok: true; id: string } | { ok: false; motivo: string }> {
    const id = host.hostingerId;
    if (!id) return { ok: false, motivo: l10n.t('the host has no linked Hostinger VPS') };
    if (!this.client.authenticated) return { ok: false, motivo: l10n.t('no Hostinger token') };
    const recent = this.lastSnapshot.get(id);
    if (recent && Date.now() - recent < 10 * 60_000) {
      return { ok: true, id: `vps-${String(id)}@${new Date(recent).toISOString()}` };
    }
    try {
      const action = await this.client.createSnapshot(id);
      const done = await this.client.waitAction(id, action.id, {
        ...(this.options.sleep ? { sleep: this.options.sleep } : {}),
      });
      if (done.state !== 'success')
        return { ok: false, motivo: l10n.t('action {0} ended in {1}', done.name, done.state) };
      const at = Date.now();
      this.lastSnapshot.set(id, at);
      await this.options.audit.record({
        ator: 'core',
        acao: 'hostinger.vps.snapshot',
        alvo: String(id),
        resultado: 'ok',
        detalhes: { motivo: l10n.t('before a command on {0}', host.alias) },
      });
      return { ok: true, id: `vps-${String(id)}@${new Date(at).toISOString()}` };
    } catch (error) {
      return { ok: false, motivo: error instanceof Error ? error.message : String(error) };
    }
  }

  register(router: Router): void {
    const guards: IntegrationGuards = this.options;
    const handle =
      (fn: (p: Record<string, unknown>, context: CallContext) => Promise<unknown>) =>
      async (params: unknown, context: CallContext): Promise<unknown> => {
        if (!this.client.authenticated) {
          throw RpcError.invalidParams(
            l10n.t('no Hostinger token; configure it from the IDE (FaKL: Connect to Hostinger)'),
          );
        }
        try {
          return await fn(params === undefined ? {} : objectParams(params), context);
        } catch (error) {
          throw apiError(error);
        }
      };

    router.register('hostinger.status', () => this.status());
    router.register(
      'hostinger.vps.list',
      handle(async () =>
        (await this.vpsList()).map((vps) => ({
          id: vps.id,
          hostname: vps.hostname,
          estado: vps.state,
          plano: vps.plan,
          ip: vpsAddress(vps),
          cpus: vps.cpus,
          memoriaMb: vps.memory,
          discoMb: vps.disk,
        })),
      ),
    );
    router.register(
      'hostinger.vps.restart',
      handle(async (p, context) => {
        const id = vpsId(p);
        const input = { acao: 'hostinger.vps.restart', alvo: String(id) };
        await approveIfAgent(
          guards,
          context,
          l10n.t('Restart Hostinger VPS {0}', String(id)),
          input,
        );
        return await audited(guards, context, input, () => this.client.restart(id));
      }),
    );
    router.register(
      'hostinger.vps.snapshot',
      handle(async (p, context) => {
        const id = vpsId(p);
        if (p.acao === 'ver' || p.acao === undefined)
          return (await this.client.snapshot(id)) ?? null;
        const restore = p.acao === 'restaurar';
        if (!restore && p.acao !== 'criar')
          throw RpcError.invalidParams(l10n.t('acao must be ver, criar or restaurar'));
        const input = {
          acao: `hostinger.vps.snapshot.${restore ? 'restore' : 'create'}`,
          alvo: String(id),
        };
        await approveIfAgent(
          guards,
          context,
          restore
            ? l10n.t('Restore VPS {0} to the snapshot (undoes everything after it)', String(id))
            : l10n.t('Create snapshot of VPS {0} (replaces the current one)', String(id)),
          input,
        );
        const action = await audited(guards, context, input, () =>
          restore ? this.client.restoreSnapshot(id) : this.client.createSnapshot(id),
        );
        if (!restore) this.lastSnapshot.set(id, Date.now());
        return action;
      }),
    );
    router.register(
      'hostinger.dns.list',
      handle(async (p) => {
        const records = await this.client.dnsRecords(domainParam(p));
        return records.map((r) => ({
          nome: r.name,
          tipo: r.type,
          ttl: r.ttl,
          valores: r.records.map((v) => v.content),
        }));
      }),
    );
    router.register(
      'hostinger.dns.upsert',
      handle(async (p, context) => {
        const domain = domainParam(p);
        const zone = zoneParam(p);
        const overwrite = p.substituir !== false;
        const summary = zone
          .map((r) => `${r.type} ${r.name} → ${r.records.map((v) => v.content).join(', ')}`)
          .join('\n');
        const input = {
          acao: 'hostinger.dns.upsert',
          alvo: domain,
          detalhes: { registros: summary },
        };
        await approveIfAgent(
          guards,
          context,
          l10n.t('Change the DNS of {0}:\n{1}', domain, summary),
          input,
        );
        await audited(guards, context, input, () => this.client.updateDns(domain, zone, overwrite));
        return null;
      }),
    );
    router.register(
      'hostinger.dns.delete',
      handle(async (p, context) => {
        const domain = domainParam(p);
        const name = stringParam(p, 'nome');
        const type = stringParam(p, 'tipo').toUpperCase();
        if (!DNS_TYPES.includes(type as DnsType))
          throw RpcError.invalidParams(l10n.t('invalid type'));
        const input = {
          acao: 'hostinger.dns.delete',
          alvo: domain,
          detalhes: { nome: name, tipo: type },
        };
        await approveIfAgent(
          guards,
          context,
          l10n.t('Delete record {0} {1} of {2}', type, name, domain),
          input,
        );
        await audited(guards, context, input, () =>
          this.client.deleteDns(domain, [{ name, type: type as DnsType }]),
        );
        return null;
      }),
    );
    router.register(
      'hostinger.firewall.list',
      handle(async () =>
        (await this.client.firewalls()).map((f) => ({
          id: f.id,
          nome: f.name,
          sincronizado: f.is_synced,
          regras: (f.rules ?? []).map((r) => ({
            id: r.id,
            acao: r.action,
            protocolo: r.protocol,
            porta: r.port,
            origem: r.source === 'custom' ? r.source_detail : 'any',
          })),
        })),
      ),
    );
    router.register(
      'hostinger.firewall.create',
      handle(async (p, context) => {
        const name = stringParam(p, 'nome');
        const input = { acao: 'hostinger.firewall.create', alvo: name };
        await approveIfAgent(
          guards,
          context,
          l10n.t('Create firewall "{0}" on Hostinger', name),
          input,
        );
        return await audited(guards, context, input, () => this.client.createFirewall(name));
      }),
    );
    router.register(
      'hostinger.firewall.delete',
      handle(async (p, context) => {
        const id = idParam(p, 'firewallId');
        const input = { acao: 'hostinger.firewall.delete', alvo: String(id) };
        await approveIfAgent(
          guards,
          context,
          l10n.t('Delete firewall {0} from Hostinger', String(id)),
          input,
        );
        await audited(guards, context, input, () => this.client.deleteFirewall(id));
        return null;
      }),
    );
    router.register(
      'hostinger.firewall.rule.upsert',
      handle(async (p, context) => {
        const firewallId = idParam(p, 'firewallId');
        const rule = ruleParam(p);
        const ruleId = p.regraId === undefined ? undefined : idParam(p, 'regraId');
        const summary = describeRule(rule);
        const input = {
          acao: 'hostinger.firewall.rule.upsert',
          alvo: String(firewallId),
          detalhes: { regra: summary, ...(ruleId ? { regraId: ruleId } : {}) },
        };
        await approveIfAgent(
          guards,
          context,
          ruleId
            ? l10n.t('Replace rule in firewall {0}: {1}', String(firewallId), summary)
            : l10n.t('Allow in firewall {0}: {1}', String(firewallId), summary),
          input,
        );
        await audited(guards, context, input, () =>
          ruleId
            ? this.client.updateFirewallRule(firewallId, ruleId, rule)
            : this.client.createFirewallRule(firewallId, rule),
        );
        return null;
      }),
    );
    router.register(
      'hostinger.firewall.rule.delete',
      handle(async (p, context) => {
        const firewallId = idParam(p, 'firewallId');
        const ruleId = idParam(p, 'regraId');
        const input = {
          acao: 'hostinger.firewall.rule.delete',
          alvo: String(firewallId),
          detalhes: { regraId: ruleId },
        };
        await approveIfAgent(
          guards,
          context,
          l10n.t('Delete rule {0} from firewall {1}', String(ruleId), String(firewallId)),
          input,
        );
        await audited(guards, context, input, () =>
          this.client.deleteFirewallRule(firewallId, ruleId),
        );
        return null;
      }),
    );
    router.register(
      'hostinger.firewall.attach',
      handle(async (p, context) => {
        const firewallId = idParam(p, 'firewallId');
        const id = vpsId(p);
        const verb = p.acao === undefined ? 'ligar' : p.acao;
        if (verb !== 'ligar' && verb !== 'desligar' && verb !== 'sincronizar') {
          throw RpcError.invalidParams(l10n.t('acao must be ligar, desligar or sincronizar'));
        }
        const input = {
          acao: `hostinger.firewall.${verb}`,
          alvo: String(id),
          detalhes: { firewallId },
        };
        await approveIfAgent(
          guards,
          context,
          verb === 'ligar'
            ? l10n.t('Attach firewall {0} to VPS {1}', String(firewallId), String(id))
            : verb === 'desligar'
              ? l10n.t('Detach firewall {0} from VPS {1}', String(firewallId), String(id))
              : l10n.t('Sync firewall {0} on VPS {1}', String(firewallId), String(id)),
          input,
        );
        return await audited(guards, context, input, () =>
          verb === 'ligar'
            ? this.client.activateFirewall(firewallId, id)
            : verb === 'desligar'
              ? this.client.deactivateFirewall(firewallId, id)
              : this.client.syncFirewall(firewallId, id),
        );
      }),
    );
    router.register(
      'hostinger.domains.list',
      handle(async () =>
        (await this.client.domains()).map((d) => ({
          id: d.id,
          dominio: d.domain,
          tipo: d.type,
          estado: d.status,
          venceEm: d.expires_at,
        })),
      ),
    );
  }
}
