# Especificação futura: múltiplos projetos na mesma GUI

- Status: proposta para planejamento; não implementada
- Data: 2026-10-13
- Escopo: evolução da IDE após os marcos M1 a M6
- Relacionada a: [SDD](sdd.md), [ADR 0017 — Mesa](adr/0017-mesa-canvas-dos-agentes.md), [ADR 0011 — Café](adr/0011-cyber-cafe-em-canvas-2d.md)

## 1. Objetivo

Permitir que uma única janela da FaKL-Code mantenha vários projetos abertos e ativos ao mesmo tempo. Cada projeto tem seu próprio maestro, agentes, tarefas, Mesa e Café. A pessoa alterna entre projetos dentro da mesma GUI, sem misturar conversas, arquivos, estado visual, execução ou métricas.

Esta proposta amplia o modelo atual, em que a IDE é de um usuário e o workspace aberto concentra o contexto de trabalho. Ela não altera o comportamento atual até ser priorizada e incorporada ao SDD e às decisões de arquitetura.

## 2. Vocabulário

| Termo              | Definição                                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Projeto            | Contexto de trabalho persistente associado a uma ou mais pastas raiz. Tem identidade estável, configuração e estado próprios. |
| Projeto ativo      | Projeto selecionado na GUI. Recebe novas ações de interface e fornece o contexto padrão para comandos.                        |
| Espaço de projeto  | Conjunto isolado de tarefas, execuções, agentes, conversas, permissões, Mesa, Café e métricas de um projeto.                  |
| Maestro do projeto | Maestro responsável por tarefas iniciadas naquele projeto. É uma função dentro do espaço do projeto, não um agente global.    |

## 3. Princípios

1. **Uma GUI, vários espaços.** A IDE apresenta uma única janela e um seletor persistente de projeto. Projetos não abrem janelas obrigatórias adicionais.
2. **Isolamento por padrão.** Ações, dados e ferramentas são vinculados ao projeto ativo. Trocar de projeto nunca transfere contexto implicitamente.
3. **Execuções independentes.** Mudar a seleção não pausa nem encerra agentes de outros projetos. Cada projeto pode ter atividade simultânea.
4. **Componentes próprios por projeto.** Mesa e Café exibem somente agentes e tarefas do projeto selecionado. Cada projeto preserva seu próprio estado de layout e sala.
5. **Sem identidade implícita por caminho.** O projeto tem ID persistente; renomear ou mover a pasta não deve criar outro projeto quando a IDE consegue localizar a pasta novamente.

## 4. Experiência na GUI

### 4.1 Seletor de projetos

- Uma área fixa da interface lista os projetos conhecidos, com nome, estado e indicador de agentes que precisam de atenção.
- Ações disponíveis: selecionar, adicionar projeto por pasta, renomear, remover da lista e revelar a pasta no sistema operacional.
- Remover da lista não apaga arquivos do projeto, histórico nem worktrees.
- O projeto selecionado fica claramente identificado na barra de título e nas superfícies que podem iniciar ações: chat, terminal gerenciado, Mesa, Café, tarefas e comandos da FaKL.
- Ao iniciar a IDE, restaura-se o último projeto ativo e os demais projetos abertos anteriormente. Se um caminho estiver indisponível, o projeto aparece como desconectado e pode ser reconectado.

### 4.2 Mesa

- A Mesa mostra a árvore maestro → agentes, worktrees, notas e cabos apenas do projeto ativo.
- Cada projeto guarda posições, zoom, notas e cabos separadamente.
- Um indicador visível identifica o projeto da Mesa. A troca de projeto troca todo o conjunto exibido sem reatribuir cartões.
- Ações que criam agentes ou tarefas usam exclusivamente o maestro e o contexto do projeto selecionado.

### 4.3 Café

- Cada projeto tem uma sala lógica independente, com seus agentes, PCs, miniaturas, placar e conquistas.
- O Café da GUI mostra a sala do projeto ativo; trocar de projeto troca a sala e o placar exibidos.
- A posição dos avatares e o estado visual da sala persistem por projeto.
- Miniaturas e atualizações em tempo real são solicitadas somente para a sala visível, mantendo o comportamento sob demanda existente.

### 4.4 Atenção entre projetos

- A GUI pode sinalizar que outro projeto tem uma aprovação pendente, agente bloqueado ou resultado pronto para revisão.
- A sinalização contém nome do projeto e quantidade por tipo; não expõe conteúdo de conversa ou arquivos de outro projeto na tela atual.
- Abrir a notificação seleciona o projeto correspondente e leva à entidade que precisa de atenção.

## 5. Requisitos funcionais

| ID     | Requisito                                                                                         | Critério de aceite                                                                                             |
| ------ | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| MP-001 | A IDE deve manter pelo menos dois projetos registrados na mesma janela.                           | Alternar entre dois projetos não abre outra janela e restaura o contexto correto de cada um.                   |
| MP-002 | Cada projeto deve ter ID persistente e caminho(s) raiz próprios.                                  | Reiniciar a IDE restaura a lista; mover um projeto e reconectar preserva seu ID e histórico.                   |
| MP-003 | Cada projeto deve manter maestro, tarefas, execuções, agentes e conversas independentes.          | Agentes e histórico de um projeto não aparecem nas listas ou conversas de outro.                               |
| MP-004 | Cada projeto deve manter Mesa e Café independentes.                                               | Layout, cartões, notas, cabos, avatares, placar e miniaturas correspondem somente ao projeto ativo.            |
| MP-005 | A troca de projeto deve atualizar o contexto das ações da GUI.                                    | Criar tarefa, enviar mensagem, aprovar permissão ou abrir arquivo afeta apenas o projeto selecionado.          |
| MP-006 | Execuções de outros projetos devem continuar em segundo plano após a troca.                       | Um agente ativo continua executando e seus eventos são associados ao projeto de origem.                        |
| MP-007 | A IDE deve oferecer sinalização de atenção entre projetos.                                        | Uma pendência de outro projeto é identificada pelo nome do projeto e leva ao destino correto ao ser aberta.    |
| MP-008 | A API do Core deve exigir ou resolver explicitamente o escopo do projeto em operações de projeto. | Chamadas sem projeto em contexto ambíguo são recusadas com erro acionável, sem escolher um projeto arbitrário. |
| MP-009 | O usuário deve poder remover um projeto da lista sem apagar seus dados.                           | Após remover, pastas, histórico e worktrees continuam intactos; adicionar de novo recupera o contexto.         |
| MP-010 | Uma operação destrutiva de projeto deve mostrar o nome e o escopo afetado antes de confirmar.     | A confirmação distingue remover da lista de apagar dados locais, quando esta última operação existir.          |

## 6. Modelo e limites de isolamento

Entidades persistidas relacionadas ao trabalho devem conter `projectId`, diretamente ou por relação verificável: tarefas, execuções, sessões de agente, eventos, aprovações, worktrees, arquivos de layout da Mesa, estado do Café e métricas. O registro do projeto contém ao menos ID, nome, raízes, estado de conexão e datas de criação/último uso.

Regras:

- Dados sem `projectId` só podem permanecer globais quando forem realmente globais, como perfis reutilizáveis, catálogo de provedores e preferências da IDE. Segredos e credenciais continuam no cofre existente; o escopo de uso deles precisa ser validado para o projeto antes de uma ferramenta executar.
- A pasta de dados local deve separar registros por projeto ou aplicar filtros por `projectId` em todas as consultas. A estratégia física fica para uma ADR.
- Worktrees e branches devem incluir uma identidade de projeto estável ou um identificador de repositório sem colisão, mesmo quando dois projetos apontam para o mesmo repositório.
- Eventos do Core levam `projectId`; assinantes de uma superfície recebem eventos apenas do projeto exibido, exceto o resumo de atenção permitido.
- Ferramentas do maestro, MCP, terminal, vault e integrações recebem o projeto explicitamente. Nenhuma chamada pode inferi-lo de uma seleção anterior armazenada globalmente.
- O escopo de um workspace VS Code com várias raízes deve ser decidido antes da implementação: cada projeto pode ter várias raízes, mas uma raiz não pode pertencer a dois projetos ativos se isso tornar ambíguo o contexto de edição.

## 7. Contratos a definir na implementação

O protocolo local do Core deverá incluir operações de cadastro e seleção de projetos e acrescentar `projectId` às operações e eventos ligados a agentes, execuções, tarefas, Mesa e Café. O Core é a autoridade para validar o projeto e resolver caminhos; a extensão não deve decidir o escopo com base apenas no estado visual do webview.

O app remoto não ganha acesso transversal por padrão. Uma sessão remota deve ser pareada com um projeto selecionado, ou receber uma lista explícita de projetos autorizados. Aprovações e comandos remotos sempre mostram a identidade do projeto antes de afetá-lo.

Migração de dados atuais: registros anteriores à feature devem ser associados ao projeto criado para o workspace existente, com uma migração reversível e sem perda de conversas, tarefas ou posições da Mesa. Registros cuja pasta não puder ser identificada devem permanecer preservados e aparecer como contexto não associado até resolução.

## 8. Requisitos não funcionais

- A troca de projeto não deve reiniciar o Core nem interromper execuções.
- Eventos e consultas devem permanecer responsivos com vários projetos ativos; somente superfícies visíveis atualizam conteúdo visual de alta frequência.
- Fechar a IDE deve preservar os dados e permitir recuperação após falha ou atualização, mantendo as regras de persistência de agentes existentes.
- Logs, notificações e mensagens de erro devem indicar o projeto sem incluir conteúdo privado de outro espaço.
- Operações com caminho validam que a pasta pertence às raízes do projeto antes de ler, gravar, executar comandos ou criar worktrees.

## 9. Cenários de aceite ponta a ponta

1. **Separação básica:** abrir Projetos A e B, criar maestro/agentes em ambos, alternar Mesa e Café e verificar que cada superfície contém apenas seus próprios agentes e estado visual.
2. **Execução simultânea:** iniciar uma execução em A, selecionar B e iniciar outra. Ambas terminam corretamente, e custos, eventos e resultados ficam no projeto de origem.
3. **Aprovação cruzada:** enquanto B está ativo, um agente de A pede permissão. A GUI sinaliza A; a aprovação seleciona A e mostra a ação e o escopo corretos.
4. **Reinício:** com agentes ativos em projetos diferentes, reiniciar a IDE e confirmar que os projetos, execuções retomáveis, conversas, Mesas e Cafés voltam separados.
5. **Remoção e reconexão:** remover um projeto da lista, adicioná-lo novamente e confirmar que o histórico foi preservado. Repetir com a pasta temporariamente indisponível.
6. **Mesmo repositório:** registrar duas configurações de projeto que apontem para o mesmo repositório e confirmar que IDs de sessão, branches e worktrees não colidem nem misturam execução.
7. **Ações sem escopo:** emitir uma chamada de agente sem projeto em contexto ambíguo e confirmar recusa segura, sem encaminhamento ao projeto ativo por acidente.

## 10. Fora de escopo desta proposta

- Colaboração multiusuário, permissões por pessoa ou sincronização de projetos entre máquinas.
- Executar vários projetos em processos Core separados; a proposta assume um Core da IDE que gerencia vários espaços, sujeito a validação de capacidade.
- Uma visão agregada que mistura conversas, agentes ou cenas de Café de projetos diferentes. A GUI pode agregar apenas contagens de atenção explicitamente definidas acima.
- Definir agora a organização física final dos dados ou implementar migrações.

## 11. Decisões necessárias antes do início

1. Se um projeto corresponde a uma pasta, a um repositório Git ou a um conjunto nomeado de pastas raiz.
2. Como identificar projetos que apontam para o mesmo repositório e como separar suas worktrees.
3. Se cada projeto mantém um maestro padrão configurável ou se cada tarefa pode escolher um maestro independente.
4. Se a seleção do projeto vale para toda a janela ou se painéis podem fixar explicitamente um projeto diferente.
5. Quais entidades, além de perfis e preferências da IDE, são compartilháveis entre projetos e quais exigem cópia explícita.
6. Como um projeto é pareado e escopado no controle remoto.

## 12. Fases sugeridas

1. **Fundação:** cadastro e persistência de projetos, IDs estáveis e migração do workspace atual para um projeto.
2. **Escopo do Core:** `projectId` no modelo, API, eventos, tarefas, agentes e worktrees; validação de isolamento.
3. **GUI:** seletor, restauração de contexto, indicação de atenção e troca segura entre projetos.
4. **Mesa e Café:** layouts, cenas, miniaturas e métricas particionados por projeto.
5. **Integrações e remoto:** validar escopo em MCP, vault, GitHub, SSH e app remoto; completar cenários de recuperação e concorrência.
