import { createMutex, createQueue, createTask, TASK_STATES } from "./core.js";

export const CASES = [
  { id: 1, title: "Scheduling & Starvation", accent: "green" },
  { id: 2, title: "Producer-Consumer Queue", accent: "blue" },
  { id: 3, title: "Priority Inversion", accent: "purple" },
  { id: 4, title: "Deadlock", accent: "red" },
  { id: 5, title: "ADAS Full System", accent: "cyan" },
  { id: 6, title: "Shared Network Driver", accent: "amber" },
];

export const CASE_THEORY = {
  1: {
    setup: "High, Medium, and Low enter the ready set. The priority scheduler selects the highest effective priority on every tick.",
    problem: "When High keeps becoming ready, Low can remain READY for a long time and suffer starvation.",
    fix: "Aging periodically raises the effective priority of waiting tasks. Once Low waits enough, it can preempt High.",
    evidence: "Low first stays amber READY on the Gantt. With aging enabled, it receives a green RUNNING segment.",
  },
  2: {
    setup: "Producer writes every 100ms and Consumer reads every 500ms. Queue capacity is 5 slots.",
    problem: "The producer is faster, so the queue fills. Drop mode loses data; blocking mode moves tasks to wait lists.",
    fix: "Overwrite ring buffer replaces the oldest item with the newest one and keeps the producer moving.",
    evidence: "Queue slots, dropped/overwritten counters, and producer/consumer blocked states are visible in the inspector.",
  },
  3: {
    setup: "Low owns the M_I2C mutex. High requests the same mutex and becomes blocked.",
    problem: "Medium has higher priority than Low and takes the CPU, so High indirectly waits for Medium.",
    fix: "Priority inheritance raises the mutex owner Low to High's effective priority.",
    evidence: "With inheritance enabled, Low runs, Medium remains READY, and High runs after mutex release.",
  },
  4: {
    setup: "Task A owns M_Sensor and Task B owns M_Disk. Then each task requests the other's mutex.",
    problem: "The wait-for graph creates a cycle: Task A -> M_Disk -> Task B -> M_Sensor -> Task A.",
    fix: "Mutex timeout forces a victim task to release resources and breaks the circular wait.",
    evidence: "The deadlock path appears in the banner. After timeout, mutex ownership moves and CPU flow resumes.",
  },
  5: {
    setup: "ISR_Radar fires every 20ms, defers hazard work into Queue_Radar, and exits immediately.",
    problem: "Task_Log can hold Mutex_Brake just before an ISR wakes Task_Compute. A medium-priority monitor can then run while the critical compute task waits behind the low-priority logger.",
    fix: "Priority inheritance raises the Mutex_Brake owner while Task_Compute waits, so the logger releases the brake mutex before medium-priority work can stretch the deadline.",
    evidence: "The ISR spike lane, radar queue depth, compute wakeup, brake mutex owner, and inherited logger priority are visible together.",
  },
  6: {
    setup: "Task_Compute and Task_Log feed Queue_NetHigh and Queue_NetLow into a shared Network Stack Task.",
    problem: "If the Network Stack Task is too low, Queue_NetHigh drops brake packets. If it is too high, Task_Log starves and Queue_NetLow drops log packets.",
    fix: "Network priority and message load tuning place the stack between compute and logging work, so critical packets drain without starving telemetry.",
    evidence: "Separate high/low queue depths, drop counters, and Mutex_Network ownership show the bottleneck.",
  },
};

export function createCaseState(caseId) {
  return {
    time: 0,
    caseId,
    scheduler: caseId === 1 ? "Priority" : "Priority",
    aging: false,
    priorityInheritance: false,
    priorityProtocol: "none",
    deadlockProtocol: caseId === 4 ? "timeout" : "none",
    timeoutEnabled: caseId === 4,
    snapshotMode: false,
    scenarioMode: "Problem",
    simSpeed: 1,
    queueMode: caseId === 2 ? "DROP" : caseId === 6 ? "OVERWRITE" : "BLOCKING",
    producerMs: 100,
    consumerMs: 500,
    networkLoad: 55,
    networkPriority: 2,
    timeoutMs: 3000,
    selectedTaskId: null,
    messageSeq: 1,
    rrCursor: null,
    cpuOwner: "IDLE",
    idleMs: 0,
    readyQueue: [],
    tasks: createTasks(caseId),
    mutexes: createMutexes(caseId),
    queues: createQueues(caseId),
    history: [],
    events: [{ time: 0, message: `Case ${caseId} preset loaded`, kind: "info" }],
    drops: { total: 0, high: 0, low: 0 },
    deadlock: false,
    deadlockPath: [],
    lastAnnotation: null,
  };
}

function createTasks(caseId) {
  if (caseId === 1) {
    return [
      createTask({ id: "H", name: "High", basePriority: 3, state: TASK_STATES.READY, workMs: 3000 }),
      createTask({ id: "M", name: "Medium", basePriority: 2, state: TASK_STATES.READY, workMs: 800 }),
      createTask({ id: "L", name: "Low", basePriority: 1, state: TASK_STATES.READY, workMs: 600 }),
    ];
  }
  if (caseId === 2) {
    return [
      createTask({ id: "P", name: "Producer", basePriority: 2, state: TASK_STATES.READY, workMs: 20 }),
      createTask({ id: "C", name: "Consumer", basePriority: 1, state: TASK_STATES.READY, workMs: 20 }),
    ];
  }
  if (caseId === 3) {
    return [
      createTask({ id: "H", name: "High", basePriority: 3, state: TASK_STATES.READY, workMs: 400, releaseAt: 200 }),
      createTask({ id: "M", name: "Medium", basePriority: 2, state: TASK_STATES.READY, workMs: 900, releaseAt: 300 }),
      createTask({ id: "L", name: "Low", basePriority: 1, state: TASK_STATES.READY, workMs: 1200 }),
    ];
  }
  if (caseId === 4) {
    return [
      createTask({ id: "A", name: "Task A", basePriority: 2, state: TASK_STATES.READY, workMs: 1200 }),
      createTask({ id: "B", name: "Task B", basePriority: 2, state: TASK_STATES.READY, workMs: 1200 }),
    ];
  }
  if (caseId === 5) {
    return [
      createTask({ id: "ISR", name: "ISR_Radar", basePriority: 6, state: TASK_STATES.SLEEP, workMs: 5 }),
      createTask({ id: "CMP", name: "Task_Compute", basePriority: 5, state: TASK_STATES.READY, workMs: 40 }),
      createTask({ id: "MON", name: "Task_Monitor", basePriority: 3, state: TASK_STATES.SLEEP, workMs: 50 }),
      createTask({ id: "LOG", name: "Task_Log", basePriority: 1, state: TASK_STATES.READY, workMs: 80 }),
    ];
  }
  return [
    createTask({ id: "CMP", name: "Task_Compute", basePriority: 4, state: TASK_STATES.READY, workMs: 60 }),
    createTask({ id: "NET", name: "Network Stack", basePriority: 2, state: TASK_STATES.READY, workMs: 80 }),
    createTask({ id: "LOG", name: "Task_Log", basePriority: 1, state: TASK_STATES.READY, workMs: 90 }),
  ];
}

function createMutexes(caseId) {
  if (caseId === 3) return [createMutex({ id: "M_I2C", priorityCeiling: 3 })];
  if (caseId === 4) return [createMutex({ id: "M_Sensor", timeoutMs: 3000 }), createMutex({ id: "M_Disk", timeoutMs: 3000 })];
  if (caseId === 5) return [createMutex({ id: "Mutex_Brake" })];
  if (caseId === 6) return [createMutex({ id: "Mutex_Network" })];
  return [];
}

function createQueues(caseId) {
  if (caseId === 2) return [createQueue({ id: "Q_DATA", capacity: 5, mode: "DROP", initial: [] })];
  if (caseId === 5) return [createQueue({ id: "Queue_Radar", capacity: 6, mode: "BLOCKING", initial: [] })];
  if (caseId === 6) {
    return [
      createQueue({ id: "Queue_NetHigh", capacity: 5, mode: "DROP", initial: ["haz-boot"] }),
      createQueue({ id: "Queue_NetLow", capacity: 6, mode: "DROP", initial: ["log-boot"] }),
    ];
  }
  return [];
}
