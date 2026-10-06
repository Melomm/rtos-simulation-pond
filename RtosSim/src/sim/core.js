export const TICK_MS = 10;
export const QUANTUM_MS = 500;

export const TASK_STATES = {
  RUNNING: "RUNNING",
  READY: "READY",
  BLOCKED: "BLOCKED",
  SLEEP: "SLEEP",
  ISR: "ISR",
  IDLE: "IDLE",
};

export function createTask({
  id,
  name,
  basePriority,
  state = TASK_STATES.READY,
  workMs = 100,
  periodMs = null,
  releaseAt = 0,
}) {
  return {
    id,
    name,
    basePriority,
    effectivePriority: basePriority,
    currentPriority: basePriority,
    state,
    workMs,
    remainingExec: workMs,
    periodMs,
    releaseAt,
    waitingMs: 0,
    agingCounter: 0,
    lastPriority: basePriority,
    waitingFor: null,
    waitingOnQueue: null,
    ownedMutexes: [],
    cpuMs: 0,
    blockedMs: 0,
    readyMs: 0,
    quantumUsed: 0,
    starvation: false,
  };
}

export function clone(value) {
  return structuredClone(value);
}

export function getTask(state, taskId) {
  return state.tasks.find((task) => task.id === taskId);
}

export function getMutex(state, mutexId) {
  return state.mutexes.find((mutex) => mutex.id === mutexId);
}

export function getQueue(state, queueId) {
  return state.queues.find((queue) => queue.id === queueId);
}

export function addEvent(state, message, kind = "info") {
  state.events.push({ time: state.time, message, kind });
  state.events = state.events.slice(-10);
  state.lastAnnotation = { time: state.time, message, kind };
}

export function createQueue({ id, capacity, mode = "BLOCKING", initial = [] }) {
  return {
    id,
    capacity,
    mode,
    buffer: initial.map((payload, index) => createMessage(payload, "preset", index)),
    head: 0,
    tail: initial.length % capacity,
    sendWaiters: [],
    receiveWaiters: [],
    lastAction: "Queue initialized",
    dropped: 0,
    overwritten: 0,
    sent: 0,
    received: 0,
    totalWaitMs: 0,
    lastChangedIndex: null,
    lastActionType: null,
  };
}

export function createMessage(payload, source, sequence, priority = 1) {
  return {
    id: `${source}-${sequence}`,
    payload,
    source,
    priority,
    createdAt: 0,
  };
}

export function sendMessage(state, queueId, taskId, payload, options = {}) {
  const queue = getQueue(state, queueId);
  const task = taskId ? getTask(state, taskId) : null;
  const message = {
    ...createMessage(payload, taskId ?? "ISR", state.messageSeq++, options.priority ?? 1),
    createdAt: state.time,
  };

  if (queue.buffer.length < queue.capacity) {
    queue.buffer.push(message);
    queue.tail = (queue.tail + 1) % queue.capacity;
    queue.sent += 1;
    queue.lastAction = `${message.payload} queued`;
    queue.lastChangedIndex = queue.buffer.length - 1;
    queue.lastActionType = "queued";
    const wokenTask = wakeReceiver(state, queue);
    return { ok: true, action: "queued", message, wokenTaskId: wokenTask?.id ?? null };
  }

  if (queue.mode === "DROP" || (!task && queue.mode === "BLOCKING")) {
    queue.dropped += 1;
    state.drops.total += 1;
    queue.lastAction = `DROP ${message.payload}: queue full`;
    queue.lastChangedIndex = null;
    queue.lastActionType = "dropped";
    return { ok: false, action: "dropped", message };
  }

  if (queue.mode === "OVERWRITE") {
    const removed = queue.buffer.shift();
    queue.buffer.push(message);
    queue.head = (queue.head + 1) % queue.capacity;
    queue.tail = (queue.tail + 1) % queue.capacity;
    queue.overwritten += 1;
    queue.lastAction = `Overwrite ${removed.payload} -> ${message.payload}`;
    queue.lastChangedIndex = queue.capacity - 1;
    queue.lastActionType = "overwritten";
    return { ok: true, action: "overwritten", message, removed };
  }

  if (task) {
    blockTask(task, `queue:${queue.id}:send`);
    task.waitingOnQueue = queue.id;
    queue.sendWaiters = uniquePush(queue.sendWaiters, task.id);
  }
  queue.lastAction = `${taskId ?? "Producer"} blocked: queue full`;
  queue.lastChangedIndex = null;
  queue.lastActionType = "blocked";
  return { ok: false, action: "blocked", message };
}

// ISR calls never enter a task wait list. The caller decides whether to yield
// after the interrupt, using the priority of the task woken by this send.
export function sendFromISR(state, queueId, payload, options = {}) {
  const running = getTask(state, state.cpuOwner) ?? state.tasks.find((task) => task.state === TASK_STATES.RUNNING);
  const result = sendMessage(state, queueId, null, payload, options);
  const woken = result.wokenTaskId ? getTask(state, result.wokenTaskId) : null;
  return {
    ...result,
    higherPriorityTaskWoken: Boolean(woken && (!running || woken.effectivePriority > running.effectivePriority)),
  };
}

export function receiveMessage(state, queueId, taskId) {
  const queue = getQueue(state, queueId);
  const task = getTask(state, taskId);

  if (queue.buffer.length > 0) {
    const message = queue.buffer.shift();
    queue.head = (queue.head + 1) % queue.capacity;
    queue.received += 1;
    queue.totalWaitMs += Math.max(0, state.time - message.createdAt);
    queue.lastAction = `${taskId} received ${message.payload}`;
    queue.lastChangedIndex = 0;
    queue.lastActionType = "received";
    wakeSender(state, queue);
    return { ok: true, action: "received", message };
  }

  if (queue.mode === "BLOCKING") {
    blockTask(task, `queue:${queue.id}:receive`);
    task.waitingOnQueue = queue.id;
    queue.receiveWaiters = uniquePush(queue.receiveWaiters, task.id);
    queue.lastAction = `${taskId} blocked: queue empty`;
    queue.lastChangedIndex = null;
    queue.lastActionType = "blocked";
    return { ok: false, action: "blocked" };
  }

  queue.lastAction = `${taskId} polled empty queue`;
  queue.lastChangedIndex = null;
  queue.lastActionType = "empty";
  return { ok: false, action: "empty" };
}

function wakeReceiver(state, queue) {
  if (queue.receiveWaiters.length === 0) return null;
  const nextTask = getTask(state, queue.receiveWaiters.shift());
  if (nextTask) readyTask(nextTask);
  return nextTask ?? null;
}

function wakeSender(state, queue) {
  if (queue.sendWaiters.length === 0) return;
  const nextTask = getTask(state, queue.sendWaiters.shift());
  if (nextTask) readyTask(nextTask);
}

export function createMutex({ id, owner = null, waiters = [], timeoutMs = null, priorityCeiling = null }) {
  return {
    id,
    owner,
    waiters,
    inheritanceWaiters: [],
    ceilingProtocol: false,
    timeoutMs,
    timeoutLeft: timeoutMs,
    priorityCeiling,
    lockCount: owner ? 1 : 0,
  };
}

export function lockMutex(state, taskId, mutexId, { inheritance = false, ceiling = false } = {}) {
  const task = getTask(state, taskId);
  const mutex = getMutex(state, mutexId);

  if (!mutex.owner) {
    const previousPriority = task.effectivePriority;
    mutex.owner = task.id;
    mutex.lockCount = 1;
    task.ownedMutexes = uniquePush(task.ownedMutexes, mutex.id);
    task.waitingFor = null;
    if (ceiling) mutex.ceilingProtocol = true;
    recomputeMutexPriorities(state);
    if (ceiling && mutex.priorityCeiling != null && task.effectivePriority > previousPriority) {
      addEvent(state, `${task.name} raised to ceiling priority ${mutex.priorityCeiling} by ${mutex.id}`, "fix");
    }
    return { ok: true, action: "locked" };
  }

  if (mutex.owner === task.id) {
    mutex.lockCount += 1;
    return { ok: true, action: "recursive-lock" };
  }

  blockTask(task, mutex.id);
  task.waitingFor = mutex.id;
  mutex.waiters = uniquePush(mutex.waiters, task.id);
  if (inheritance) mutex.inheritanceWaiters = uniquePush(mutex.inheritanceWaiters, task.id);
  if (ceiling) mutex.ceilingProtocol = true;
  const previousOwnerPriority = getTask(state, mutex.owner)?.effectivePriority;
  recomputeMutexPriorities(state);

  if (inheritance) {
    const owner = getTask(state, mutex.owner);
    if (owner && owner.effectivePriority > previousOwnerPriority) {
      addEvent(state, `${owner.name} inherits priority ${owner.effectivePriority} from ${task.name}`, "fix");
    }
  }
  return { ok: false, action: "blocked" };
}

export function unlockMutex(state, taskId, mutexId) {
  const task = getTask(state, taskId);
  const mutex = getMutex(state, mutexId);
  if (!task || !mutex || mutex.owner !== task.id) return { ok: false, action: "not-owner" };

  mutex.lockCount = Math.max(0, mutex.lockCount - 1);
  if (mutex.lockCount > 0) return { ok: true, action: "decremented" };

  task.ownedMutexes = task.ownedMutexes.filter((id) => id !== mutex.id);
  sortWaitersByPriority(state, mutex);
  const nextOwner = mutex.waiters.shift();
  if (nextOwner) {
    const nextTask = getTask(state, nextOwner);
    mutex.owner = nextOwner;
    mutex.lockCount = 1;
    nextTask.waitingFor = null;
    nextTask.ownedMutexes = uniquePush(nextTask.ownedMutexes, mutex.id);
    mutex.inheritanceWaiters = mutex.inheritanceWaiters.filter((id) => id !== nextOwner);
    readyTask(nextTask);
    recomputeMutexPriorities(state);
    return { ok: true, action: "transferred", owner: nextOwner };
  }

  mutex.owner = null;
  recomputeMutexPriorities(state);
  return { ok: true, action: "released" };
}

function recomputeMutexPriorities(state) {
  const effective = new Map(state.tasks.map((task) => [task.id, task.basePriority]));
  for (const mutex of state.mutexes) {
    if (mutex.owner && mutex.ceilingProtocol && mutex.priorityCeiling != null) {
      effective.set(mutex.owner, Math.max(effective.get(mutex.owner), mutex.priorityCeiling));
    }
  }
  // Priorities only rise and are bounded by the largest base priority or
  // ceiling. A visited cycle therefore reaches a fixed point and terminates.
  for (let pass = 0; pass < state.tasks.length; pass += 1) {
    let changed = false;
    for (const mutex of state.mutexes) {
      if (!mutex.owner) continue;
      for (const id of mutex.inheritanceWaiters) {
        if (!mutex.waiters.includes(id)) continue;
        const next = Math.max(effective.get(mutex.owner), effective.get(id));
        if (next > effective.get(mutex.owner)) {
          effective.set(mutex.owner, next);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  state.tasks.forEach((task) => {
    task.effectivePriority = effective.get(task.id);
    task.currentPriority = task.effectivePriority;
  });
  state.mutexes.forEach((mutex) => sortWaitersByPriority(state, mutex));
}

export function schedule(state) {
  const ready = state.tasks
    .filter((task) => task.state === TASK_STATES.READY || task.state === TASK_STATES.RUNNING)
    .sort((a, b) => {
      if (b.effectivePriority !== a.effectivePriority) return b.effectivePriority - a.effectivePriority;
      return a.id.localeCompare(b.id);
    });

  state.readyQueue = ready.map((task) => task.id);
  state.tasks.forEach((task) => {
    if (task.state === TASK_STATES.RUNNING) task.state = TASK_STATES.READY;
  });

  if (ready.length === 0) {
    state.cpuOwner = "IDLE";
    state.idleMs += TICK_MS;
    return null;
  }

  let selected = ready[0];
  if (state.scheduler === "Round Robin") {
    selected = selectRoundRobin(state, ready);
  }

  selected.state = TASK_STATES.RUNNING;
  if (state.caseId === 1) {
    selected.effectivePriority = selected.basePriority;
    selected.currentPriority = selected.basePriority;
    selected.agingCounter = 0;
  }
  selected.waitingMs = 0;
  selected.cpuMs += TICK_MS;
  selected.quantumUsed += TICK_MS;
  selected.remainingExec = Math.max(0, selected.remainingExec - TICK_MS);
  state.cpuOwner = selected.id;
  return selected;
}

function selectRoundRobin(state, ready) {
  const currentIndex = ready.findIndex((task) => task.id === state.rrCursor);
  const current = ready[currentIndex];
  if (current && current.quantumUsed < QUANTUM_MS) return current;

  if (current) current.quantumUsed = 0;
  const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % ready.length;
  const selected = ready[nextIndex];
  state.rrCursor = selected.id;
  return selected;
}

export function applyAging(state, thresholdMs = 500) {
  state.tasks.forEach((task) => {
    if (task.state !== TASK_STATES.READY) return;
    if (task.id === state.cpuOwner) return;
    task.waitingMs += TICK_MS;
    task.agingCounter += TICK_MS;
    task.readyMs += TICK_MS;
    if (!state.aging) return;
    const boost = Math.floor(task.agingCounter / thresholdMs);
    const nextPriority = task.basePriority + boost;
    if (nextPriority > task.effectivePriority) {
      const previousPriority = task.effectivePriority;
      task.lastPriority = previousPriority;
      task.effectivePriority = nextPriority;
      task.currentPriority = nextPriority;
      addEvent(state, `${task.name}: Prio ${previousPriority} -> ${nextPriority}`, "fix");
    }
  });
}

export function accrueBlockedTime(state) {
  state.tasks.forEach((task) => {
    if (task.state === TASK_STATES.BLOCKED) task.blockedMs += TICK_MS;
  });
}

export function blockTask(task, reason) {
  task.state = TASK_STATES.BLOCKED;
  task.waitingFor = reason;
}

export function readyTask(task) {
  task.state = TASK_STATES.READY;
  task.waitingFor = null;
  task.waitingOnQueue = null;
}

export function detectDeadlock(state) {
  const edges = [];
  state.tasks.forEach((task) => {
    if (task.waitingFor && !task.waitingFor.startsWith("queue:")) edges.push([task.id, task.waitingFor]);
  });
  state.mutexes.forEach((mutex) => {
    if (mutex.owner) edges.push([mutex.id, mutex.owner]);
  });

  const graph = new Map();
  edges.forEach(([from, to]) => {
    if (!graph.has(from)) graph.set(from, []);
    graph.get(from).push(to);
  });

  for (const node of graph.keys()) {
    const cycle = visitCycle(graph, node, [], new Set());
    if (cycle) return cycle;
  }
  return null;
}

function visitCycle(graph, node, path, seen) {
  if (path.includes(node)) return [...path.slice(path.indexOf(node)), node];
  if (seen.has(node)) return null;
  seen.add(node);
  const nextNodes = graph.get(node) ?? [];
  for (const next of nextNodes) {
    const cycle = visitCycle(graph, next, [...path, node], seen);
    if (cycle) return cycle;
  }
  return null;
}

export function captureHistory(state) {
  state.history.push({
    time: state.time,
    cpuOwner: state.cpuOwner,
    mutexOwners: Object.fromEntries(state.mutexes.map((mutex) => [mutex.id, mutex.owner])),
    queueDepths: Object.fromEntries(state.queues.map((queue) => [queue.id, queue.buffer.length])),
    annotation: state.lastAnnotation,
    tasks: state.tasks.map((task) => ({
      basePriority: task.basePriority,
      effectivePriority: task.effectivePriority,
      id: task.id,
      state: task.state,
    })),
  });
  state.history = state.history.slice(-60);
  state.lastAnnotation = null;
}

function sortWaitersByPriority(state, mutex) {
  mutex.waiters.sort((a, b) => getTask(state, b).effectivePriority - getTask(state, a).effectivePriority);
}

function uniquePush(list, value) {
  return list.includes(value) ? list : [...list, value];
}
