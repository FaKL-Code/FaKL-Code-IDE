/**
 * Critério de pronto de um playbook e de uma nota (SDD 9.4 e 9.5). O que a
 * tarefa herda do playbook e o que a nota de origem acrescenta se combinam
 * campo a campo, sem nunca afrouxar o que o playbook exige.
 */

type Plain = Record<string, unknown>;

function isPlain(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function union(first: unknown, second: unknown): unknown {
  // Valor que não é lista segue adiante intacto, para o orquestrador recusar com a mensagem dele.
  if (first !== undefined && !Array.isArray(first)) return first;
  if (second !== undefined && !Array.isArray(second)) return second;
  const merged = [...((first as unknown[] | undefined) ?? [])];
  for (const item of (second as unknown[] | undefined) ?? []) {
    if (!merged.includes(item)) merged.push(item);
  }
  return merged.length > 0 ? merged : undefined;
}

function reviewOf(playbook: unknown, task: unknown): unknown {
  if (playbook === undefined) return task;
  if (task === undefined) return playbook;
  if (!isPlain(playbook) || !isPlain(task)) return task;
  const profile = task.perfil ?? playbook.perfil;
  // Exigir aprovação é o lado conservador: basta um dos dois pedir.
  const approval =
    playbook.exigeAprovacao === true || task.exigeAprovacao === true
      ? true
      : (task.exigeAprovacao ?? playbook.exigeAprovacao);
  return {
    ...(profile !== undefined ? { perfil: profile } : {}),
    ...(approval !== undefined ? { exigeAprovacao: approval } : {}),
  };
}

/**
 * Combina o `criterio` do playbook com o da nota de origem:
 *
 * - `comandos` e `checklist`: união, playbook primeiro, sem repetir. A nota
 *   acrescenta verificações, nunca tira as do playbook.
 * - `revisao.perfil`: o da nota vence, se houver; senão o do playbook.
 * - `revisao.exigeAprovacao`: vale `true` se qualquer um dos dois pedir.
 *
 * Um valor que não é objeto passa adiante sem mexer, e o orquestrador recusa.
 */
export function mergeCriterio(playbook: unknown, nota: unknown): unknown {
  if (playbook === undefined || playbook === null) return nota;
  if (nota === undefined || nota === null) return playbook;
  if (!isPlain(playbook)) return playbook;
  if (!isPlain(nota)) return nota;
  const comandos = union(playbook.comandos, nota.comandos);
  const checklist = union(playbook.checklist, nota.checklist);
  const revisao = reviewOf(playbook.revisao, nota.revisao);
  return {
    ...(comandos !== undefined ? { comandos } : {}),
    ...(checklist !== undefined ? { checklist } : {}),
    ...(revisao !== undefined ? { revisao } : {}),
  };
}
