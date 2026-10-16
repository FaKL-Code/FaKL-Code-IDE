function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Formato de data do Obsidian (YYYY, MM, DD, HH, mm), o suficiente para templates. */
export function formatDate(date: Date, format: string): string {
  return format
    .replace(/YYYY/g, String(date.getFullYear()))
    .replace(/MM/g, pad(date.getMonth() + 1))
    .replace(/DD/g, pad(date.getDate()))
    .replace(/HH/g, pad(date.getHours()))
    .replace(/mm/g, pad(date.getMinutes()));
}

/** Variáveis dos templates do Obsidian: {{title}}, {{date}}, {{time}} e {{date:FORMATO}}. */
export function fillTemplate(text: string, title: string, now = new Date()): string {
  return text.replace(
    /\{\{\s*(title|date|time)(?::([^}]+))?\s*\}\}/g,
    (_m, name: string, format?: string) => {
      if (name === 'title') return title;
      if (name === 'date') return formatDate(now, format?.trim() ?? 'YYYY-MM-DD');
      return formatDate(now, format?.trim() ?? 'HH:mm');
    },
  );
}
