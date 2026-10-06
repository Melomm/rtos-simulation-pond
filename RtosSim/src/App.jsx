import {
  AlertTriangle,
  BarChart3,
  BookOpen,
  CircleHelp,
  CircleUserRound,
  Cpu,
  FastForward,
  Gauge,
  Lock,
  Menu,
  Network,
  Pause,
  Play,
  Radar,
  RefreshCcw,
  Settings,
  Shuffle,
  StepForward,
  Timer,
} from "lucide-react";
import { useEffect, useState } from "react";
import { CASE_THEORY, CASES, createCaseState } from "./sim/cases.js";
import { TASK_STATES } from "./sim/core.js";
import { manualLockRequest, manualUnlockRequest, setTaskWork, stepSimulation } from "./sim/rules.js";

const ACTIVE_CASES = CASES;

const CASE_ICONS = {
  1: AlertTriangle,
  2: Menu,
  3: Shuffle,
  4: Lock,
  5: Radar,
  6: Network,
};

const STATE_META = {
  [TASK_STATES.RUNNING]: { label: "RUNNING", className: "running" },
  [TASK_STATES.READY]: { label: "READY", className: "ready" },
  [TASK_STATES.BLOCKED]: { label: "BLOCKED", className: "blocked" },
  [TASK_STATES.SLEEP]: { label: "SLEEP", className: "sleep" },
  [TASK_STATES.IDLE]: { label: "IDLE", className: "sleep" },
  [TASK_STATES.ISR]: { label: "ISR", className: "isr" },
};

const CASE_TITLES = {
  1: "CS1: Preemptive Priority",
  2: "CS2: Producer-Consumer",
  3: "CS3: Priority Inversion",
  4: "CS4: Deadlock",
  5: "CS5: ADAS Integration",
  6: "CS6: Shared Network Driver",
};

const CASE_ONE_HORIZON = 50;

function App() {
  const [state, setState] = useState(() => createCaseState(getInitialCaseId()));
  const [caseOneStates, setCaseOneStates] = useState(() => createCaseOneStates());
  const [caseOneCursor, setCaseOneCursor] = useState(0);
  const [running, setRunning] = useState(false);
  const isCaseOne = state.caseId === 1;
  const controlState = isCaseOne ? caseOneStates.problem : state;

  useEffect(() => {
    if (!running) return undefined;
    const speed = isCaseOne ? caseOneStates.problem.simSpeed : state.simSpeed;
    const timer = setInterval(() => {
      if (isCaseOne) {
        setCaseOneCursor((prev) => (prev + 1) % (CASE_ONE_HORIZON + 1));
      } else {
        setState((prev) => stepSimulation(prev));
      }
    }, Math.max(40, 240 / speed));
    return () => clearInterval(timer);
  }, [caseOneStates.problem.simSpeed, isCaseOne, running, state.simSpeed]);

  const activeCase = ACTIVE_CASES.find((item) => item.id === state.caseId) ?? ACTIVE_CASES[0];

  function switchCase(caseId) {
    setState(createCaseState(caseId));
    if (caseId === 1) setCaseOneStates(createCaseOneStates());
    setCaseOneCursor(0);
    setRunning(false);
  }

  function update(partial) {
    if (isCaseOne) {
      setCaseOneStates((prev) => syncCaseOneStates(prev, partial));
      return;
    }
    setState((prev) => ({ ...prev, ...partial }));
  }

  function reset() {
    if (isCaseOne) {
      setCaseOneStates(createCaseOneStates());
      setState(createCaseState(1));
      setCaseOneCursor(0);
      setRunning(false);
      return;
    }
    setState(createCaseState(state.caseId));
    setRunning(false);
  }

  function step() {
    if (isCaseOne) {
      setCaseOneCursor((prev) => (prev + 1) % (CASE_ONE_HORIZON + 1));
      return;
    }
    setState((prev) => stepSimulation(prev));
  }

  function updateTaskWork(taskId, workMs) {
    if (isCaseOne) {
      setCaseOneStates((prev) => ({
        problem: setTaskWork(prev.problem, taskId, workMs),
        solution: setTaskWork(prev.solution, taskId, workMs),
      }));
      return;
    }
    setState((prev) => setTaskWork(prev, taskId, workMs));
  }

  function updateCaseOneTask(taskId, patch) {
    setCaseOneStates((prev) => ({
      problem: updateTaskConfig(prev.problem, taskId, patch),
      solution: updateTaskConfig(prev.solution, taskId, patch),
    }));
    setCaseOneCursor(0);
  }

  return (
    <div className="rtos-shell">
      <TopBar />
      <SideNav activeCase={state.caseId} onSelect={switchCase} />
      <main className="app-main">
        <Legend caseId={state.caseId} />
        <section className={state.caseId === 3 || state.caseId === 4 ? "content-grid embedded-case-grid" : "content-grid"}>
          {state.caseId !== 3 && state.caseId !== 4 && (
            <ControlPanel
              running={running}
              setRunning={setRunning}
              state={controlState}
              update={update}
              updateCaseOneTask={updateCaseOneTask}
              updateTaskWork={updateTaskWork}
              reset={reset}
              step={step}
              requestLock={(taskId, mutexId) => setState((prev) => manualLockRequest(prev, taskId, mutexId))}
            />
          )}
          <Visualizer
            activeCase={activeCase}
            caseOneCursor={caseOneCursor}
            caseOneStates={caseOneStates}
            requestLock={(taskId, mutexId) => setState((prev) => manualLockRequest(prev, taskId, mutexId))}
            releaseLock={(taskId, mutexId) => setState((prev) => manualUnlockRequest(prev, taskId, mutexId))}
            state={state}
            update={update}
          />
        </section>
        {!isCaseOne && state.caseId !== 2 && state.caseId !== 3 && state.caseId !== 4 && <EventLog events={state.events} onClear={() => update({ events: [] })} />}
      </main>
    </div>
  );
}

function createCaseOneStates() {
  const base = normalizeCaseOneState(createCaseState(1));
  return {
    problem: { ...base, scheduler: "Priority", aging: false },
    solution: { ...base, scheduler: "Priority", aging: true },
  };
}

function normalizeCaseOneState(inputState) {
  const defaults = {
    H: { workMs: 2, periodMs: 5, basePriority: 3 },
    M: { workMs: 3, periodMs: 8, basePriority: 2 },
    L: { workMs: 2, periodMs: 10, basePriority: 1 },
  };
  return {
    ...inputState,
    simSpeed: 1,
    tasks: inputState.tasks.map((task) => {
      const preset = defaults[task.id] ?? { workMs: 2, periodMs: 10, basePriority: task.basePriority };
      return {
        ...task,
        ...preset,
        currentPriority: preset.basePriority,
        effectivePriority: preset.basePriority,
      };
    }),
  };
}

function syncCaseOneStates(prev, partial) {
  const lockedPartial = { ...partial };
  delete lockedPartial.scheduler;
  delete lockedPartial.aging;
  return {
    problem: { ...prev.problem, ...lockedPartial, scheduler: "Priority", aging: false },
    solution: { ...prev.solution, ...lockedPartial, scheduler: "Priority", aging: true },
  };
}

function updateTaskConfig(inputState, taskId, patch) {
  return {
    ...inputState,
    tasks: inputState.tasks.map((task) => (task.id === taskId ? { ...task, ...patch } : task)),
  };
}

function TopBar() {
  return (
    <header className="top-app-bar">
      <div className="brand">
        <Cpu size={26} />
        <span>VisuaLearnRtos</span>
      </div>
      <div className="top-actions">
        <button aria-label="settings" type="button">
          <Settings size={20} />
        </button>
        <button aria-label="help" type="button">
          <CircleHelp size={20} />
        </button>
        <button aria-label="account" type="button">
          <CircleUserRound size={20} />
        </button>
      </div>
    </header>
  );
}

function SideNav({ activeCase, onSelect }) {
  return (
    <aside className="side-nav">
      <div className="side-heading">
        <h2>Case Studies</h2>
        <p>RTOS Scenarios</p>
      </div>
      <nav>
        {ACTIVE_CASES.map((item) => {
          const Icon = CASE_ICONS[item.id];
          return (
            <button className={activeCase === item.id ? "nav-item active" : "nav-item"} key={item.id} onClick={() => onSelect(item.id)} type="button">
              <Icon size={19} />
              <span>{CASE_TITLES[item.id]}</span>
            </button>
          );
        })}
      </nav>
      <div className="side-footer">
        <button className="nav-item" type="button">
          <BarChart3 size={19} />
          <span>System Status</span>
        </button>
        <button className="nav-item" type="button">
          <BookOpen size={19} />
          <span>Documentation</span>
        </button>
      </div>
    </aside>
  );
}

function Legend({ caseId }) {
  const priorityLegend = caseId === 3 || caseId === 4 || caseId === 5 || caseId === 6;
  return (
    <section className="system-legend">
      <div className="legend-title">
        <Gauge size={18} />
        <strong>System Legend</strong>
      </div>
      <div className="legend-items">
        {priorityLegend ? (
          <>
            <LegendDot label="High Prio" tone="blocked" />
            <LegendDot label="Med Prio" tone="ready" />
            <LegendDot label="Low Prio" tone="running" />
            <LegendDot label="Mutex / Resource" tone="mutex" />
            {(caseId === 5 || caseId === 6) && <LegendDot label={caseId === 5 ? "ISR Spike" : "Network"} tone="isr" />}
          </>
        ) : (
          <>
            <LegendDot label="RUNNING" tone="running" />
            <LegendDot label="READY" tone="ready" />
            <LegendDot label="BLOCKED" tone="blocked" />
            <LegendDot label="SLEEP" tone="sleep" />
          </>
        )}
      </div>
    </section>
  );
}

function LegendDot({ label, tone }) {
  return (
    <span className={`legend-dot ${tone}`}>
      <i />
      {label}
    </span>
  );
}

function ControlPanel({ state, running, setRunning, update, updateCaseOneTask, updateTaskWork, reset, step, requestLock }) {
  return (
    <section className="control-panel">
      <h3>Control Panel</h3>
      <CaseControls state={state} update={update} updateCaseOneTask={updateCaseOneTask} updateTaskWork={updateTaskWork} requestLock={requestLock} />
      {state.caseId !== 1 && (
        <>
          <div className="theory-box">
            <span>Scenario</span>
            <p>{CASE_THEORY[state.caseId].setup}</p>
          </div>
          <div className="theory-box warning">
            <span>Problem</span>
            <p>{CASE_THEORY[state.caseId].problem}</p>
          </div>
        </>
      )}
      <div className="panel-actions">
        <button className="primary-action" onClick={() => setRunning((value) => !value)} type="button">
          {running ? <Pause size={18} /> : <Play size={18} />}
          {running ? "Pause Simulation" : "Start Simulation"}
        </button>
        <button className="secondary-action" onClick={step} type="button">
          <StepForward size={18} />
          Step Forward
        </button>
        <button className="secondary-action" onClick={reset} type="button">
          <RefreshCcw size={18} />
          Reset
        </button>
      </div>
    </section>
  );
}

function CaseControls({ state, update, updateCaseOneTask, updateTaskWork, requestLock }) {
  if (state.caseId === 1) {
    return (
      <>
        <div className="case-one-task-editor">
          {state.tasks.map((task, index) => (
            <div className="task-edit-row" key={task.id}>
              <strong>G{index + 1}</strong>
              <NumberField label="C" max={10} min={1} value={task.workMs} onChange={(workMs) => updateCaseOneTask(task.id, { workMs })} />
              <NumberField label="T" max={30} min={1} value={task.periodMs ?? defaultPeriodForTask(task.id)} onChange={(periodMs) => updateCaseOneTask(task.id, { periodMs })} />
              <NumberField label="P" max={5} min={1} value={task.basePriority} onChange={(basePriority) => updateCaseOneTask(task.id, { basePriority, currentPriority: basePriority, effectivePriority: basePriority })} />
            </div>
          ))}
        </div>
        <Slider label="Simulation Speed" max={4} min={0.5} step={0.5} value={state.simSpeed} onChange={(simSpeed) => update({ simSpeed })} suffix="x" />
        <div className="case-note">
          C is execution time, T is period, P is priority. Higher P means higher priority. CPU utilization is configured by C/T and may exceed 100%.
        </div>
      </>
    );
  }

  if (state.caseId === 2) {
    return (
      <>
        <Select
          label="Algorithm Mode"
          value={state.queueMode}
          onChange={(queueMode) => update({ queueMode })}
          options={[
            { label: "Polling", value: "DROP" },
            { label: "RTOS Blocking", value: "BLOCKING" },
            { label: "Ring Buffer", value: "OVERWRITE" },
          ]}
        />
        <Slider label="Producer Period (ms)" max={700} min={100} step={100} value={state.producerMs} onChange={(producerMs) => update({ producerMs })} />
        <Slider label="Consumer Period (ms)" max={900} min={100} step={100} value={state.consumerMs} onChange={(consumerMs) => update({ consumerMs })} />
      </>
    );
  }

  if (state.caseId === 3) {
    return (
      <>
        <Select
          label="Solution Protocol"
          value={state.priorityProtocol}
          onChange={(priorityProtocol) => update({ priorityProtocol, priorityInheritance: priorityProtocol === "inheritance" })}
          options={[
            { label: "None: show inversion", value: "none" },
            { label: "Priority Inheritance", value: "inheritance" },
            { label: "Priority Ceiling", value: "ceiling" },
          ]}
        />
        <div className="case-note">
          None lets Medium preempt Low while High waits. Inheritance boosts Low only after High blocks. Ceiling boosts Low as soon as it locks M_I2C.
        </div>
      </>
    );
  }

  if (state.caseId === 4) {
    return (
      <>
        <Select
          label="Deadlock Strategy"
          value={state.deadlockProtocol}
          onChange={(deadlockProtocol) => update({ deadlockProtocol, timeoutEnabled: deadlockProtocol === "timeout" })}
          options={[
            { label: "None: show deadlock", value: "none" },
            { label: "Mutex Timeout Recovery", value: "timeout" },
            { label: "Resource Ordering", value: "ordering" },
          ]}
        />
        {state.deadlockProtocol === "timeout" && (
          <Slider label="Timeout Duration (ms)" max={5000} min={500} step={250} value={state.timeoutMs} onChange={(timeoutMs) => update({ timeoutMs })} />
        )}
        <div className="manual-locks">
          <span>Manual Mutex Request</span>
          <div>
            {["A", "B"].map((taskId) => (
              <button className={state.selectedTaskId === taskId ? "chip active" : "chip"} key={taskId} onClick={() => update({ selectedTaskId: taskId })} type="button">
                Task {taskId}
              </button>
            ))}
          </div>
          <div>
            {["M_Sensor", "M_Disk"].map((mutexId) => (
              <button className="chip" disabled={!state.selectedTaskId} key={mutexId} onClick={() => requestLock(state.selectedTaskId, mutexId)} type="button">
                {mutexId}
              </button>
            ))}
          </div>
        </div>
      </>
    );
  }

  if (state.caseId === 5) {
    return (
      <>
        <Switch label="Enable Priority Inheritance" checked={state.priorityInheritance} onChange={(priorityInheritance) => update({ priorityInheritance })} />
        <Slider label="Simulation Speed" max={4} min={0.5} step={0.5} value={state.simSpeed} onChange={(simSpeed) => update({ simSpeed })} suffix="x" />
        <div className="case-note">
          ISR_Radar fires every 20ms and wakes Task_Compute through Queue_Radar. If Task_Log owns Mutex_Brake, Task_Monitor exposes the priority inversion risk.
        </div>
      </>
    );
  }

  return (
    <>
      <Slider label="Network Task Priority" max={9} min={1} step={1} value={state.networkPriority} onChange={(networkPriority) => update({ networkPriority })} />
      <Slider label="Message Load" max={100} min={20} step={5} value={state.networkLoad} onChange={(networkLoad) => update({ networkLoad })} suffix="%" />
      <div className="network-presets">
        <button className={state.networkPriority <= 2 ? "chip active" : "chip"} onClick={() => update({ networkPriority: 2, networkLoad: 95, scenarioMode: "Problem" })} type="button">
          Low Network Priority
        </button>
        <button className={state.networkPriority >= 8 ? "chip active" : "chip"} onClick={() => update({ networkPriority: 9, networkLoad: 90, scenarioMode: "Problem" })} type="button">
          High Network Priority
        </button>
        <button className={state.networkPriority === 6 && state.networkLoad <= 60 ? "chip active" : "chip"} onClick={() => update({ networkPriority: 6, networkLoad: 55, scenarioMode: "Fix" })} type="button">
          Balanced
        </button>
      </div>
    </>
  );
}

function Slider({ label, value, min, max, step, onChange, suffix = "" }) {
  return (
    <label className="field">
      <span>
        {label}
        <b>{value}{suffix}</b>
      </span>
      <input max={max} min={min} onChange={(event) => onChange(Number(event.target.value))} step={step} type="range" value={value} />
    </label>
  );
}

function NumberField({ label, value, min, max, onChange }) {
  return (
    <label className="number-field">
      <span>{label}</span>
      <input max={max} min={min} onChange={(event) => onChange(Number(event.target.value))} type="number" value={value} />
    </label>
  );
}

function defaultPeriodForTask(taskId) {
  if (taskId === "H") return 5;
  if (taskId === "M") return 7;
  return 10;
}

function Select({ label, value, options, onChange }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select onChange={(event) => onChange(event.target.value)} value={value}>
        {options.map((option) => (
          <option key={typeof option === "string" ? option : option.value} value={typeof option === "string" ? option : option.value}>
            {typeof option === "string" ? option : option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Switch({ label, checked, onChange }) {
  return (
    <label className="switch-row">
      <span>{label}</span>
      <input checked={checked} onChange={(event) => onChange(event.target.checked)} type="checkbox" />
      <i />
    </label>
  );
}

function Visualizer({ activeCase, caseOneCursor, caseOneStates, requestLock, releaseLock, state, update }) {
  if (state.caseId === 3) {
    return (
      <section className="visualizer embedded-priority-view">
        <iframe src="/cases/priority.html" title="Priority inversion simulator" />
      </section>
    );
  }

  if (state.caseId === 4) {
    return (
      <section className="visualizer embedded-priority-view">
        <iframe src="/cases/deadlock.html" title="Deadlock simulator" />
      </section>
    );
  }

  return (
    <section className="visualizer">
      <div className="section-head">
        <div>
          <h3>{CASE_TITLES[state.caseId]}</h3>
          <p>{activeCase.title}</p>
        </div>
        <div className="time-pill">
          <Timer size={17} />
          {state.caseId === 1 ? caseOneCursor : state.time}ms
        </div>
      </div>
      {state.caseId === 1 ? (
        <CaseOneSchedulerLab cursor={caseOneCursor} state={caseOneStates.problem} />
      ) : (
        <>
          {state.caseId === 2 ? (
            <ProducerConsumerView state={state} />
          ) : state.caseId === 5 ? (
            <AdasIntegrationView state={state} />
          ) : state.caseId === 6 ? (
            <NetworkDriverView state={state} />
          ) : (
            <GenericCaseView state={state} />
          )}
          {state.caseId !== 3 && state.caseId !== 4 && <Timeline state={state} />}
        </>
      )}
    </section>
  );
}

function CaseOneSchedulerLab({ cursor, state }) {
  const schedule = buildPreemptivePrioritySchedule(state.tasks, CASE_ONE_HORIZON);
  const current = schedule.snapshots[cursor] ?? schedule.snapshots[0];
  const cpuUsage = calculateConfiguredCpuUsage(state.tasks);
  const currentTask = current?.runner ? taskLabel(current.runner) : "IDLE";
  const hasMiss = cpuUsage > 100 || schedule.snapshots.some((snap) => snap.deadlineMisses.length > 0);

  return (
    <section className="scheduler-lab">
      <div className="scheduler-summary">
        <MetricCard label="CPU Utilization" value={`${cpuUsage}%`} />
        <MetricCard label="Status" tone={hasMiss ? "problem" : "fix"} value={hasMiss ? "Overloaded" : "Schedulable"} />
        <MetricCard label="Live Tick" value={`t=${cursor}: ${currentTask} running`} />
      </div>
      <div className="live-gantt-card">
        <div className="live-gantt-head">
          <div>
            <h4>Preemptive Priority Gantt</h4>
            <span>At every tick, the READY task with the highest P value receives the CPU.</span>
          </div>
          <strong>Higher P = Higher Priority</strong>
        </div>
        <div className="live-gantt">
          {state.tasks.map((task) => (
            <div className="live-gantt-row" key={task.id}>
              <label>{taskLabel(task.id)}</label>
              <div className="live-gantt-track">
                {schedule.snapshots.map((snap) => (
                  <i
                    className={`${snap.runner === task.id ? taskTone(task.id) : ""} ${snap.time === cursor ? "current" : ""} ${snap.time < cursor ? "past" : ""}`}
                    key={`${task.id}-${snap.time}`}
                    title={`t=${snap.time} ${snap.runner === task.id ? "RUNNING" : snap.taskStates[task.id]}`}
                  />
                ))}
              </div>
            </div>
          ))}
          <div className="time-axis">
            {Array.from({ length: CASE_ONE_HORIZON + 1 }, (_, index) => (
              <span key={index}>{index % 5 === 0 ? index : ""}</span>
            ))}
          </div>
        </div>
      </div>
      <div className="tick-detail">
        {state.tasks.map((task) => {
          const detail = current?.taskDetails[task.id];
          return (
            <article key={task.id}>
              <strong>{taskLabel(task.id)}</strong>
              <span className={detail?.state.toLowerCase()}>{detail?.state}</span>
              <small>Remaining: {detail?.remainingAfter} / Next release: {detail?.nextRelease}</small>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function MetricCard({ label, tone = "", value }) {
  return (
    <article className={`metric-card ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function ProducerConsumerView({ state }) {
  const queue = state.queues[0];
  const producer = state.tasks.find((task) => task.id === "P");
  const consumer = state.tasks.find((task) => task.id === "C");
  const modeMeta = getQueueModeMeta(state.queueMode);
  const fillPercent = Math.round((queue.buffer.length / queue.capacity) * 100);
  const totalDrops = state.drops.total + queue.dropped;
  const queueAlert = getQueueAlert(state.queueMode, queue);

  return (
    <section className="producer-consumer-lab">
      <div className="scheduler-summary">
        <MetricCard label="Status" tone={producer?.state === TASK_STATES.BLOCKED || consumer?.state === TASK_STATES.BLOCKED ? "problem" : "fix"} value={modeMeta.status} />
        <MetricCard label="Lost Data" tone={totalDrops > 0 ? "problem" : ""} value={totalDrops} />
        <MetricCard label="CPU Load" value={`${state.cpuLoad ?? 0}%`} />
      </div>
      <div className="flow-card">
        <div className="live-gantt-head">
          <div>
            <h4>Producer-Consumer Queue</h4>
            <span>{modeMeta.description}</span>
          </div>
          <strong>{modeMeta.label}</strong>
        </div>
        <div className="flow-scene">
          <TaskEndpoint title="Producer" task={producer} />
          <div className="queue-flow">
            <div className="queue-flow-head">
              <span>Q_DATA capacity: {queue.capacity}</span>
              <b>{fillPercent}% full</b>
            </div>
            <div className="queue-flow-slots">
              {Array.from({ length: queue.capacity }, (_, index) => {
                const item = queue.buffer[index];
                return (
                  <div
                    className={`${item ? "queue-flow-slot filled" : "queue-flow-slot"} ${queue.lastChangedIndex === index ? queue.lastActionType : ""}`}
                    key={`${item?.id ?? "empty"}-${index}`}
                  >
                    <small>{index}</small>
                    <strong>{item?.payload ?? "empty"}</strong>
                  </div>
                );
              })}
            </div>
            <div className="queue-pressure">
              <i style={{ width: `${fillPercent}%` }} />
            </div>
            <strong className={`queue-alert ${queueAlert.tone}`}>{queueAlert.text}</strong>
          </div>
          <TaskEndpoint title="Consumer" task={consumer} />
        </div>
      </div>
      <div className="queue-evidence-grid">
        <EvidenceTile label="Queue Action" value={queue.lastAction} />
        <EvidenceTile label="Dropped" value={totalDrops} />
        <EvidenceTile label="Overwritten" value={queue.overwritten} />
        <EvidenceTile label="Received" value={queue.received} />
      </div>
    </section>
  );
}

function TaskEndpoint({ task, title }) {
  const meta = STATE_META[task?.state] ?? STATE_META.IDLE;
  return (
    <article className={`task-endpoint ${meta.className}`}>
      <strong>{title}</strong>
      <span>{meta.label}</span>
      <small>CPU: {task?.cpuMs ?? 0}ms</small>
    </article>
  );
}

function EvidenceTile({ label, value }) {
  return (
    <article className="evidence-tile">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function getQueueModeMeta(mode) {
  if (mode === "DROP") {
    return {
      description: "Polling keeps tasks active. A full queue drops new messages and wastes CPU.",
      label: "Polling / Drop",
      status: "Polling",
    };
  }
  if (mode === "OVERWRITE") {
    return {
      description: "Ring buffer keeps the newest data by overwriting the oldest unread item.",
      label: "Ring Buffer",
      status: "Overwrite",
    };
  }
  return {
    description: "RTOS blocking sleeps tasks when the queue is full or empty, reducing wasted CPU.",
    label: "RTOS Blocking",
    status: "Blocking",
  };
}

function getQueueAlert(mode, queue) {
  if (queue.lastActionType === "dropped") return { text: "Queue full: new data dropped", tone: "problem" };
  if (queue.lastActionType === "blocked") return { text: "Queue full: producer blocked", tone: "problem" };
  if (queue.lastActionType === "overwritten") return { text: "Ring buffer: oldest item overwritten", tone: "fix" };
  if (queue.lastActionType === "received") return { text: "Consumer read one item; space opened", tone: "fix" };
  if (queue.buffer.length === queue.capacity) {
    return mode === "BLOCKING" ? { text: "Queue is full; producer will sleep", tone: "problem" } : { text: "Queue is full", tone: "problem" };
  }
  return { text: "Queue filling over time", tone: "" };
}

function GenericCaseView({ state }) {
  const queue = state.queues[0];
  return (
    <div className="case-layout">
      <div className="task-cards">
        {state.tasks.map((task) => (
          <TaskCard caseId={state.caseId} key={task.id} task={task} />
        ))}
      </div>
      <div className="gantt-card">
        <AlertStrip state={state} />
        {queue ? <QueuePanel queue={queue} drops={state.drops} /> : <ReadyQueue state={state} />}
      </div>
    </div>
  );
}

function getInitialCaseId() {
  const fallbackCaseId = 1;
  if (typeof window === "undefined") return fallbackCaseId;
  const caseId = Number(new URLSearchParams(window.location.search).get("case"));
  return CASES.some((item) => item.id === caseId) ? caseId : fallbackCaseId;
}

function AdasIntegrationView({ state }) {
  const radarQueue = state.queues.find((queue) => queue.id === "Queue_Radar");
  const mutex = state.mutexes.find((item) => item.id === "Mutex_Brake");
  const isrActive = state.tasks.some((task) => task.id === "ISR" && task.state === TASK_STATES.ISR);
  const compute = state.tasks.find((task) => task.id === "CMP");
  const logger = state.tasks.find((task) => task.id === "LOG");
  const monitor = state.tasks.find((task) => task.id === "MON");
  const fillPercent = radarQueue ? Math.round((radarQueue.buffer.length / radarQueue.capacity) * 100) : 0;

  return (
    <section className="integrated-lab">
      <div className="scheduler-summary">
        <MetricCard label="Radar ISR" tone={isrActive ? "problem" : ""} value={isrActive ? "Firing" : "Armed"} />
        <MetricCard label="Queue_Radar" value={`${radarQueue?.buffer.length ?? 0}/${radarQueue?.capacity ?? 0}`} />
        <MetricCard label="Mutex_Brake" tone={mutex?.owner === "LOG" ? "problem" : mutex?.owner === "CMP" ? "fix" : ""} value={mutex?.owner ?? "FREE"} />
      </div>
      <div className="adas-grid">
        <div className="interrupt-panel">
          <div className="live-gantt-head">
            <div>
              <h4>Interrupt Lane</h4>
              <span>Hardware ISR preempts task work and only defers a message.</span>
            </div>
            <strong>20ms period</strong>
          </div>
          <div className={isrActive ? "isr-spike active" : "isr-spike"}>
            <Radar size={52} />
            <span>{isrActive ? "ISR_Radar -> Queue_Radar" : "Waiting for next radar interrupt"}</span>
          </div>
          {radarQueue && <QueueStrip queue={radarQueue} />}
          <div className="queue-pressure">
            <i style={{ width: `${fillPercent}%` }} />
          </div>
        </div>
        <div className="task-cards compact">
          <TaskCard caseId={state.caseId} compact task={compute} />
          <TaskCard caseId={state.caseId} compact task={monitor} />
          <TaskCard caseId={state.caseId} compact task={logger} />
          <div className="driver-panel">
            <Lock size={32} />
            <strong>Mutex_Brake</strong>
            <span>Owner: {mutex?.owner ?? "FREE"}</span>
            <span>Waiters: {mutex?.waiters.join(", ") || "none"}</span>
          </div>
        </div>
      </div>
    </section>
  );
}

function NetworkDriverView({ state }) {
  const highQueue = state.queues.find((queue) => queue.id === "Queue_NetHigh");
  const lowQueue = state.queues.find((queue) => queue.id === "Queue_NetLow");
  const mutex = state.mutexes.find((item) => item.id === "Mutex_Network");
  const status = getNetworkStatus(state, highQueue, lowQueue);

  return (
    <section className="integrated-lab">
      <div className={`network-status ${status.tone}`}>
        <AlertTriangle size={22} />
        <strong>{status.label}</strong>
        <span>{status.detail}</span>
      </div>
      <div className="scheduler-summary">
        <MetricCard label="High Priority Drops" tone={state.drops.high > 0 ? "problem" : ""} value={state.drops.high} />
        <MetricCard label="Low Priority Drops" tone={state.drops.low > 0 ? "problem" : ""} value={state.drops.low} />
        <MetricCard label="Network Priority" value={state.networkPriority} />
      </div>
      <div className="network-grid">
        <NetworkQueuePanel title="Critical Brake Packets" queue={highQueue} />
        <div className="driver-panel network-driver">
          <Network size={44} />
          <strong>Network Stack Task</strong>
          <span>Mutex_Network owner: {mutex?.owner ?? "FREE"}</span>
          <span>Load: {state.networkLoad}%</span>
          <span>Ready Queue: {state.readyQueue.join(" -> ") || "IDLE"}</span>
        </div>
        <NetworkQueuePanel title="Log / SD Telemetry" queue={lowQueue} />
      </div>
    </section>
  );
}

function QueueStrip({ queue }) {
  return (
    <div className="mini-queue">
      {Array.from({ length: queue.capacity }, (_, index) => {
        const item = queue.buffer[index];
        return (
          <span className={item ? "filled" : ""} key={`${queue.id}-${item?.id ?? "empty"}-${index}`}>
            {item?.payload ?? ""}
          </span>
        );
      })}
    </div>
  );
}

function NetworkQueuePanel({ queue, title }) {
  const fillPercent = queue ? Math.round((queue.buffer.length / queue.capacity) * 100) : 0;
  return (
    <article className="network-queue-panel">
      <div className="queue-flow-head">
        <span>{title}</span>
        <b>{queue?.id}</b>
      </div>
      {queue && <QueueStrip queue={queue} />}
      <div className="queue-pressure">
        <i style={{ width: `${fillPercent}%` }} />
      </div>
      <div className="metric-row">
        <span>Depth: {queue?.buffer.length ?? 0}/{queue?.capacity ?? 0}</span>
        <span>Dropped: {queue?.dropped ?? 0}</span>
        <span>Received: {queue?.received ?? 0}</span>
      </div>
    </article>
  );
}

function getNetworkStatus(state, highQueue, lowQueue) {
  if (state.networkPriority <= 2 && (state.drops.high > 0 || highQueue?.buffer.length === highQueue?.capacity)) {
    return {
      label: "Critical Network Bottleneck",
      detail: "Network Stack is too low priority; Queue_NetHigh is losing brake packets.",
      tone: "problem",
    };
  }
  if (state.networkPriority >= 8 && (state.drops.low > 0 || state.tasks.some((task) => task.id === "LOG" && task.starvation))) {
    return {
      label: "Logging Starvation",
      detail: "Network Stack dominates CPU; Task_Log and Queue_NetLow fall behind.",
      tone: "problem",
    };
  }
  if ((highQueue?.buffer.length ?? 0) + (lowQueue?.buffer.length ?? 0) > 0 && state.networkLoad > 75) {
    return {
      label: "Heavy Backpressure",
      detail: "Message load is high; queue pressure is rising.",
      tone: "warn",
    };
  }
  return {
    label: "Balanced Orchestration",
    detail: "Network priority and load are within a stable teaching range.",
    tone: "fix",
  };
}

function buildPreemptivePrioritySchedule(tasks, horizon) {
  const runtime = tasks.map((task) => ({
    id: task.id,
    execution: Math.max(1, Number(task.workMs) || 1),
    period: Math.max(1, Number(task.periodMs ?? defaultPeriodForTask(task.id)) || 1),
    priority: Math.max(1, Number(task.basePriority) || 1),
    remaining: 0,
    nextRelease: 0,
  }));
  const snapshots = [];
  let busyTicks = 0;

  for (let time = 0; time <= horizon; time += 1) {
    const deadlineMisses = [];
    runtime.forEach((task) => {
      if (time % task.period === 0) {
        if (task.remaining > 0) deadlineMisses.push(task.id);
        task.remaining += task.execution;
        task.nextRelease = time + task.period;
      }
    });

    const ready = runtime
      .filter((task) => task.remaining > 0)
      .sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        return a.period - b.period;
      });
    const runner = ready[0] ?? null;
    const taskDetails = {};
    const taskStates = {};

    runtime.forEach((task) => {
      const state = runner?.id === task.id ? TASK_STATES.RUNNING : task.remaining > 0 ? TASK_STATES.READY : TASK_STATES.BLOCKED;
      taskStates[task.id] = state;
      taskDetails[task.id] = {
        nextRelease: task.nextRelease,
        remainingBefore: task.remaining,
        state,
      };
    });

    if (runner) {
      runner.remaining = Math.max(0, runner.remaining - 1);
      busyTicks += 1;
    }

    runtime.forEach((task) => {
      taskDetails[task.id].remainingAfter = task.remaining;
    });

    snapshots.push({
      deadlineMisses,
      runner: runner?.id ?? null,
      taskDetails,
      taskStates,
      time,
    });
  }

  return { busyTicks, snapshots };
}

function calculateConfiguredCpuUsage(tasks) {
  const utilization = tasks.reduce((sum, task) => {
    const execution = Math.max(1, Number(task.workMs) || 1);
    const period = Math.max(1, Number(task.periodMs ?? defaultPeriodForTask(task.id)) || 1);
    return sum + execution / period;
  }, 0);
  return Math.round(utilization * 100);
}

function taskLabel(taskId) {
  if (taskId === "H") return "Task 1";
  if (taskId === "M") return "Task 2";
  if (taskId === "L") return "Task 3";
  if (!taskId) return "IDLE";
  return taskId;
}

function taskTone(taskId) {
  if (taskId === "H") return "task-one";
  if (taskId === "M") return "task-two";
  return "task-three";
}

function PriorityInversionView({ state }) {
  const mutex = state.mutexes[0];
  const low = state.tasks.find((task) => task.id === "L");
  const high = state.tasks.find((task) => task.id === "H");
  const medium = state.tasks.find((task) => task.id === "M");
  const protocolMeta = getPriorityProtocolMeta(state.priorityProtocol);
  const boosted = low && low.effectivePriority > low.basePriority;
  const inversionActive = high?.state === TASK_STATES.BLOCKED && medium?.state === TASK_STATES.RUNNING;
  return (
    <section className="legacy-lab priority-lab">
      <div className={inversionActive ? "legacy-alert active" : "legacy-alert"}>
        WARNING: PRIORITY INVERSION OCCURRING. BT Sync is running while Emergency is blocked.
      </div>

      <div className="legacy-control-strip">
        <strong>{protocolMeta.label}</strong>
        <span>{protocolMeta.detail}</span>
      </div>

      <div className="legacy-dashboard">
        <div className="legacy-task-panel">
          <PriorityLabTask task={high} title="Emergency (Fall Detection)" tone="high" />
          <PriorityLabTask task={medium} title="BT Synchronization" tone="med" />
          <PriorityLabTask boosted={boosted} task={low} title="Sensor Reading" tone="low" />
        </div>

        <aside className="legacy-mutex-panel">
          <h4>Hardware Resource</h4>
          <div className={mutex?.owner ? "legacy-mutex-box locked" : "legacy-mutex-box"}>
            <Lock size={28} />
            <strong>M_I2C</strong>
            <small>{mutex?.owner ? `Owned by: ${mutex.owner}` : "FREE"}</small>
          </div>
          <span>Waiters: {mutex?.waiters.join(", ") || "none"}</span>
          <span>Ceiling: {mutex?.priorityCeiling ?? "none"} | Low effective: {low?.effectivePriority ?? "-"}</span>
        </aside>
      </div>

      <LegacyGantt labels={{ H: "Emergency (H)", M: "BT Sync (M)", L: "Sensor (L)" }} state={state} />
    </section>
  );
}

function PriorityLabTask({ boosted = false, task, title, tone }) {
  const meta = STATE_META[task?.state] ?? STATE_META.IDLE;
  return (
    <article className={`legacy-task-card ${tone}`}>
      <h4>
        {title}
        <span className={boosted ? "legacy-badge inherited" : "legacy-badge prio"}>
          {boosted ? `Inherited Prio: ${task.effectivePriority}` : `Prio: ${task?.basePriority}`}
        </span>
      </h4>
      <p>
        Status: <span className={`legacy-badge ${meta.className}`}>{meta.label}</span>
      </p>
      <small>CPU {task?.cpuMs ?? 0}ms | Waiting {task?.waitingFor ?? "none"} | Owns {task?.ownedMutexes.join(", ") || "none"}</small>
    </article>
  );
}

function getPriorityProtocolMeta(protocol) {
  if (protocol === "inheritance") {
    return {
      detail: CASE_THEORY[3].fix,
      label: "Inheritance",
      tone: "fix",
    };
  }
  if (protocol === "ceiling") {
    return {
      detail: "Priority ceiling raises Low to the M_I2C ceiling immediately, so Medium cannot enter between Low and the blocked High task.",
      label: "Ceiling",
      tone: "fix",
    };
  }
  return {
    detail: CASE_THEORY[3].problem,
    label: "None",
    tone: "problem",
  };
}

function DeadlockView({ releaseLock, requestLock, state, update }) {
  const taskA = state.tasks.find((task) => task.id === "A");
  const taskB = state.tasks.find((task) => task.id === "B");
  const sensor = state.mutexes.find((mutex) => mutex.id === "M_Sensor");
  const disk = state.mutexes.find((mutex) => mutex.id === "M_Disk");
  const strategyMeta = getDeadlockStrategyMeta(state.deadlockProtocol);
  const selectedTaskId = state.selectedTaskId;
  const selectTask = (taskId) => update({ selectedTaskId: selectedTaskId === taskId ? null : taskId, manualDeadlock: true });
  const handleResource = (mutexId) => {
    if (!selectedTaskId || state.deadlock) return;
    const mutex = state.mutexes.find((item) => item.id === mutexId);
    if (mutex?.owner === selectedTaskId) {
      releaseLock(selectedTaskId, mutexId);
      return;
    }
    requestLock(selectedTaskId, mutexId);
  };
  return (
    <section className="deadlock-lab">
      <div className="deadlock-toolbar">
        <strong>{strategyMeta.label}</strong>
        <span>{strategyMeta.detail}</span>
      </div>
      <div className="deadlock-grid">
        <div className="deadlock-canvas">
          <div className={state.deadlock ? "deadlock-overlay active" : "deadlock-overlay"}>
            <h4>DEADLOCK DETECTED</h4>
            <span>{state.deadlockPath.join(" -> ")}</span>
          </div>
          <svg viewBox="0 0 650 500" aria-hidden="true">
            <defs>
              <marker id="arrow-green" markerHeight="6" markerWidth="8" orient="auto" refX="7" refY="3">
                <polygon fill="#27ae60" points="0 0, 8 3, 0 6" />
              </marker>
              <marker id="arrow-red" markerHeight="6" markerWidth="8" orient="auto" refX="7" refY="3">
                <polygon fill="#e74c3c" points="0 0, 8 3, 0 6" />
              </marker>
            </defs>
            <DeadlockPath className={sensor?.owner === "A" ? "line-lock" : taskA?.waitingFor === "M_Sensor" ? "line-wait" : ""} d="M 155 95 L 490 95" />
            <DeadlockPath className={taskA?.waitingFor === "M_Disk" ? "line-wait" : disk?.owner === "A" ? "line-lock" : ""} d="M 95 155 L 95 330" />
            <DeadlockPath className={disk?.owner === "B" ? "line-lock" : taskB?.waitingFor === "M_Disk" ? "line-wait" : ""} d="M 490 350 L 155 350" />
            <DeadlockPath className={taskB?.waitingFor === "M_Sensor" ? "line-wait" : sensor?.owner === "B" ? "line-lock" : ""} d="M 545 330 L 545 155" />
          </svg>
          <DeadlockNode className={selectedTaskId === "A" ? "task active" : "task"} label="Task A" meta={taskA} onClick={() => selectTask("A")} style={{ left: 12, top: 34 }} subtitle="Dropper" />
          <DeadlockNode className="mutex" label="M_Sensor" onClick={() => handleResource("M_Sensor")} owner={sensor?.owner} selectedTaskId={selectedTaskId} style={{ right: 12, top: 34 }} />
          <DeadlockNode className="mutex" label="M_Disk" onClick={() => handleResource("M_Disk")} owner={disk?.owner} selectedTaskId={selectedTaskId} style={{ bottom: 34, left: 12 }} />
          <DeadlockNode className={selectedTaskId === "B" ? "task active" : "task"} label="Task B" meta={taskB} onClick={() => selectTask("B")} style={{ bottom: 34, right: 12 }} subtitle="Scanner" />
        </div>

        <div className="deadlock-code-panel">
          <div className="code-header">
            <span>RTOS Logic</span>
            <span>cargo_system.c</span>
          </div>
          <pre>{`SemaphoreHandle_t xSensor;
SemaphoreHandle_t xDisk;

void vTaskA_Dropper(void *pv) {
  xSemaphoreTake(xSensor, portMAX_DELAY);
  vTaskDelay(pdMS_TO_TICKS(100));
  xSemaphoreTake(xDisk, ${state.deadlockProtocol === "timeout" ? "timeoutTicks" : "portMAX_DELAY"});
}

void vTaskB_Scanner(void *pv) {
  ${state.deadlockProtocol === "ordering" ? "xSemaphoreTake(xSensor, portMAX_DELAY);" : "xSemaphoreTake(xDisk, portMAX_DELAY);"}
  ${state.deadlockProtocol === "ordering" ? "// Same order prevents circular wait." : "xSemaphoreTake(xSensor, portMAX_DELAY);"}
}`}</pre>
        </div>
      </div>
      <LegacyGantt labels={{ A: "Task A", B: "Task B" }} state={state} />
    </section>
  );
}

function getDeadlockStrategyMeta(protocol) {
  if (protocol === "ordering") {
    return {
      detail: "Both tasks acquire resources in the same order, so circular wait cannot form.",
      label: "Resource Ordering",
    };
  }
  if (protocol === "timeout") {
    return {
      detail: "A blocked task times out, releases a resource, and the wait-for cycle is broken.",
      label: "Mutex Timeout Recovery",
    };
  }
  return {
    detail: "Each task can hold one mutex while waiting for the other, exposing circular wait.",
    label: "No Recovery",
  };
}

function DeadlockPath({ className, d }) {
  if (!className) return null;
  return <path className={className} d={d} />;
}

function DeadlockNode({ className, label, meta, onClick, owner, selectedTaskId, style, subtitle }) {
  const stateLabel = meta?.waitingFor ? `WAIT ${meta.waitingFor}` : meta?.ownedMutexes.length ? `OWNS ${meta.ownedMutexes.join(", ")}` : owner ? `Owned by ${owner}` : selectedTaskId ? "Click to request" : "FREE";
  return (
    <button className={`deadlock-node ${className}`} onClick={onClick} style={style} type="button">
      <span className="type-tag">{className.includes("task") ? "Process" : "Resource"}</span>
      <strong>{label}</strong>
      {subtitle && <small>{subtitle}</small>}
      <em>{stateLabel}</em>
    </button>
  );
}

function LegacyGantt({ labels, state }) {
  const history = state.history.length ? state.history : [{ time: state.time, tasks: state.tasks }];
  const taskIds = state.tasks.map((task) => task.id);
  return (
    <div className="legacy-gantt-container">
      {taskIds.map((taskId) => (
        <div className="legacy-gantt-row" key={taskId}>
          <div className="legacy-gantt-label">{labels[taskId] ?? taskId}</div>
          <div className="legacy-gantt-track">
            {history.slice(-50).map((snap) => {
              const taskSnapshot = snap.tasks.find((task) => task.id === taskId);
              const boosted = taskSnapshot?.effectivePriority > taskSnapshot?.basePriority;
              return <i className={`tick-${taskSnapshot?.state ?? TASK_STATES.SLEEP} ${boosted ? "boosted" : ""}`} key={`${taskId}-${snap.time}`} />;
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function TaskCard({ caseId, compact = false, task }) {
  const meta = STATE_META[task.state] ?? STATE_META.IDLE;
  return (
    <article className={`task-card ${compact ? "compact" : ""} ${meta.className} ${task.starvation ? "starving" : ""}`}>
      <div className="task-top">
        <h4>{task.name} Task</h4>
        <span className={`status ${meta.className}`}>{meta.label}</span>
      </div>
      <div className="task-meta">
        <span>Base Prio: {task.basePriority}</span>
        <span>Effective: {task.effectivePriority}</span>
        {caseId === 1 && <span>Aging: {task.agingCounter ?? task.readyMs}ms</span>}
        <span>CPU: {task.cpuMs}ms</span>
      </div>
      {caseId === 1 && task.starvation && <p>Starvation: READY counter exceeded threshold</p>}
      {task.waitingFor && <p>Waiting for {task.waitingFor}</p>}
      {task.ownedMutexes.length > 0 && <p>Owns {task.ownedMutexes.join(", ")}</p>}
    </article>
  );
}

function AlertStrip({ state }) {
  const starvation = state.caseId === 1 && !state.aging && state.tasks.some((task) => task.starvation);
  const agingPreemption =
    state.caseId === 1 &&
    state.aging &&
    state.cpuOwner === "L" &&
    state.tasks.some((task) => task.id === "H" && task.state === TASK_STATES.READY);
  const inversion =
    state.caseId === 3 &&
    !state.priorityInheritance &&
    state.tasks.some((task) => task.id === "H" && task.state === TASK_STATES.BLOCKED) &&
    state.cpuOwner === "M";

  if (!starvation && !agingPreemption && !inversion && !state.deadlock) return null;
  return (
    <div className={agingPreemption ? "alert-strip fix" : "alert-strip"}>
      <AlertTriangle size={22} />
      {agingPreemption ? "AGING: LOW PREEMPTED HIGH" : starvation ? "STARVATION ACTIVE" : inversion ? "PRIORITY INVERSION ACTIVE" : "DEADLOCK DETECTED"}
    </div>
  );
}

function ReadyQueue({ state }) {
  return (
    <div className="ready-queue">
      <Cpu size={44} />
      <strong>Ready Queue</strong>
      <span>{state.readyQueue.join(" -> ") || "IDLE"}</span>
      <small>CPU Owner: {state.cpuOwner}</small>
    </div>
  );
}

function QueuePanel({ queue, drops }) {
  const slots = Array.from({ length: queue.capacity }, (_, index) => queue.buffer[index]);
  return (
    <div className="queue-panel">
      <div className="queue-title">
        <strong>{queue.id}</strong>
        <span>{queue.lastAction}</span>
      </div>
      <div className="queue-slots">
        {slots.map((slot, index) => (
          <div className={slot ? "queue-slot filled" : "queue-slot"} key={`${slot?.id ?? "empty"}-${index}`}>
            <small>slot {index}</small>
            <b>{slot?.payload ?? "empty"}</b>
          </div>
        ))}
      </div>
      <div className="metric-row">
        <span>Drop: {drops.total + queue.dropped}</span>
        <span>Overwrite: {queue.overwritten}</span>
        <span>Sent: {queue.sent}</span>
        <span>Received: {queue.received}</span>
      </div>
    </div>
  );
}

function ResourceGraph({ state }) {
  return (
    <div className="resource-list">
      {state.mutexes.map((mutex) => (
        <div className="resource-item" key={mutex.id}>
          <Lock size={28} />
          <div>
            <strong>{mutex.id}</strong>
            <span>Owner: {mutex.owner ?? "FREE"}</span>
            <span>Waiters: {mutex.waiters.join(", ") || "none"}</span>
          </div>
          {mutex.timeoutLeft != null && <b>{mutex.timeoutLeft}ms</b>}
        </div>
      ))}
    </div>
  );
}

function Timeline({ state }) {
  const taskIds = state.tasks.map((task) => task.id);
  const history = state.history.length ? state.history : [{ time: state.time, cpuOwner: state.cpuOwner, tasks: state.tasks }];

  return (
    <section className="timeline-card">
      <div className="timeline-head">
        <h4>Timeline (Gantt)</h4>
        <span>{history[0]?.time ?? 0}ms - {state.time}ms</span>
      </div>
      <div className="timeline-grid">
        {taskIds.map((taskId) => (
          <div className="timeline-row" key={taskId}>
            <label>{taskId}</label>
            <div className="timeline-track">
              {history.map((snap) => {
                const taskSnapshot = snap.tasks.find((task) => task.id === taskId);
                const taskState = taskSnapshot?.state ?? TASK_STATES.IDLE;
                const meta = STATE_META[taskState] ?? STATE_META.IDLE;
                const inheritedClass = taskSnapshot?.effectivePriority > taskSnapshot?.basePriority ? " boosted-priority" : "";
                return <i className={`${meta.className}${inheritedClass}`} key={`${taskId}-${snap.time}`} title={`${snap.time}ms ${taskState}`} />;
              })}
            </div>
          </div>
        ))}
        <div className="timeline-row">
          <label>CPU</label>
          <div className="timeline-track">
            {history.map((snap) => (
              <i className={snap.cpuOwner === "IDLE" ? "sleep" : "running"} key={`cpu-${snap.time}`} title={`${snap.time}ms CPU=${snap.cpuOwner}`} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function EventLog({ events, onClear }) {
  return (
    <section className="event-panel">
      <div className="event-head">
        <h4>Event Log</h4>
        <button onClick={onClear} type="button">Clear Log</button>
      </div>
      <div className="event-list">
        {[...events].reverse().map((event, index) => (
          <div className={`event-line ${event.kind}`} key={`${event.time}-${event.message}-${index}`}>
            <span>[t={event.time}ms]</span>
            {event.message}
          </div>
        ))}
      </div>
    </section>
  );
}

export default App;
