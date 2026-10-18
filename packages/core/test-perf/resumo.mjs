// Lê as linhas JSON de FAKL_PERF_OUT e imprime uma tabela Markdown por teste,
// para o resumo do job (`$GITHUB_STEP_SUMMARY`) do workflow de desempenho.
import { readFileSync } from 'node:fs';

const arquivo = process.argv[2];
const linhas = readFileSync(arquivo, 'utf8').split('\n').filter(Boolean);
const porTeste = new Map();
for (const linha of linhas) {
  const medida = JSON.parse(linha);
  porTeste.set(medida.teste, [...(porTeste.get(medida.teste) ?? []), medida]);
}
for (const [teste, medidas] of porTeste) {
  console.log(`### ${teste}\n`);
  for (const medida of medidas) {
    console.log(`Plataforma: ${medida.plataforma}\n`);
    console.log('| Medida | Valor |\n| --- | --- |');
    for (const [chave, valor] of Object.entries(medida)) {
      if (chave !== 'teste' && chave !== 'plataforma') console.log(`| ${chave} | ${valor} |`);
    }
    console.log('');
  }
}
