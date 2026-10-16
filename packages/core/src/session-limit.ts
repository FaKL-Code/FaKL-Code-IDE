import type { AgentRecoveryInfo } from '@fakl/protocol';

/** Sem horário informado, a sondagem automática ocorre no máximo a cada cinco minutos. */
export const UNKNOWN_RESET_MS = 5 * 60_000;
/** Um reset vencido ou outro limite nunca gera uma repetição imediata. */
export const MIN_RESUME_DELAY_MS = 30_000;

function resetTime(message: string, now: number): string | undefined {
  const iso =
    /(?:reset(?:s)?(?:\s+at)?|retry[ -]after)\s*[:=]?\s*(\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d))/i.exec(
      message,
    );
  if (iso?.[1]) {
    const date = Date.parse(iso[1]);
    if (Number.isFinite(date)) return new Date(date).toISOString();
  }
  const epoch = /reset(?:s)?(?:\s+at)?\s*[:=]?\s*(\d{13}|\d{10})\b/i.exec(message)?.[1];
  if (epoch) return new Date(Number(epoch) * (epoch.length === 10 ? 1000 : 1)).toISOString();
  const retry =
    /retry[ -]after\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|s|minutes?|m|hours?|h)?\b/i.exec(
      message,
    );
  if (retry?.[1]) {
    const unit = retry[2]?.toLowerCase() ?? 's';
    const factor =
      unit.startsWith('ms') || unit.startsWith('millisecond')
        ? 1
        : unit.startsWith('m')
          ? 60_000
          : unit.startsWith('h')
            ? 3_600_000
            : 1000;
    const date = now + Number(retry[1]) * factor;
    if (Number.isFinite(date) && date <= 8.64e15) return new Date(date).toISOString();
  }
  const clock = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(([^)]+)\)/i.exec(
    message,
  );
  if (!clock) return undefined;
  let hour = Number(clock[1]);
  const minute = Number(clock[2] ?? 0);
  const meridiem = clock[3]?.toLowerCase();
  if (minute > 59 || (meridiem ? hour < 1 || hour > 12 : hour > 23)) return undefined;
  if (meridiem) hour = (hour % 12) + (meridiem === 'pm' ? 12 : 0);
  try {
    const format = new Intl.DateTimeFormat('en-CA', {
      timeZone: clock[4],
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    const local = (instant: number): number => {
      const parts = new Map(format.formatToParts(instant).map((p) => [p.type, p.value]));
      return Date.UTC(
        Number(parts.get('year')),
        Number(parts.get('month')) - 1,
        Number(parts.get('day')),
        Number(parts.get('hour')),
        Number(parts.get('minute')),
        Number(parts.get('second')),
      );
    };
    const today = new Date(local(now));
    for (let day = 0; day < 2; day++) {
      const target = Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate() + day,
        hour,
        minute,
      );
      let instant = target;
      for (let step = 0; step < 3; step++) instant += target - local(instant);
      if (instant > now) return new Date(instant).toISOString();
    }
  } catch {
    // Zona desconhecida: mantém o limite, sem inventar um horário de reset.
  }
  return undefined;
}

/** Parser sem efeitos colaterais; `now` permite interpretar horários relativos deterministicamente. */
export function parseSessionLimit(
  message: string,
  now = Date.now(),
  source: 'error' | 'message' = 'error',
): AgentRecoveryInfo | undefined {
  const text = message.trim();
  if (text.includes('```') || text.includes('~~~')) return undefined;
  const notice = text.replace(/^(?:(?:API|ACP|RPC|Internal)\s+)?error(?:\s+\d+)?\s*:\s*/i, '');
  const directNotice = /^you(?:(?:'|’)ve| have) (?:hit|reached) your (?:usage )?limit\b/i.test(
    notice,
  );
  if (source === 'message' && !directNotice) return undefined;
  if (
    !directNotice &&
    !/^(?:(?:rate[ _-]?limit|usage[ _-]limit|session limit|quota)[ _\s-]*(?:exceeded|reached|exhausted)\b|rate_limit_error\s*:|resource_exhausted\s*:|(?:429\s*[:-]?\s*)?too many requests\b|insufficient[_ ]quota\b)/i.test(
      notice,
    )
  )
    return undefined;
  const retomarEm = resetTime(notice, now);
  return {
    motivo: 'limite-sessao',
    mensagem: text,
    ...(retomarEm ? { retomarEm } : {}),
    automatica: false,
  };
}
