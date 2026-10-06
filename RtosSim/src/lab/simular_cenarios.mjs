import {
  createMutex, createQueue, createTask, detectDeadlock,
  lockMutex, receiveMessage, sendFromISR, TASK_STATES, unlockMutex,
} from '../sim/core.js';

function state(tasks, mutexes = [], queues = []) {
  return { time: 0, tasks, mutexes, queues, messageSeq: 1, drops: { total: 0 }, events: [], cpuOwner: 'IDLE' };
}
const task = (id, priority, status = TASK_STATES.READY) => createTask({ id, name: id, basePriority: priority, state: status });
const priorities = (s) => s.tasks.map((t) => `${t.id}:${t.effectivePriority}${t.state === TASK_STATES.BLOCKED ? 'B' : ''}`).join(' ');
const owners = (s) => s.mutexes.map((m) => `${m.id}:${m.owner ?? '-'}`).join(' ');
function show(s, label, result) {
  console.log(`${label.padEnd(31)} ${priorities(s)} | ${owners(s)}${result ? ` | ${JSON.stringify(result)}` : ''}`);
}

function runMutexCase(name) {
  let s;
  console.log(`\n${name}`);
  if (name === '2A' || name === '2B' || name === '2C') {
    s = state([task('L', 1), task('M', 2), task('H', 3)], [createMutex({ id: 'A' }), createMutex({ id: 'B' })]);
    lockMutex(s, 'L', 'A'); show(s, '1 L trava A');
    lockMutex(s, 'L', 'B'); show(s, '2 L trava B');
    lockMutex(s, 'H', 'A', { inheritance: name !== '2C' }); show(s, '3 H pede A');
    if (name !== '2C') { lockMutex(s, 'M', 'B', { inheritance: true }); show(s, '4 M pede B'); }
    const first = name === '2B' || name === '2C' ? 'B' : 'A';
    const second = first === 'A' ? 'B' : 'A';
    unlockMutex(s, 'L', first); show(s, `5 L libera ${first}`);
    if (name !== '2C') { unlockMutex(s, 'L', second); show(s, `6 L libera ${second}`); }
  } else if (name === '3A') {
    s = state([task('L', 1), task('M', 2), task('H', 3)], [createMutex({ id: 'A' }), createMutex({ id: 'B' })]);
    lockMutex(s, 'L', 'B'); show(s, '1 L trava B');
    lockMutex(s, 'M', 'A'); show(s, '2 M trava A');
    lockMutex(s, 'M', 'B', { inheritance: true }); show(s, '3 M pede B');
    lockMutex(s, 'H', 'A', { inheritance: true }); show(s, '4 H pede A');
  } else if (name === '3B') {
    s = state([task('T1', 1), task('T2', 2), task('T3', 3), task('T4', 4)], ['X', 'Y', 'Z'].map((id) => createMutex({ id })));
    lockMutex(s, 'T1', 'Z'); show(s, '1 T1 trava Z');
    lockMutex(s, 'T2', 'Y'); show(s, '2 T2 trava Y');
    lockMutex(s, 'T3', 'X'); show(s, '3 T3 trava X');
    lockMutex(s, 'T2', 'Z', { inheritance: true }); show(s, '4 T2 pede Z');
    lockMutex(s, 'T3', 'Y', { inheritance: true }); show(s, '5 T3 pede Y');
    lockMutex(s, 'T4', 'X', { inheritance: true }); show(s, '6 T4 pede X');
  } else if (name === '3C') {
    s = state([task('A', 1), task('B', 3)], [createMutex({ id: 'X' }), createMutex({ id: 'Y' })]);
    lockMutex(s, 'A', 'X'); show(s, '1 A trava X');
    lockMutex(s, 'B', 'Y'); show(s, '2 B trava Y');
    lockMutex(s, 'A', 'Y', { inheritance: true }); show(s, '3 A pede Y');
    lockMutex(s, 'B', 'X', { inheritance: true }); show(s, '4 B pede X');
    console.log(`Ciclo: ${detectDeadlock(s)?.join(' -> ') ?? 'nenhum'}`);
  } else if (name === '4A') {
    s = state([task('L', 1), task('M', 2)], [createMutex({ id: 'SPI', priorityCeiling: 5 })]);
    lockMutex(s, 'L', 'SPI', { ceiling: true }); show(s, '1 L trava SPI');
    lockMutex(s, 'M', 'SPI', { ceiling: true }); show(s, '2 M pede SPI');
    unlockMutex(s, 'L', 'SPI'); show(s, '3 L libera SPI');
    unlockMutex(s, 'M', 'SPI'); show(s, '4 M libera SPI');
  }
  return s;
}

function runIsrCase(name) {
  console.log(`\n${name}`);
  if (name === '5A') {
    const s = state([task('P', 2, TASK_STATES.RUNNING)], [], [createQueue({ id: 'Q', capacity: 1 })]);
    s.cpuOwner = 'P';
    show(s, 'ISR envia a', sendFromISR(s, 'Q', 'a'));
    show(s, 'ISR envia b', sendFromISR(s, 'Q', 'b'));
    console.log(`Fila: ${s.queues[0].buffer.map((m) => m.payload).join(', ')}; perdidas: ${s.queues[0].dropped}`);
  } else {
    for (const [label, runningPriority, consumerPriority] of [['1 BG', 1, 3], ['2 CTRL', 4, 1]]) {
      const s = state([task('RUN', runningPriority, TASK_STATES.RUNNING), task('CONS', consumerPriority)], [], [createQueue({ id: 'Q', capacity: 1 })]);
      s.cpuOwner = 'RUN';
      receiveMessage(s, 'Q', 'CONS');
      show(s, label, sendFromISR(s, 'Q', 'dado'));
    }
  }
}

function runSchedule(name) {
  const presets = {
    '1A': [[1, 4, 3], [2, 6, 2], [1, 30, 1]],
    '1B': [[1, 2, 3], [1, 4, 2], [2, 8, 1]],
    '1C': [[2, 4, 3], [3, 6, 2], [1, 30, 1]],
    '1D1': [[2, 4, 2], [3, 10, 3], [1, 30, 1]],
    '1D2': [[2, 4, 3], [3, 10, 2], [1, 30, 1]],
  };
  const rows = presets[name].map(([c, t, p], index) => ({ id: `T${index + 1}`, c, t, p, jobs: [], completed: [] }));
  const gantt = [];
  const misses = [];
  for (let time = 0; time < 50; time++) {
    for (const row of rows) if (time % row.t === 0) {
      if (row.jobs.length) misses.push(`${row.id}@${time}`);
      row.jobs.push({ remaining: row.c });
    }
    const runner = rows.filter((row) => row.jobs.length).sort((a, b) => b.p - a.p || a.t - b.t)[0];
    gantt.push(runner?.id ?? '-');
    if (runner && --runner.jobs[0].remaining === 0) {
      runner.jobs.shift();
      runner.completed.push(time + 1);
    }
  }
  console.log(`\n${name} U=${(rows.reduce((sum, row) => sum + row.c / row.t, 0) * 100).toFixed(1)}%`);
  console.log(`Gantt [0,12): ${gantt.slice(0, 12).join(' ')}`);
  console.log(`Gantt [0,50): ${gantt.join(' ')}`);
  console.log(`Primeira conclusão: ${rows.map((row) => `${row.id}=${row.completed[0] ?? 'nenhuma'}`).join(' ')}; perdas: ${misses.join(', ') || 'nenhuma'}`);
}

const names = ['1A', '1B', '1C', '1D1', '1D2', '2A', '2B', '2C', '3A', '3B', '3C', '4A', '5A', '5B'];
const selected = process.argv[2]?.toUpperCase() ?? 'TODOS';
if (selected !== 'TODOS' && !names.includes(selected)) {
  console.error(`Use: node src/lab/simular_cenarios.mjs <${names.join('|')}|todos>`);
  process.exitCode = 1;
} else {
  for (const name of selected === 'TODOS' ? names : [selected]) {
    if (name.startsWith('1')) runSchedule(name);
    else if (name.startsWith('5')) runIsrCase(name);
    else runMutexCase(name);
  }
}
