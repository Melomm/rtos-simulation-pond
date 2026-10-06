import {
  accrueBlockedTime,
  addEvent,
  applyAging,
  blockTask,
  captureHistory,
  clone,
  detectDeadlock,
  getMutex,
  getQueue,
  getTask,
  lockMutex,
  receiveMessage,
  readyTask,
  schedule,
  sendFromISR,
  sendMessage,
  TASK_STATES,
  TICK_MS,
  unlockMutex,
} from "./core.js";

export function stepSimulation(inputState) {
  const state = clone(inputState);
  syncOptions(state);
  state.time += TICK_MS;

  if (state.caseId === 1) stepSchedulingCase(state);
  if (state.caseId === 2) stepQueueCase(state);
  if (state.caseId === 3) stepPriorityInversionCase(state);
  if (state.caseId === 4) stepDeadlockCase(state);
  if (state.caseId === 5) stepAdasCase(state);
  if (state.caseId === 6) stepNetworkCase(state);

  accrueBlockedTime(state);
  captureHistory(state);
  return state;
}

function syncOptions(state) {
  const queue = state.queues[0];
  if (state.caseId === 3) {
    if (state.priorityInheritance && state.priorityProtocol === "none") state.priorityProtocol = "inheritance";
    state.priorityInheritance = state.priorityProtocol === "inheritance";
  }
  if (state.caseId === 4) {
    if (state.timeoutEnabled === false && state.deadlockProtocol === "timeout") state.deadlockProtocol = "none";
    state.timeoutEnabled = state.deadlockProtocol === "timeout";
  }
  if (state.scenarioMode === "Fix") {
    if (state.caseId === 1) state.aging = true;
    if (state.caseId === 2) state.queueMode = "OVERWRITE";
    if (state.caseId === 3) {
      state.priorityProtocol = "inheritance";
      state.priorityInheritance = true;
    }
    if (state.caseId === 4) {
      state.deadlockProtocol = "timeout";
      state.timeoutEnabled = true;
    }
    if (state.caseId === 5) state.priorityInheritance = true;
    if (state.caseId === 6) {
      state.networkLoad = Math.min(state.networkLoad, 55);
      state.networkPriority = Math.max(state.networkPriority, 6);
    }
  }
  if (queue && state.caseId === 2) queue.mode = state.queueMode;
  if (state.caseId === 6) state.queues.forEach((item) => {
    item.mode = "DROP";
  });
  state.mutexes.forEach((mutex) => {
    if (typeof state.timeoutMs === "number") {
      mutex.timeoutMs = state.timeoutMs;
      if (mutex.timeoutLeft == null || mutex.timeoutLeft > state.timeoutMs) mutex.timeoutLeft = state.timeoutMs;
    }
  });
  const network = getTask(state, "NET");
  if (network) {
    network.basePriority = state.networkPriority;
    network.effectivePriority = state.networkPriority;
    network.currentPriority = state.networkPriority;
  }
}

function stepSchedulingCase(state) {
  const high = getTask(state, "H");
  const low = getTask(state, "L");
  const previousCpuOwner = state.cpuOwner;

  high.remainingExec = high.workMs;
  high.state = TASK_STATES.READY;
  if (state.scheduler === "Round Robin") state.aging = false;

  applyAging(state);
  const running = schedule(state);

  if (!state.aging && state.scheduler === "Priority" && low.readyMs >= 1500 && state.time % 500 === 0) {
    low.starvation = true;
    addEvent(state, "STARVATION DETECTED: Low stays READY while High monopolizes CPU", "problem");
  }
  if (state.aging && running?.id === "L" && previousCpuOwner === "H") {
    low.starvation = false;
    addEvent(state, "Aging evidence: Low preempts High; High moves to READY", "fix");
  }
}

function stepQueueCase(state) {
  const queue = getQueue(state, "Q_DATA");
  const producer = getTask(state, "P");
  const consumer = getTask(state, "C");
  const producerDue = state.time % state.producerMs === 0;
  const consumerDue = state.time % state.consumerMs === 0;

  if (queue.mode === "DROP") {
    // Polling: both tasks keep spinning even when the queue is full or empty.
    readyTask(producer);
    readyTask(consumer);
  } else if (queue.mode === "OVERWRITE") {
    // Ring buffer: producer never sleeps; consumer only runs when a read is due.
    producer.state = producerDue ? TASK_STATES.READY : TASK_STATES.SLEEP;
    consumer.state = consumerDue && queue.buffer.length > 0 ? TASK_STATES.READY : TASK_STATES.SLEEP;
  } else {
    // RTOS blocking: a blocked task stays asleep until queue space/data wakes it.
    if (producer.state !== TASK_STATES.BLOCKED) producer.state = producerDue ? TASK_STATES.READY : TASK_STATES.SLEEP;
    if (consumer.state !== TASK_STATES.BLOCKED) consumer.state = consumerDue ? TASK_STATES.READY : TASK_STATES.SLEEP;
  }

  if (producerDue && producer.state !== TASK_STATES.BLOCKED) {
    const result = sendMessage(state, queue.id, producer.id, `m${Math.floor(state.time / state.producerMs)}`);
    addEvent(state, queue.lastAction, result.action === "dropped" ? "problem" : result.action === "overwritten" ? "fix" : "info");
  }

  if (consumerDue && consumer.state !== TASK_STATES.BLOCKED) {
    const result = receiveMessage(state, queue.id, consumer.id);
    addEvent(state, queue.lastAction, result.action === "blocked" ? "problem" : "info");
  }

  schedule(state);
  state.cpuLoad = calculateQueueCpuLoad(state, queue.mode);
}

function calculateQueueCpuLoad(state, mode) {
  const producer = getTask(state, "P");
  const consumer = getTask(state, "C");

  if (mode === "DROP") {
    return 98;
  }

  if (mode === "OVERWRITE") {
    return 45;
  }

  const active = producer.state === TASK_STATES.RUNNING || consumer.state === TASK_STATES.RUNNING;
  const blockedOrSleeping =
    (producer.state === TASK_STATES.BLOCKED || producer.state === TASK_STATES.SLEEP) &&
    (consumer.state === TASK_STATES.BLOCKED || consumer.state === TASK_STATES.SLEEP);

  if (active) return 20;
  if (blockedOrSleeping) return 1;
  return 5;
}

function stepPriorityInversionCase(state) {
  const high = getTask(state, "H");
  const medium = getTask(state, "M");
  const low = getTask(state, "L");
  const useInheritance = state.priorityProtocol === "inheritance";
  const useCeiling = state.priorityProtocol === "ceiling";

  if (state.time === TICK_MS) {
    lockMutex(state, low.id, "M_I2C", { ceiling: useCeiling });
    addEvent(state, useCeiling ? "Low locks M_I2C and immediately receives the mutex ceiling" : "Low locks M_I2C", "setup");
  }
  if (state.time >= 200 && !high.waitingFor && getMutex(state, "M_I2C").owner !== "H") {
    lockMutex(state, high.id, "M_I2C", { inheritance: useInheritance });
    addEvent(state, "High requests M_I2C and blocks", "problem");
  }
  if (state.time >= 300 && medium.state !== TASK_STATES.BLOCKED && !useInheritance && !useCeiling) {
    readyTask(medium);
    addEvent(state, "INVERSION: Medium preempts Low while High waits", "problem");
  }
  if ((useInheritance || useCeiling) && low.ownedMutexes.includes("M_I2C") && state.time >= 900) {
    const result = unlockMutex(state, low.id, "M_I2C");
    if (result.ok) addEvent(state, "Low releases M_I2C; boosted priority resets and High can run", "fix");
  }

  schedule(state);
}

function stepDeadlockCase(state) {
  const taskA = getTask(state, "A");
  const taskB = getTask(state, "B");
  const useOrdering = state.deadlockProtocol === "ordering";

  if (!state.manualDeadlock && state.time === TICK_MS) {
    lockMutex(state, taskA.id, "M_Sensor");
    if (useOrdering) {
      lockMutex(state, taskB.id, "M_Sensor");
      addEvent(state, "Resource ordering: A owns M_Sensor; B waits instead of taking M_Disk", "fix");
    } else {
      lockMutex(state, taskB.id, "M_Disk");
      addEvent(state, "A owns M_Sensor; B owns M_Disk", "setup");
    }
  }
  if (!state.manualDeadlock && state.time === 300) {
    if (useOrdering) {
      lockMutex(state, taskA.id, "M_Disk");
      addEvent(state, "A follows the ordered lock sequence and takes M_Disk; circular wait is prevented", "fix");
    } else {
      lockMutex(state, taskA.id, "M_Disk");
      lockMutex(state, taskB.id, "M_Sensor");
      addEvent(state, "Both tasks request the other's mutex", "problem");
    }
  }
  if (!state.manualDeadlock && useOrdering && state.time === 700 && taskA.ownedMutexes.length) {
    unlockMutex(state, "A", "M_Disk");
    unlockMutex(state, "A", "M_Sensor");
    readyTask(taskB);
    addEvent(state, "A releases ordered resources; B can continue without deadlock", "fix");
  }

  const cycle = detectDeadlock(state);
  state.deadlock = Boolean(cycle);
  state.deadlockPath = cycle ?? [];
  if (cycle && state.time % 500 === 0) addEvent(state, `DEADLOCK cycle: ${cycle.join(" -> ")}`, "problem");

  if (cycle && state.timeoutEnabled) {
    processDeadlockTimeout(state, taskB);
  }

  schedule(state);
}

function processDeadlockTimeout(state, victimTask) {
  state.mutexes.forEach((mutex) => {
    mutex.timeoutLeft = Math.max(0, (mutex.timeoutLeft ?? state.timeoutMs ?? 3000) - TICK_MS);
  });
  if (!state.mutexes.some((mutex) => mutex.timeoutLeft === 0)) return;

  unlockMutex(state, "B", "M_Disk");
  readyTask(victimTask);
  lockMutex(state, "A", "M_Disk");
  state.deadlock = false;
  state.deadlockPath = [];
  state.mutexes.forEach((mutex) => {
    mutex.timeoutLeft = mutex.timeoutMs;
  });
  addEvent(state, "Timeout chose Task B as victim; circular wait is broken", "fix");
}

function stepAdasCase(state) {
  const isr = getTask(state, "ISR");
  const compute = getTask(state, "CMP");
  const logger = getTask(state, "LOG");
  const monitor = getTask(state, "MON");
  const queue = getQueue(state, "Queue_Radar");
  const mutex = getMutex(state, "Mutex_Brake");

  isr.state = TASK_STATES.SLEEP;
  if (compute.state !== TASK_STATES.BLOCKED) {
    compute.state = queue.buffer.length > 0 ? TASK_STATES.READY : TASK_STATES.SLEEP;
  }
  if (monitor && monitor.state !== TASK_STATES.BLOCKED) {
    monitor.state = state.time >= 100 && state.time % 40 === 20 ? TASK_STATES.READY : TASK_STATES.SLEEP;
  }
  if (logger.state !== TASK_STATES.BLOCKED) {
    logger.state = state.time % 100 === 90 ? TASK_STATES.READY : TASK_STATES.SLEEP;
  }

  if (state.time % 20 === 0) {
    isr.state = TASK_STATES.ISR;
    const result = sendFromISR(state, queue.id, `risk-${state.time}`, { priority: 4 });
    addEvent(state, `ISR_Radar queued ${result.message.payload} into Queue_Radar`, result.ok ? "isr" : "problem");
  }

  if (mutex.owner === "CMP" && state.time % 40 === 0) {
    unlockMutex(state, compute.id, mutex.id);
    addEvent(state, "Task_Compute released Mutex_Brake after braking work", "evidence");
  }

  if (mutex.owner === "LOG" && state.time % 100 === 30) {
    unlockMutex(state, logger.id, mutex.id);
    addEvent(state, "Task_Log released Mutex_Brake after SD sample", "info");
  }

  if (queue.buffer.length > 0 && mutex.owner !== "CMP") {
    compute.state = TASK_STATES.READY;
    receiveMessage(state, queue.id, compute.id);
    const result = lockMutex(state, compute.id, mutex.id, { inheritance: state.priorityInheritance });
    if (!result.ok && state.priorityInheritance && mutex.owner === "LOG") readyTask(logger);
    addEvent(
      state,
      result.ok ? "Task_Compute consumed radar risk and locked Mutex_Brake" : "Task_Compute waits for Mutex_Brake behind Task_Log",
      result.ok ? "fix" : "problem",
    );
  }

  if (state.time % 100 === 90 && mutex.owner !== "LOG") {
    readyTask(logger);
    const result = lockMutex(state, logger.id, mutex.id);
    if (result.ok) addEvent(state, "Task_Log samples brake state through Mutex_Brake", "info");
    if (!result.ok) addEvent(state, "Task_Log blocked on Mutex_Brake while compute owns it", "problem");
  }

  if (!state.priorityInheritance && monitor && compute.state === TASK_STATES.BLOCKED && mutex.owner === "LOG") {
    readyTask(monitor);
    addEvent(state, "PRIORITY INVERSION: Task_Monitor can run while Task_Compute waits for Task_Log", "problem");
  }

  schedule(state);
}

function stepNetworkCase(state) {
  const highQueue = getQueue(state, "Queue_NetHigh");
  const lowQueue = getQueue(state, "Queue_NetLow");
  const compute = getTask(state, "CMP");
  const network = getTask(state, "NET");
  const logger = getTask(state, "LOG");
  const mutex = getMutex(state, "Mutex_Network");
  const highPeriod = state.networkLoad >= 85 ? 20 : state.networkLoad >= 65 ? 30 : 50;
  const lowPeriod = state.networkLoad >= 85 ? 30 : state.networkLoad >= 65 ? 50 : 80;
  const drainPeriod = state.networkPriority <= 2 ? 120 : state.networkPriority >= 8 ? 20 : state.networkPriority >= 6 ? 40 : 80;
  const loggerStarved = state.networkPriority >= 8;

  readyTask(compute);
  readyTask(network);
  if (logger.state !== TASK_STATES.BLOCKED) {
    logger.state = loggerStarved ? TASK_STATES.READY : TASK_STATES.READY;
  }

  if (state.time % highPeriod === 0) {
    const result = sendMessage(state, highQueue.id, compute.id, `brake-${state.time}`, { priority: 4 });
    if (!result.ok) state.drops.high += 1;
    if (!result.ok && state.networkPriority <= 2) blockTask(compute, "Queue_NetHigh/network-stack");
    addEvent(state, result.ok ? "Task_Compute queued critical packet" : "CRITICAL DROP: Queue_NetHigh is full", result.ok ? "info" : "problem");
  }

  if (state.time % lowPeriod === 0 || loggerStarved) {
    const result = sendMessage(state, lowQueue.id, logger.id, `log-${state.time}`, { priority: 1 });
    if (!result.ok) state.drops.low += 1;
    addEvent(
      state,
      result.ok ? "Task_Log queued telemetry packet" : loggerStarved ? "LOG STALL: Queue_NetLow overflow while Network Stack dominates CPU" : "Queue_NetLow dropped log packet",
      result.ok ? "info" : "problem",
    );
  }

  if (mutex.owner === "NET" && state.time % 40 === 0) {
    unlockMutex(state, network.id, mutex.id);
    addEvent(state, "Network Stack released Mutex_Network", "evidence");
  }

  if (state.time % drainPeriod === 0 && (highQueue.buffer.length || lowQueue.buffer.length)) {
    const targetQueue = highQueue.buffer.length ? highQueue : lowQueue;
    const lockResult = lockMutex(state, network.id, mutex.id);
    if (lockResult.ok || mutex.owner === network.id) {
      receiveMessage(state, targetQueue.id, network.id);
      addEvent(state, `Network Stack drained ${targetQueue.id} through Mutex_Network`, "fix");
    }
  }

  if (loggerStarved) {
    logger.starvation = logger.readyMs >= 200 || lowQueue.buffer.length === lowQueue.capacity;
    if (logger.starvation && state.time % 100 === 0) addEvent(state, "Task_Log CPU starvation: SD writes are stalled", "problem");
  } else {
    logger.starvation = false;
  }

  schedule(state);
}

function calculateCpuLoad(state) {
  const busy = state.tasks.reduce((sum, task) => sum + task.cpuMs, 0);
  const total = busy + state.idleMs;
  return total === 0 ? 0 : Math.round((busy / total) * 100);
}

export function setTaskWork(inputState, taskId, workMs) {
  const state = clone(inputState);
  const task = getTask(state, taskId);
  if (task) {
    task.workMs = workMs;
    task.remainingExec = Math.min(task.remainingExec, workMs);
    addEvent(state, `${task.name} execution time set to ${workMs}ms`, "setup");
  }
  return state;
}

export function manualLockRequest(inputState, taskId, mutexId) {
  const state = clone(inputState);
  state.manualDeadlock = true;
  const task = getTask(state, taskId);
  if (!task) return state;
  readyTask(task);
  const result = lockMutex(state, taskId, mutexId);
  addEvent(state, `${taskId} -> ${mutexId}: ${result.action}`, result.ok ? "setup" : "problem");
  const cycle = detectDeadlock(state);
  state.deadlock = Boolean(cycle);
  state.deadlockPath = cycle ?? [];
  return state;
}

export function manualUnlockRequest(inputState, taskId, mutexId) {
  const state = clone(inputState);
  state.manualDeadlock = true;
  const result = unlockMutex(state, taskId, mutexId);
  addEvent(state, `${taskId} releases ${mutexId}: ${result.action}`, result.ok ? "fix" : "problem");
  const cycle = detectDeadlock(state);
  state.deadlock = Boolean(cycle);
  state.deadlockPath = cycle ?? [];
  return state;
}

export function setNetworkPreset(inputState, preset) {
  const state = clone(inputState);
  if (preset === "success") {
    state.scenarioMode = "Fix";
    state.networkPriority = 6;
    state.networkLoad = 45;
    addEvent(state, "Preset: successful orchestration, network stack has enough priority", "fix");
  } else {
    state.scenarioMode = "Problem";
    state.networkPriority = 2;
    state.networkLoad = 95;
    addEvent(state, "Preset: heavy load, low-priority packets will drop first", "problem");
  }
  return state;
}
