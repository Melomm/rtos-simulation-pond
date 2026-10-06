# Respostas - Cenários para simular (RTOS)

Comandos, a partir de `RtosSim/`:

```bash
node src/lab/simular_cenarios.mjs todos
node src/lab/simular_cenarios.mjs 2A
npm test
npm run build
```

O script usa as funções de `src/sim/core.js`. Nos cenários 1, um tick é uma unidade de tempo; o intervalo `[a,b)` inclui `a` e exclui `b`. A tarefa fantasma dos cenários 1A, 1C e 1D conta na utilização exibida. As tabelas de prioridade abaixo separam o comportamento **original** do motor, que o roteiro chama de teste vermelho, do resultado **corrigido** neste projeto.

O PDF salta da questão 14 para a 16; não há enunciado de questão 15.

## Parte 1 - Escalonamento

| Cenário | Utilização real | Exibida | Gantt de 0 a 12 (`–` = ociosa) | Primeira perda |
| --- | ---: | ---: | --- | --- |
| 1A | 58,33% | 61,67% ≈ 62% | 1 2 2 3 1 – 2 2 1 – – – | Nenhuma |
| 1B | 100% | 100% | 1 2 1 3 1 2 1 3 1 2 1 3 | Nenhuma |
| 1C | 100% | 103,33% ≈ 103% | 1 1 2 2 1 1 2 2 1 1 2 2 | Task 2 em `t=6` |
| 1D, configuração 1 | 80% | 83,33% ≈ 83% | 2 2 2 1 1 1 1 3 1 1 2 2 | Task 1 em `t=4` |
| 1D, configuração 2 | 80% | 83,33% ≈ 83% | 1 1 2 2 1 1 2 3 1 1 2 2 | Nenhuma até `t=50` |

**1.** Em 1A, `1/4 + 2/6 = 7/12 = 58,33%` para as duas tarefas reais. A interface mostra cerca de 62%, pois soma `1/30 = 3,33%` da fantasma.

**2.** O primeiro job da Task 2 termina em `t=3` (executa em `[1,3)`). Seu tempo de resposta é 3 ticks, dentro do prazo de 6.

**3.** A CPU fica ociosa em `[5,6)`, `[9,10)`, `[10,11)` e `[11,12)`.

**4.** Em 1B, `1/2 + 1/4 + 2/8 = 100%`. O card mostra **Schedulable**: não há perda de prazo.

**5.** O primeiro job da Task 3 termina em `t=8`, exatamente no prazo; a folga é zero.

**6.** Os períodos 2, 4 e 8 são harmônicos: cada um divide o seguinte.

**7.** Em 1C, a Task 2 roda só 2 ticks antes de `t=6`, embora precise de 3. A primeira perda é em `t=6`.

**8.** Em 1B, os períodos harmônicos alinham as liberações e cada job termina no prazo. Em 1C, a Task 1 preempta a Task 2 em `t=4`; os períodos 4 e 6 criam uma interferência que adia o primeiro job da Task 2 até depois do prazo. A fantasma ainda leva a utilização exibida acima de 100%.

**9.** A fantasma de 1C não recebe CPU nos 50 ticks. Trabalho de prioridade menor pode sofrer starvation quando as tarefas superiores ocupam toda a capacidade.

**10.** A Task 2 volta a perder prazo em `t=18`, `30` e `42`: o padrão se repete a cada 12 ticks. O simulador carrega o trabalho atrasado para a liberação seguinte, em vez de descartá-lo.

**11.** Na primeira configuração de 1D, a Task 1 perde o prazo em `t=4`. A Task 2, de maior prioridade, ocupou `[0,3)`, deixando só um tick para a Task 1 antes desse prazo.

**12.** Na segunda configuração, nenhuma tarefa perde prazo nos 50 ticks.

**13.** A regra é atribuir prioridade maior à tarefa de período menor (*rate monotonic*): Task 1 (`T=4`) antes de Task 2 (`T=10`).

**14.** Não há contradição. O limite de Liu & Layland para três tarefas é aproximadamente 77,98% e é um teste **suficiente**, não necessário. Um conjunto acima dele ainda pode ser escalonável; a configuração 2, com 83,33% incluindo a fantasma, é um exemplo.

## Parte 2 - Herança de prioridade

**16.** Sem herança, Med (prioridade 2) roda depois de acordar. Low (1) não consegue liberar o I2C, prolongando a espera de High (3): inversão de prioridade.

**17.** Com herança, Low sobe temporariamente de 1 para 3 quando High bloqueia no I2C; assim pode rodar e liberá-lo.

| Cenário e passo | Previsão correta para L | Motor original | Motor corrigido |
| --- | ---: | ---: | ---: |
| 2A, H pede A | 3 | 3 | 3 |
| 2A, M pede B | 3 | 3 | 3 |
| 2A, L libera A | 2 | 1 | 2 |
| 2A, L libera B | 1 | 1 | 1 |
| 2B, L libera B | 3 | 1 | 3 |
| 2B, L libera A | 1 | 1 | 1 |
| 2C, H pede A sem herança | 1 | 1 | 1 |
| 2C, L libera B | 1 | 1 | 1 |

**18.** Em 2A, M ainda espera por B; L deve conservar a prioridade 2 até liberar B.

**19.** O motor original baixava L para 1 ao liberar A. H, agora desbloqueada e com prioridade 3, pode tomar a CPU; uma tarefa independente de prioridade 2 também pode atrasar L e, portanto, M. É a mesma forma de inversão do aquecimento, agora afetando M.

**20.** Em 2B, H ainda espera por A; L deve manter 3. O motor original mostrava 1; o corrigido mantém 3.

**21.** O erro é mais grave em 2B, porque a tarefa de maior prioridade, H, continua bloqueada enquanto L perde a prioridade herdada.

**22.** Em 2C, L não herdar nada está certo: H pediu A sem o protocolo. O simples fato de esperar por um mutex não autoriza herança neste cenário.

**23.** A correção ingênua elevaria L para 3 em 2C, incorretamente. É necessário registrar, **para cada espera**, se ela pediu herança; `inheritanceWaiters` guarda essa informação.

## Parte 3 - Cadeias de bloqueio

**24.** Em 3A, M espera B e H espera A. L é a única das três que pode rodar para liberar B e começar a destravar a cadeia.

**25.** L deve receber 3 por propagação de `H → M → L`. Uma tarefa externa de prioridade 2 não a preempta. O motor original deixava L em 2; o corrigido dá 3.

**26.** `T4 → X → T3 → Y → T2 → Z → T1`, alternando tarefa que espera, mutex e seu dono.

**27.** No motor original, as prioridades finais eram `T1=2, T2=3, T3=4, T4=4`: a herança avançava só **um elo** em cada pedido e não atualizava os donos anteriores. As quatro devem terminar com prioridade 4; é o resultado corrigido.

**28.** Em 3C, `detectDeadlock` encontra `A → Y → B → X → A`.

**29.** Não. Embora A suba para prioridade 3, A e B permanecem bloqueadas, cada uma esperando um mutex da outra. Prioridade não libera recursos.

**30.** Uma propagação recursiva ingênua poderia percorrer o ciclo indefinidamente. A implementação corrigida parte das prioridades base/teto e limita as varreduras ao número de tarefas, encerrando antes se chegar a um ponto fixo; outra solução seria registrar nós visitados.

**31.** Na interface, o timeout escolhe Task B como vítima e libera `M_Disk`, quebrando a espera circular. B perde a posse do recurso e pode precisar desfazer trabalho parcial e recomeçar sua operação; numa aplicação real, a consistência dos dados requer tratamento explícito.

## Parte 4 - Teto de prioridade

| Passo de 4A | Previsão L / M | Motor original | Motor corrigido |
| --- | --- | --- | --- |
| L trava SPI | 5 / 2 | 5 / 2 | 5 / 2 |
| L libera SPI; posse passa a M | 1 / 5 | 1 / 2 | 1 / 5 |
| M libera SPI | 1 / 2 | 1 / 2 | 1 / 2 |

**32.** O teto eleva imediatamente a prioridade efetiva de quem segura SPI para 5, limitando a interferência de outras tarefas durante a seção crítica.

**33.** O motor original deixou M em 2 após a transferência, violando o teto. O corrigido dá 5 enquanto M possui SPI.

**34.** Antes da correção, uma tarefa de prioridade 4 poderia interromper M (2). Com M no teto 5, não poderia.

## Parte 5 - Interrupções e filas

**35.** A ISR apenas entrega o dado à `Queue_Radar`; `Task_Compute` processa o risco depois. Isso mantém a interrupção curta e transfere trabalho mais demorado para contexto de tarefa.

**36.** O motor original respondeu `blocked` ao segundo envio em 5A, embora não houvesse tarefa para bloquear. Uma ISR é a rotina invocada por uma interrupção de hardware e não pode esperar por espaço na fila. `sendFromISR` agora retorna `dropped`, registra uma perda e deixa P rodando.

**37.** Em FreeRTOS usa-se `xQueueSendFromISR()` (ou a variante `xQueueSendToBackFromISR()`). Com a fila cheia, a chamada retorna `errQUEUE_FULL` imediatamente. Veja o [manual de filas do FreeRTOS](https://www.freertos.org/media/2018/161204_Mastering_the_FreeRTOS_Real_Time_Kernel-A_Hands-On_Tutorial_Guide.pdf).

**38.** Conte os retornos de fila cheia/overflow em um contador observável, publique a métrica e monitore alarmes ou logs. O simulador agora incrementa `queue.dropped` e `state.drops.total` nesse caso.

**39.** Só na situação 1: CONS (3) acorda com prioridade maior que BG (1), então a saída da ISR deve solicitar troca. Na situação 2, CONS (1) é inferior a CTRL (4), que deve continuar.

**40.** O `sendMessage` original devolvia `queued` e a mensagem nas duas situações; não devolvia se a tarefa acordada era mais prioritária. O `sendFromISR` corrigido devolve `higherPriorityTaskWoken: true` apenas na situação 1.

**41.** `pxHigherPriorityTaskWoken` sinaliza ao código da ISR a necessidade de escalonar na saída, por exemplo via `portYIELD_FROM_ISR`. A ISR termina seu tratamento antes de o processador voltar ao contexto de tarefa. Veja a [explicação da API de ISR do FreeRTOS](https://www.freertos.org/media/2018/161204_Mastering_the_FreeRTOS_Real_Time_Kernel-A_Hands-On_Tutorial_Guide.pdf).

**42.** Saída do cenário **2A** antes e depois da correção (trecho relevante):

```text
ANTES
4 M pede B       L:3 M:2B H:3B | A:L B:L
5 L libera A     L:1 M:2B H:3  | A:H B:L
6 L libera B     L:1 M:2  H:3  | A:H B:M

DEPOIS
4 M pede B       L:3 M:2B H:3B | A:L B:L
5 L libera A     L:2 M:2B H:3  | A:H B:L
6 L libera B     L:1 M:2  H:3  | A:H B:M
```

Depois da correção, L mantém prioridade 2 no passo 5 porque M ainda espera por B. Quando L libera B no passo 6, não resta espera com herança sobre mutex que L possua, então ela volta à prioridade base 1.

### Nota sobre a comparação com FreeRTOS

O motor deste projeto implementa herança completa por cadeia para os cenários do laboratório. Isso é uma escolha didática do simulador: a [documentação atual do FreeRTOS](https://freertos.org/Real-time-embedded-RTOS-mutexes.html) descreve uma implementação simplificada para múltiplos mutexes, cujo comportamento não deve ser confundido com o deste motor.
