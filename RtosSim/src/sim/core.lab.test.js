import { describe, expect, it } from 'vitest';
import {
  createMutex, createQueue, createTask, detectDeadlock, lockMutex,
  receiveMessage, sendFromISR, TASK_STATES, unlockMutex,
} from './core.js';

const task = (id, basePriority, state = TASK_STATES.READY) => createTask({ id, name: id, basePriority, state });
const makeState = (tasks, mutexes = [], queues = []) => ({
  time: 0, tasks, mutexes, queues, messageSeq: 1, drops: { total: 0 }, events: [], cpuOwner: 'IDLE',
});
const priority = (state, id) => state.tasks.find((entry) => entry.id === id).effectivePriority;

describe('lab mutex scenarios', () => {
  it('retains only the inheritance still requested by held mutexes', () => {
    const s = makeState([task('L', 1), task('M', 2), task('H', 3)], [createMutex({ id: 'A' }), createMutex({ id: 'B' })]);
    lockMutex(s, 'L', 'A'); lockMutex(s, 'L', 'B');
    lockMutex(s, 'H', 'A', { inheritance: true });
    lockMutex(s, 'M', 'B', { inheritance: true });
    expect(priority(s, 'L')).toBe(3);
    unlockMutex(s, 'L', 'A');
    expect(priority(s, 'L')).toBe(2);
    unlockMutex(s, 'L', 'B');
    expect(priority(s, 'L')).toBe(1);
  });

  it('does not inherit from a waiter that did not request inheritance', () => {
    const s = makeState([task('L', 1), task('H', 3)], [createMutex({ id: 'A' }), createMutex({ id: 'B' })]);
    lockMutex(s, 'L', 'A'); lockMutex(s, 'L', 'B');
    lockMutex(s, 'H', 'A'); unlockMutex(s, 'L', 'B');
    expect(priority(s, 'L')).toBe(1);
  });

  it('propagates through four tasks and terminates on a cycle', () => {
    const s = makeState([task('T1', 1), task('T2', 2), task('T3', 3), task('T4', 4)], ['X', 'Y', 'Z'].map((id) => createMutex({ id })));
    lockMutex(s, 'T1', 'Z'); lockMutex(s, 'T2', 'Y'); lockMutex(s, 'T3', 'X');
    lockMutex(s, 'T2', 'Z', { inheritance: true });
    lockMutex(s, 'T3', 'Y', { inheritance: true });
    lockMutex(s, 'T4', 'X', { inheritance: true });
    expect(s.tasks.map((entry) => entry.effectivePriority)).toEqual([4, 4, 4, 4]);

    const cycle = makeState([task('A', 1), task('B', 3)], [createMutex({ id: 'X' }), createMutex({ id: 'Y' })]);
    lockMutex(cycle, 'A', 'X'); lockMutex(cycle, 'B', 'Y');
    lockMutex(cycle, 'A', 'Y', { inheritance: true });
    lockMutex(cycle, 'B', 'X', { inheritance: true });
    expect(priority(cycle, 'A')).toBe(3);
    expect(detectDeadlock(cycle)).toEqual(['A', 'Y', 'B', 'X', 'A']);
  });

  it('applies the ceiling to a new owner and removes it on release', () => {
    const s = makeState([task('L', 1), task('M', 2)], [createMutex({ id: 'SPI', priorityCeiling: 5 })]);
    lockMutex(s, 'L', 'SPI', { ceiling: true });
    lockMutex(s, 'M', 'SPI', { ceiling: true });
    unlockMutex(s, 'L', 'SPI');
    expect([priority(s, 'L'), priority(s, 'M')]).toEqual([1, 5]);
    unlockMutex(s, 'M', 'SPI');
    expect(priority(s, 'M')).toBe(2);
  });
});

describe('lab ISR scenarios', () => {
  it('drops on a full blocking queue without blocking any task', () => {
    const s = makeState([task('P', 2, TASK_STATES.RUNNING)], [], [createQueue({ id: 'Q', capacity: 1 })]);
    s.cpuOwner = 'P';
    expect(sendFromISR(s, 'Q', 'a').ok).toBe(true);
    expect(sendFromISR(s, 'Q', 'b')).toMatchObject({ ok: false, action: 'dropped', higherPriorityTaskWoken: false });
    expect(s.queues[0].dropped).toBe(1);
    expect(s.queues[0].sendWaiters).toEqual([]);
    expect(s.tasks[0].state).toBe(TASK_STATES.RUNNING);
  });

  it('requests a yield only when a higher priority consumer wakes', () => {
    for (const [runningPriority, consumerPriority, expected] of [[1, 3, true], [4, 1, false]]) {
      const s = makeState([task('RUN', runningPriority, TASK_STATES.RUNNING), task('CONS', consumerPriority)], [], [createQueue({ id: 'Q', capacity: 1 })]);
      s.cpuOwner = 'RUN';
      receiveMessage(s, 'Q', 'CONS');
      expect(sendFromISR(s, 'Q', 'data')).toMatchObject({ ok: true, wokenTaskId: 'CONS', higherPriorityTaskWoken: expected });
      expect(s.cpuOwner).toBe('RUN');
      expect(s.tasks[1].state).toBe(TASK_STATES.READY);
    }
  });
});
