import { describe, expect, it } from "vitest";
import { createCaseState } from "./cases.js";
import { getMutex, getQueue, getTask } from "./core.js";
import { manualLockRequest, manualUnlockRequest, setTaskWork, stepSimulation } from "./rules.js";

function run(state, ticks) {
  let next = state;
  for (let i = 0; i < ticks; i += 1) next = stepSimulation(next);
  return next;
}

describe("scheduler rules", () => {
  it("keeps Low ready and emits starvation under priority scheduling", () => {
    const state = run(createCaseState(1), 200);
    expect(getTask(state, "L").state).toBe("READY");
    expect(state.events.some((event) => event.message.includes("STARVATION"))).toBe(true);
  });

  it("boosts Low and lets it run when aging is enabled", () => {
    const state = run({ ...createCaseState(1), aging: true }, 150);
    expect(getTask(state, "L").state).toBe("RUNNING");
    expect(getTask(state, "H").state).toBe("READY");
    expect(state.history.some((snap) => snap.cpuOwner === "L")).toBe(true);
    expect(state.events.some((event) => event.message.includes("Low: Prio 1 -> 2"))).toBe(true);
    expect(state.events.some((event) => event.message.includes("Low preempts High"))).toBe(true);
  });

  it("resets the running task aging counter and priority in case 1", () => {
    const state = run({ ...createCaseState(1), aging: true }, 150);
    const low = getTask(state, "L");
    expect(low.state).toBe("RUNNING");
    expect(low.agingCounter).toBe(0);
    expect(low.effectivePriority).toBe(low.basePriority);
  });

  it("keeps separate problem and solution states for the case 1 comparison", () => {
    const problem = run({ ...createCaseState(1), scheduler: "Priority", aging: false }, 200);
    const solution = run({ ...createCaseState(1), scheduler: "Priority", aging: true }, 150);
    expect(problem.events.some((event) => event.message.includes("STARVATION"))).toBe(true);
    expect(solution.history.some((snap) => snap.cpuOwner === "L")).toBe(true);
  });

  it("applies task duration changes to both case 1 comparison states", () => {
    const problem = setTaskWork({ ...createCaseState(1), aging: false }, "H", 700);
    const solution = setTaskWork({ ...createCaseState(1), aging: true }, "H", 700);
    expect(getTask(problem, "H").workMs).toBe(700);
    expect(getTask(solution, "H").workMs).toBe(700);
  });

  it("round robin does not let one task monopolize the CPU", () => {
    const state = run({ ...createCaseState(1), scheduler: "Round Robin" }, 180);
    const owners = new Set(state.history.map((snap) => snap.cpuOwner));
    expect(owners.has("H")).toBe(true);
    expect(owners.size).toBeGreaterThan(1);
  });
});

describe("queue rules", () => {
  it("drops a message when DROP mode queue is full", () => {
    const state = run(createCaseState(2), 80);
    expect(getQueue(state, "Q_DATA").dropped + state.drops.total).toBeGreaterThan(0);
  });

  it("blocks producer or consumer in BLOCKING mode", () => {
    const state = run({ ...createCaseState(2), queueMode: "BLOCKING" }, 80);
    const producer = getTask(state, "P");
    expect(producer.state === "BLOCKED" || producer.blockedMs > 0).toBe(true);
  });

  it("overwrites the oldest message in OVERWRITE mode", () => {
    const state = run({ ...createCaseState(2), queueMode: "OVERWRITE" }, 80);
    expect(getQueue(state, "Q_DATA").overwritten).toBeGreaterThan(0);
  });

  it("keeps polling CPU high while blocking can idle when tasks sleep or block", () => {
    const polling = run({ ...createCaseState(2), queueMode: "DROP" }, 20);
    const blocking = run({ ...createCaseState(2), queueMode: "BLOCKING", producerMs: 700, consumerMs: 100 }, 20);
    expect(polling.cpuLoad).toBeGreaterThanOrEqual(95);
    expect(blocking.cpuLoad).toBeLessThan(10);
  });

  it("wakes a blocked producer after the consumer frees queue space", () => {
    let state = run({ ...createCaseState(2), queueMode: "BLOCKING" }, 80);
    expect(getTask(state, "P").state).toBe("BLOCKED");
    state = run(state, 20);
    expect(getTask(state, "P").state).not.toBe("BLOCKED");
  });
});

describe("mutex and deadlock rules", () => {
  it("uses priority inheritance so Low inherits High priority", () => {
    const state = run({ ...createCaseState(3), priorityInheritance: true }, 40);
    expect(getTask(state, "L").effectivePriority).toBe(3);
    expect(getTask(state, "M").state).not.toBe("RUNNING");
  });

  it("uses priority ceiling so Low is boosted when it locks the mutex", () => {
    const state = run({ ...createCaseState(3), priorityProtocol: "ceiling" }, 2);
    expect(getTask(state, "L").effectivePriority).toBe(3);
    expect(state.events.some((event) => event.message.includes("ceiling priority"))).toBe(true);
  });

  it("detects circular wait deadlock", () => {
    const state = run({ ...createCaseState(4), timeoutEnabled: false }, 50);
    expect(state.deadlock).toBe(true);
    expect(state.deadlockPath.join(" -> ")).toContain("A -> M_Disk -> B");
  });

  it("breaks deadlock after timeout", () => {
    const state = run({ ...createCaseState(4), timeoutEnabled: true }, 340);
    expect(state.deadlock).toBe(false);
    expect(getMutex(state, "M_Disk").owner).toBe("A");
  });

  it("prevents circular wait with resource ordering", () => {
    const state = run({ ...createCaseState(4), deadlockProtocol: "ordering" }, 80);
    expect(state.deadlock).toBe(false);
    expect(state.events.some((event) => event.message.includes("circular wait is prevented"))).toBe(true);
  });

  it("lets users create and release a deadlock manually", () => {
    let state = createCaseState(4);
    state = manualLockRequest(state, "A", "M_Sensor");
    state = manualLockRequest(state, "B", "M_Disk");
    state = manualLockRequest(state, "A", "M_Disk");
    state = manualLockRequest(state, "B", "M_Sensor");
    expect(state.deadlock).toBe(true);

    state = manualUnlockRequest(state, "B", "M_Disk");
    expect(state.deadlock).toBe(false);
    expect(getMutex(state, "M_Disk").owner).toBe("A");
  });
});

describe("integrated cases", () => {
  it("ADAS records ISR, queue, brake task and mutex evidence within 500ms", () => {
    const state = run(createCaseState(5), 50);
    expect(state.history.some((snap) => snap.tasks.some((task) => task.id === "ISR" && task.state === "ISR"))).toBe(true);
    expect(getQueue(state, "Queue_Radar").sent).toBeGreaterThan(0);
    expect(state.history.some((snap) => snap.mutexOwners.Mutex_Brake === "CMP")).toBe(true);
  });

  it("ADAS fires radar ISR every 20ms", () => {
    const state = run(createCaseState(5), 6);
    const isrEvents = state.events.filter((event) => event.kind === "isr");
    expect(isrEvents.map((event) => event.time)).toEqual([20, 40, 60]);
  });

  it("ADAS can delay logger on the brake mutex", () => {
    const state = run(createCaseState(5), 12);
    const logger = getTask(state, "LOG");
    expect(logger.blockedMs).toBeGreaterThan(0);
    expect(state.events.some((event) => event.message.includes("Task_Log blocked"))).toBe(true);
  });

  it("drops low priority network packets first under heavy load", () => {
    const state = run({ ...createCaseState(6), networkLoad: 95 }, 80);
    expect(state.drops.low).toBeGreaterThan(0);
    expect(state.drops.total).toBeGreaterThan(0);
  });

  it("increases network backpressure when message load rises", () => {
    const balanced = run({ ...createCaseState(6), networkPriority: 3, networkLoad: 45 }, 80);
    const overloaded = run({ ...createCaseState(6), networkPriority: 3, networkLoad: 95 }, 80);
    expect(overloaded.drops.total).toBeGreaterThan(balanced.drops.total);
  });

  it("drops high priority packets when network task priority is too low", () => {
    const state = run({ ...createCaseState(6), networkPriority: 1, networkLoad: 95 }, 80);
    expect(getQueue(state, "Queue_NetHigh").dropped).toBeGreaterThan(0);
    expect(state.drops.high).toBeGreaterThan(0);
  });

  it("starves logging and overflows Queue_NetLow when network priority is too high", () => {
    const state = run({ ...createCaseState(6), networkPriority: 9, networkLoad: 90 }, 80);
    expect(getTask(state, "LOG").starvation).toBe(true);
    expect(getQueue(state, "Queue_NetLow").dropped).toBeGreaterThan(0);
    expect(state.drops.low).toBeGreaterThan(0);
  });

  it("drains high priority network traffic before low priority traffic", () => {
    const state = run({ ...createCaseState(6), networkPriority: 6, networkLoad: 55 }, 10);
    expect(getQueue(state, "Queue_NetHigh").received).toBeGreaterThan(0);
    expect(getQueue(state, "Queue_NetHigh").received).toBeGreaterThanOrEqual(getQueue(state, "Queue_NetLow").received);
  });
});
