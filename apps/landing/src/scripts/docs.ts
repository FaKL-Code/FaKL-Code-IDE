interface Entrada {
  t: string;
  d: string;
  u: string;
  b: string;
}

const normal = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Menu no celular, busca, botão de copiar e destaque do sumário. */
export function initDocs(): void {
  const menu = document.querySelector<HTMLButtonElement>('[data-docs-menu]');
  const lista = document.querySelector<HTMLElement>('[data-docs-lista]');
  menu?.addEventListener('click', () => {
    const aberto = !(lista?.hasAttribute('data-open') ?? false);
    lista?.toggleAttribute('data-open', aberto);
    menu.setAttribute('aria-expanded', String(aberto));
  });

  const dados = document.getElementById('indice-docs')?.textContent ?? '[]';
  const indice = (JSON.parse(dados) as Entrada[]).map((e) => ({
    ...e,
    n: normal(`${e.t} ${e.d} ${e.b}`),
  }));
  const busca = document.querySelector<HTMLInputElement>('[data-busca]');
  const resultados = document.querySelector<HTMLUListElement>('[data-resultados]');
  busca?.addEventListener('input', () => {
    if (!resultados) return;
    const termos = normal(busca.value).split(/\s+/).filter(Boolean);
    resultados.replaceChildren();
    resultados.hidden = termos.length === 0;
    if (!termos.length) return;
    const achados = indice.filter((e) => termos.every((t) => e.n.includes(t))).slice(0, 6);
    if (!achados.length) {
      const li = document.createElement('li');
      li.className = 'vazio';
      li.textContent = resultados.dataset.vazio ?? '';
      resultados.append(li);
      return;
    }
    for (const e of achados) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = e.u;
      a.textContent = e.t;
      const small = document.createElement('small');
      small.textContent = e.d;
      a.append(small);
      li.append(a);
      resultados.append(li);
    }
  });

  const rotulos = document.querySelector<HTMLElement>('[data-copiar]')?.dataset;
  const copiar = rotulos?.copiar ?? 'copy';
  const copiado = rotulos?.copiado ?? 'copied';
  for (const pre of document.querySelectorAll<HTMLPreElement>('.prosa pre')) {
    const botao = document.createElement('button');
    botao.type = 'button';
    botao.className = 'copiar';
    botao.textContent = copiar;
    botao.addEventListener('click', () => {
      void navigator.clipboard.writeText(pre.querySelector('code')?.innerText ?? '').then(() => {
        botao.textContent = copiado;
        window.setTimeout(() => {
          botao.textContent = copiar;
        }, 1500);
      });
    });
    pre.append(botao);
  }

  const links = new Map<string, HTMLAnchorElement>();
  for (const a of document.querySelectorAll<HTMLAnchorElement>('.docs-toc a')) {
    links.set(a.hash.slice(1), a);
  }
  if (!links.size) return;
  const observador = new IntersectionObserver(
    (entradas) => {
      for (const e of entradas) {
        if (!e.isIntersecting) continue;
        for (const a of links.values()) a.removeAttribute('data-on');
        links.get(e.target.id)?.setAttribute('data-on', '');
      }
    },
    { rootMargin: '0px 0px -70% 0px' },
  );
  for (const id of links.keys()) {
    const h = document.getElementById(id);
    if (h) observador.observe(h);
  }
}
