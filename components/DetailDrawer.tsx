"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ArtifactRecord,
  CheckpointRecord,
  CodexCollabCallRecord,
  CodexModelOption,
  CodexNativeThreadTreeNode,
  CodexRuntimeOptions,
  CodexSubagentRecord,
  CodexTransportMode,
  EventRecord,
  ExecutorSandboxMode,
  HandoffRecord,
  PlanJson,
  PlanRecord,
  PlanTaskInput,
  ProjectMemoryCategory,
  ProjectMemoryRecord,
  ProjectMemoryScope,
  ProjectMemoryStatus,
  ReasoningEffort,
  RuntimeOverrides,
  RuntimeStatus,
  SkillRecord,
  TaskRecord,
  UserMemoryRecord,
  UserMemoryStatus,
  VerificationRunRecord,
  WorkSessionRecord,
} from "@/lib/shared/types";
import { projectEventToTimeline } from "@/lib/shared/ui-projections";
import { EDITABLE_TASK_KINDS, RISK_LEVELS, validateAndNormalizeEditedPlan } from "@/lib/shared/plan";
import { codexTransportModes, emptyRuntimeOverrides, executorSandboxModes, fallbackReasoningEfforts, isRuntimeOverridesEmpty, standardServiceTier } from "@/lib/shared/runtime-overrides";
import { logClientProcess } from "@/lib/client/logging";

const emptyCodexModelOptions: CodexModelOption[] = [];

type SelectableProvider = "codex-cli" | "claude-code" | "antigravity-cli" | "ollama";

function labelForModelSlug(models: CodexModelOption[], slug: string | null): string {
  if (slug === null || slug.trim().length === 0) {
    return "provider default";
  }
  return models.find((model) => model.slug === slug)?.displayName ?? slug;
}

function codexTransportLabel(mode: CodexTransportMode | null | undefined): string {
  switch (mode) {
    case "app-server-only":
      return "Native only";
    case "exec-only":
      return "Exec only";
    case "auto":
      return "Auto native-first";
    default:
      return "configured default";
  }
}

function codexTransportEffectiveLabel(mode: CodexTransportMode | null | undefined): string {
  switch (mode) {
    case "app-server-only":
      return "Native app-server";
    case "exec-only":
      return "codex exec";
    case "auto":
      return "Native app-server with startup fallback";
    default:
      return "configured default";
  }
}

function codexLastTransportLabel(transport: "exec" | "app-server" | null | undefined): string {
  if (transport === "app-server") return "Native app-server";
  if (transport === "exec") return "codex exec";
  return "none yet";
}

export type DrawerView =
  | { kind: "none" }
  | { kind: "plan"; plan: PlanRecord; canEdit: boolean; mode: "view" | "edit" }
  | { kind: "verification"; run: VerificationRunRecord }
  | { kind: "handoff"; handoff: HandoffRecord; workspacePath: string | null }
  | { kind: "events"; events: EventRecord[] }
  | { kind: "artifacts"; artifacts: ArtifactRecord[] }
  | { kind: "checkpoints"; checkpoints: CheckpointRecord[]; currentCheckpointId: string | null; tasks: TaskRecord[] }
  | { kind: "skills"; skills: SkillRecord[]; workSession: WorkSessionRecord | null }
  | { kind: "memory"; userMemories: UserMemoryRecord[]; projectMemories: ProjectMemoryRecord[]; workSession: WorkSessionRecord | null }
  | { kind: "runtime"; workSession: WorkSessionRecord; lastCodexTransport?: "exec" | "app-server" | null };

interface DetailDrawerProps {
  view: DrawerView;
  busy: boolean;
  onClose: () => void;
  onSavePlanAndRun: (planId: string, planJson: PlanJson) => Promise<void>;
  onSaveRuntime: (provider: SelectableProvider, overrides: RuntimeOverrides | null, steeringNote: string) => Promise<void>;
  onRefreshSkills: () => Promise<void>;
  onUpdateSkill: (skillId: string, patch: { enabled?: boolean; allowImplicit?: boolean; trusted?: boolean }) => Promise<void>;
  onDeleteSkill: (skillId: string) => Promise<void>;
  onCreateSkill: (input: { name: string; description: string; body: string; allowImplicit: boolean }) => Promise<void>;
  onImportSkillFiles: (files: FileList | File[]) => Promise<void>;
  onCreateUserMemory: (input: { content: string; status: UserMemoryStatus; pinned: boolean }) => Promise<void>;
  onUpdateUserMemory: (memoryId: string, patch: Partial<Pick<UserMemoryRecord, "content" | "status" | "pinned">>) => Promise<void>;
  onDeleteUserMemory: (memoryId: string) => Promise<void>;
  onCreateProjectMemory: (input: { content: string; category: ProjectMemoryCategory; scope: ProjectMemoryScope; status: ProjectMemoryStatus; pinned: boolean }) => Promise<void>;
  onUpdateProjectMemory: (memoryId: string, patch: Partial<Pick<ProjectMemoryRecord, "content" | "category" | "scope" | "status" | "pinned">>) => Promise<void>;
  onDeleteProjectMemory: (memoryId: string) => Promise<void>;
  onStartNativeReview: () => Promise<void>;
  onRestoreCheckpoint: (checkpointId: string) => Promise<void>;
  onSurgicalRevertCheckpoint: (checkpointId: string) => Promise<void>;
  onForkCheckpoint: (checkpointId: string) => Promise<void>;
}

function formatTime(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function DetailDrawer({ view, busy, onClose, onSavePlanAndRun, onSaveRuntime, onRefreshSkills, onUpdateSkill, onDeleteSkill, onCreateSkill, onImportSkillFiles, onCreateUserMemory, onUpdateUserMemory, onDeleteUserMemory, onCreateProjectMemory, onUpdateProjectMemory, onDeleteProjectMemory, onStartNativeReview, onRestoreCheckpoint, onSurgicalRevertCheckpoint, onForkCheckpoint }: DetailDrawerProps): React.ReactElement | null {
  useEffect(() => {
    if (view.kind === "none") {
      return;
    }
    logClientProcess("info", "detail_drawer.opened", {
      kind: view.kind,
      itemCount: view.kind === "events" ? view.events.length : view.kind === "artifacts" ? view.artifacts.length : view.kind === "checkpoints" ? view.checkpoints.length : view.kind === "memory" ? view.userMemories.length + view.projectMemories.length : null,
    });
  }, [view]);

  useEffect(() => {
    if (view.kind === "none") return undefined;
    const handler = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [view, onClose]);

  if (view.kind === "none") return null;

  if (view.kind === "plan") {
    return (
      <div className="drawer-shroud" role="dialog" aria-modal="true" onClick={onClose}>
        <div className="drawer" onClick={(e) => e.stopPropagation()}>
          <PlanDrawer view={view} busy={busy} onClose={onClose} onSavePlanAndRun={onSavePlanAndRun} />
        </div>
      </div>
    );
  }

  if (view.kind === "runtime") {
    return (
      <div className="drawer-shroud" role="dialog" aria-modal="true" onClick={onClose}>
        <div className="drawer" onClick={(e) => e.stopPropagation()}>
          <RuntimeDrawer view={view} busy={busy} onClose={onClose} onSaveRuntime={onSaveRuntime} onStartNativeReview={onStartNativeReview} />
        </div>
      </div>
    );
  }

  if (view.kind === "skills") {
    return (
      <div className="drawer-shroud" role="dialog" aria-modal="true" onClick={onClose}>
        <div className="drawer" onClick={(e) => e.stopPropagation()}>
          <SkillsDrawer view={view} busy={busy} onClose={onClose} onRefreshSkills={onRefreshSkills} onUpdateSkill={onUpdateSkill} onDeleteSkill={onDeleteSkill} onCreateSkill={onCreateSkill} onImportSkillFiles={onImportSkillFiles} />
        </div>
      </div>
    );
  }

  if (view.kind === "memory") {
    return (
      <div className="drawer-shroud" role="dialog" aria-modal="true" onClick={onClose}>
        <div className="drawer" onClick={(e) => e.stopPropagation()}>
          <ProjectMemoryDrawer view={view} busy={busy} onClose={onClose} onCreateUserMemory={onCreateUserMemory} onUpdateUserMemory={onUpdateUserMemory} onDeleteUserMemory={onDeleteUserMemory} onCreateProjectMemory={onCreateProjectMemory} onUpdateProjectMemory={onUpdateProjectMemory} onDeleteProjectMemory={onDeleteProjectMemory} />
        </div>
      </div>
    );
  }

  return (
    <div className="drawer-shroud" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-header">
          <h2>{headerForView(view)}</h2>
          <button type="button" className="ghost" onClick={() => {
            logClientProcess("info", "detail_drawer.close_clicked", { kind: view.kind });
            onClose();
          }} aria-label="Close drawer">
            ✕
          </button>
        </header>
        <div className="drawer-body">{bodyForView(view, busy, onRestoreCheckpoint, onSurgicalRevertCheckpoint, onForkCheckpoint)}</div>
      </div>
    </div>
  );
}

function seedDraft(plan: PlanJson): PlanJson {
  return {
    schemaVersion: plan.schemaVersion ?? 2,
    title: plan.title,
    goal: plan.goal,
    risks: [...(plan.risks ?? [])],
    verificationCommands: [...(plan.verificationCommands ?? [])],
    workspace: plan.workspace,
    tasks: (plan.tasks ?? []).map((task) => ({
      title: task.title,
      description: task.description,
      objective: task.objective ?? task.description,
      taskKind: task.taskKind ?? "modify",
      targetFiles: [...(task.targetFiles ?? [])],
      expectedChanges: [...(task.expectedChanges ?? [])],
      acceptanceCriteria: [...(task.acceptanceCriteria ?? [])],
      verificationHints: [...(task.verificationHints ?? [])],
      riskLevel: task.riskLevel ?? "low",
    })),
  };
}

function emptyTask(): PlanTaskInput {
  return {
    title: "",
    description: "",
    objective: "",
    taskKind: "modify",
    targetFiles: [],
    expectedChanges: [],
    acceptanceCriteria: [],
    verificationHints: [],
    riskLevel: "low",
  };
}

interface PlanDrawerProps {
  view: Extract<DrawerView, { kind: "plan" }>;
  busy: boolean;
  onClose: () => void;
  onSavePlanAndRun: (planId: string, planJson: PlanJson) => Promise<void>;
}

function PlanDrawer({ view, busy, onClose, onSavePlanAndRun }: PlanDrawerProps): React.ReactElement {
  const { plan, canEdit } = view;
  const [editing, setEditing] = useState<boolean>(view.mode === "edit" && canEdit);
  const [draft, setDraft] = useState<PlanJson>(() => seedDraft(plan.planJson));

  useEffect(() => {
    setDraft(seedDraft(plan.planJson));
    setEditing(view.mode === "edit" && canEdit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan.id, view.mode, canEdit]);

  const validation = useMemo(() => validateAndNormalizeEditedPlan(draft, plan.planJson), [draft, plan.planJson]);

  const updateTask = (index: number, updated: PlanTaskInput): void => {
    setDraft((current) => ({ ...current, tasks: current.tasks.map((task, i) => (i === index ? updated : task)) }));
  };
  const removeTask = (index: number): void => {
    setDraft((current) => ({ ...current, tasks: current.tasks.filter((_, i) => i !== index) }));
  };
  const moveTask = (index: number, delta: number): void => {
    setDraft((current) => {
      const next = [...current.tasks];
      const target = index + delta;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return { ...current, tasks: next };
    });
  };
  const addTask = (): void => {
    setDraft((current) => ({ ...current, tasks: [...current.tasks, emptyTask()] }));
  };

  const save = (): void => {
    if (!validation.ok || busy) return;
    void onSavePlanAndRun(plan.id, validation.plan);
  };

  if (!editing) {
    return (
      <>
        <header className="drawer-header">
          <h2>Plan v{plan.version}: {plan.title}</h2>
          <div className="drawer-header-actions">
            {canEdit ? (
              <button type="button" className="primary small" onClick={() => setEditing(true)}>
                Edit
              </button>
            ) : null}
            <button type="button" className="ghost" onClick={onClose} aria-label="Close drawer">✕</button>
          </div>
        </header>
        <div className="drawer-body">
          <p className="muted">
            Version {plan.version} · {plan.status} · created by {plan.createdByAgent}
          </p>
          <pre className="drawer-pre">{plan.planMarkdown}</pre>
        </div>
      </>
    );
  }

  return (
    <>
      <header className="drawer-header">
        <h2>Edit plan v{plan.version}</h2>
        <button type="button" className="ghost" onClick={onClose} aria-label="Close drawer">✕</button>
      </header>
      <div className="drawer-body plan-editor">
        <label className="field">
          <span className="field-label">Title</span>
          <input
            type="text"
            value={draft.title}
            onChange={(e) => setDraft((current) => ({ ...current, title: e.target.value }))}
          />
        </label>
        <label className="field">
          <span className="field-label">Goal</span>
          <textarea
            rows={2}
            value={draft.goal}
            onChange={(e) => setDraft((current) => ({ ...current, goal: e.target.value }))}
          />
        </label>

        <ListEditor
          label="Risks"
          values={draft.risks}
          placeholder="Describe a risk or constraint"
          onChange={(values) => setDraft((current) => ({ ...current, risks: values }))}
        />
        <ListEditor
          label="Verification commands"
          values={draft.verificationCommands}
          placeholder="e.g. npm run typecheck"
          onChange={(values) => setDraft((current) => ({ ...current, verificationCommands: values }))}
        />

        <div className="plan-editor-tasks">
          <div className="plan-editor-tasks-head">
            <h3>Tasks ({draft.tasks.length})</h3>
            <button type="button" className="ghost small" onClick={addTask}>+ Add task</button>
          </div>
          {draft.tasks.map((task, index) => (
            <TaskEditor
              key={index}
              task={task}
              index={index}
              canMoveUp={index > 0}
              canMoveDown={index < draft.tasks.length - 1}
              onChange={(updated) => updateTask(index, updated)}
              onRemove={() => removeTask(index)}
              onMoveUp={() => moveTask(index, -1)}
              onMoveDown={() => moveTask(index, 1)}
            />
          ))}
        </div>

        {!validation.ok ? (
          <ul className="plan-editor-errors" role="alert">
            {validation.errors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        ) : validation.warnings.length > 0 ? (
          <ul className="plan-editor-warnings">
            {validation.warnings.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        ) : null}
      </div>
      <footer className="drawer-footer">
        <button type="button" className="ghost" disabled={busy} onClick={() => { setDraft(seedDraft(plan.planJson)); setEditing(false); }}>
          Cancel
        </button>
        <button type="button" className="primary" disabled={busy || !validation.ok} onClick={save}>
          Save &amp; run
        </button>
      </footer>
    </>
  );
}

interface ListEditorProps {
  label: string;
  values: string[];
  placeholder?: string;
  onChange: (values: string[]) => void;
}

function ListEditor({ label, values, placeholder, onChange }: ListEditorProps): React.ReactElement {
  const update = (index: number, value: string): void => {
    onChange(values.map((entry, i) => (i === index ? value : entry)));
  };
  const remove = (index: number): void => {
    onChange(values.filter((_, i) => i !== index));
  };
  const add = (): void => {
    onChange([...values, ""]);
  };

  return (
    <div className="list-editor">
      <div className="list-editor-head">
        <span className="field-label">{label}</span>
        <button type="button" className="ghost small" onClick={add}>+ Add</button>
      </div>
      {values.length === 0 ? <p className="muted small">None.</p> : null}
      {values.map((value, index) => (
        <div key={index} className="list-editor-row">
          <input
            type="text"
            value={value}
            placeholder={placeholder}
            onChange={(e) => update(index, e.target.value)}
          />
          <button type="button" className="ghost small" onClick={() => remove(index)} aria-label={`Remove ${label} item`}>✕</button>
        </div>
      ))}
    </div>
  );
}

interface TaskEditorProps {
  task: PlanTaskInput;
  index: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onChange: (task: PlanTaskInput) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}

function TaskEditor({ task, index, canMoveUp, canMoveDown, onChange, onRemove, onMoveUp, onMoveDown }: TaskEditorProps): React.ReactElement {
  const patch = (partial: Partial<PlanTaskInput>): void => onChange({ ...task, ...partial });

  return (
    <div className="task-editor">
      <div className="task-editor-head">
        <span className="card-kind">Task {index + 1}</span>
        <div className="task-editor-actions">
          <button type="button" className="ghost small" disabled={!canMoveUp} onClick={onMoveUp} aria-label="Move task up">↑</button>
          <button type="button" className="ghost small" disabled={!canMoveDown} onClick={onMoveDown} aria-label="Move task down">↓</button>
          <button type="button" className="ghost small danger-text" onClick={onRemove} aria-label="Remove task">Remove</button>
        </div>
      </div>
      <label className="field">
        <span className="field-label">Title</span>
        <input type="text" value={task.title} onChange={(e) => patch({ title: e.target.value })} />
      </label>
      <label className="field">
        <span className="field-label">Objective</span>
        <textarea rows={2} value={task.objective ?? task.description} onChange={(e) => patch({ objective: e.target.value, description: e.target.value })} />
      </label>
      <div className="task-editor-selects">
        <label className="field">
          <span className="field-label">Kind</span>
          <select value={task.taskKind ?? "modify"} onChange={(e) => patch({ taskKind: e.target.value as PlanTaskInput["taskKind"] })}>
            {EDITABLE_TASK_KINDS.map((kind) => (
              <option key={kind} value={kind}>{kind}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Risk</span>
          <select value={task.riskLevel ?? "low"} onChange={(e) => patch({ riskLevel: e.target.value as PlanTaskInput["riskLevel"] })}>
            {RISK_LEVELS.map((level) => (
              <option key={level} value={level}>{level}</option>
            ))}
          </select>
        </label>
      </div>
      <ListEditor label="Target files" values={task.targetFiles ?? []} placeholder="e.g. app/page.tsx" onChange={(values) => patch({ targetFiles: values })} />
      <ListEditor label="Expected changes" values={task.expectedChanges ?? []} placeholder="Describe a change" onChange={(values) => patch({ expectedChanges: values })} />
      <ListEditor label="Acceptance criteria" values={task.acceptanceCriteria} placeholder="A verifiable condition" onChange={(values) => patch({ acceptanceCriteria: values })} />
      <ListEditor label="Verification hints" values={task.verificationHints ?? []} placeholder="Optional hint" onChange={(values) => patch({ verificationHints: values })} />
    </div>
  );
}

function SkillsDrawer({
  view,
  busy,
  onClose,
  onRefreshSkills,
  onUpdateSkill,
  onDeleteSkill,
  onCreateSkill,
  onImportSkillFiles,
}: {
  view: Extract<DrawerView, { kind: "skills" }>;
  busy: boolean;
  onClose: () => void;
  onRefreshSkills: () => Promise<void>;
  onUpdateSkill: (skillId: string, patch: { enabled?: boolean; allowImplicit?: boolean; trusted?: boolean }) => Promise<void>;
  onDeleteSkill: (skillId: string) => Promise<void>;
  onCreateSkill: (input: { name: string; description: string; body: string; allowImplicit: boolean }) => Promise<void>;
  onImportSkillFiles: (files: FileList | File[]) => Promise<void>;
}): React.ReactElement {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [skillName, setSkillName] = useState("");
  const [skillDescription, setSkillDescription] = useState("");
  const [skillBody, setSkillBody] = useState("");
  const [allowImplicit, setAllowImplicit] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);
  const sorted = [...view.skills].sort((a, b) => a.name.localeCompare(b.name));
  const appSkills = sorted.filter((skill) => skill.sourceScope === "app");
  const workspaceSkills = sorted.filter((skill) => skill.sourceScope === "workspace");
  const diagnostics = sorted.filter((skill) => skill.diagnostics.length > 0 || !skill.trusted);
  const canCreate = skillName.trim().length > 0 && skillBody.trim().length > 0 && !busy;
  const createSkill = (): void => {
    if (!canCreate) {
      setFormError("Skill name and instructions are required.");
      return;
    }
    setFormError(null);
    void onCreateSkill({
      name: skillName,
      description: skillDescription,
      body: skillBody,
      allowImplicit,
    }).then(() => {
      setSkillName("");
      setSkillDescription("");
      setSkillBody("");
      setAllowImplicit(true);
    }).catch((error: unknown) => {
      setFormError(error instanceof Error ? error.message : "Skill could not be saved.");
    });
  };
  const importSelectedFiles = (files: FileList | null): void => {
    if (files === null || files.length === 0) return;
    setFormError(null);
    void onImportSkillFiles(files).catch((error: unknown) => {
      setFormError(error instanceof Error ? error.message : "Skill files could not be imported.");
    }).finally(() => {
      if (fileInputRef.current !== null) fileInputRef.current.value = "";
    });
  };
  const deleteSkill = (skill: SkillRecord): void => {
    const label = skill.displayName ?? skill.name;
    if (!window.confirm(`Delete "${label}" from app skills? This removes its .skills Markdown file.`)) {
      return;
    }
    setFormError(null);
    void onDeleteSkill(skill.id).catch((error: unknown) => {
      setFormError(error instanceof Error ? error.message : "Skill could not be deleted.");
    });
  };
  const renderSkill = (skill: SkillRecord): React.ReactElement => (
    <article key={skill.id} className="skill-card">
      <div className="skill-card-head">
        <div>
          <h3>{skill.displayName ?? skill.name}</h3>
          <p>{skill.description}</p>
        </div>
        <span className={`skill-source skill-source-${skill.sourceScope}`}>{skill.sourceScope}</span>
      </div>
      <p className="muted small">{skill.sourcePath}</p>
      {skill.bodyPreview.length > 0 ? <p className="skill-preview">{skill.bodyPreview}</p> : null}
      {skill.diagnostics.length > 0 ? (
        <ul className="skill-diagnostics">
          {skill.diagnostics.map((item) => <li key={item}>{item}</li>)}
        </ul>
      ) : null}
      {!skill.trusted ? <p className="runtime-status-error small">Review and trust this skill before implicit use.</p> : null}
      <div className="skill-actions">
        <label className="skill-toggle">
          <input type="checkbox" checked={skill.enabled} disabled={busy} onChange={(event) => void onUpdateSkill(skill.id, { enabled: event.currentTarget.checked })} />
          <span>Enabled</span>
        </label>
        <label className="skill-toggle">
          <input type="checkbox" checked={skill.allowImplicit} disabled={busy || !skill.enabled || !skill.trusted} onChange={(event) => void onUpdateSkill(skill.id, { allowImplicit: event.currentTarget.checked })} />
          <span>Implicit</span>
        </label>
        {!skill.trusted ? (
          <button type="button" className="small" disabled={busy} onClick={() => void onUpdateSkill(skill.id, { trusted: true, enabled: true })}>
            Trust
          </button>
        ) : null}
        {skill.sourceScope === "app" && skill.sourceType === "app-md" ? (
          <button type="button" className="ghost small danger-text" disabled={busy} onClick={() => deleteSkill(skill)}>
            Delete
          </button>
        ) : null}
      </div>
    </article>
  );

  return (
    <>
      <header className="drawer-header">
        <div>
          <h2>Skills</h2>
          <p className="muted small">Provider-neutral workflow guidance loaded by the orchestrator.</p>
        </div>
        <button type="button" className="ghost" onClick={onClose} aria-label="Close drawer">×</button>
      </header>
      <div className="drawer-body skills-drawer">
        <section className="runtime-section skill-compose-section">
          <div className="runtime-section-head">
            <div>
              <h3>Create Skill</h3>
              <p>Save reusable instructions as an app-level Markdown skill available to every provider.</p>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".md,.markdown,.txt,text/markdown,text/plain"
              multiple
              className="composer-file-input"
              onChange={(event) => importSelectedFiles(event.target.files)}
            />
            <button
              type="button"
              className="composer-plus skill-import-plus"
              disabled={busy}
              onClick={() => fileInputRef.current?.click()}
              aria-label="Import skill files"
              title="Import Markdown or text skill files"
            >
              <span className="composer-plus-icon" aria-hidden />
            </button>
          </div>
          <div className="skill-form-grid">
            <label className="runtime-field">
              <span className="runtime-field-label">Name</span>
              <input type="text" value={skillName} placeholder="e.g. React Accessibility Review" onChange={(event) => setSkillName(event.target.value)} />
            </label>
            <label className="runtime-field">
              <span className="runtime-field-label">Description</span>
              <input type="text" value={skillDescription} placeholder="When this skill should be used" onChange={(event) => setSkillDescription(event.target.value)} />
            </label>
            <label className="runtime-field runtime-field-wide">
              <span className="runtime-field-label">Instructions</span>
              <textarea
                rows={10}
                value={skillBody}
                placeholder="Paste the workflow, checklist, constraints, examples, or provider-neutral guidance..."
                onChange={(event) => setSkillBody(event.target.value)}
              />
            </label>
          </div>
          <div className="skill-form-actions">
            <label className="skill-toggle">
              <input type="checkbox" checked={allowImplicit} disabled={busy} onChange={(event) => setAllowImplicit(event.currentTarget.checked)} />
              <span>Allow implicit activation</span>
            </label>
            <button type="button" className="primary small" disabled={!canCreate} onClick={createSkill}>
              Save skill
            </button>
          </div>
          {formError !== null ? <p className="runtime-status-error small" role="alert">{formError}</p> : null}
        </section>
        <section className="runtime-section">
          <div className="runtime-section-head">
            <div>
              <h3>Sources</h3>
              <p>App skills come from <code>.skills/*.md</code>. Workspace skills come from <code>.agents/skills/*/SKILL.md</code>.</p>
            </div>
            <button type="button" className="ghost small" disabled={busy} onClick={() => void onRefreshSkills()}>Refresh</button>
          </div>
        </section>
        {diagnostics.length > 0 ? (
          <section className="runtime-section">
            <div className="runtime-section-head">
              <div>
                <h3>Needs Review</h3>
                <p>Changed or untrusted workspace skills cannot run implicitly until trusted.</p>
              </div>
            </div>
            <div className="skill-list">{diagnostics.map(renderSkill)}</div>
          </section>
        ) : null}
        <section className="runtime-section">
          <div className="runtime-section-head">
            <div>
              <h3>App Skills</h3>
              <p>{appSkills.length} app-level skill{appSkills.length === 1 ? "" : "s"} available to every provider.</p>
            </div>
          </div>
          <div className="skill-list">{appSkills.length > 0 ? appSkills.map(renderSkill) : <p className="muted small">No app skills found in .skills yet.</p>}</div>
        </section>
        <section className="runtime-section">
          <div className="runtime-section-head">
            <div>
              <h3>Workspace Skills</h3>
              <p>{workspaceSkills.length} Codex-compatible workspace skill{workspaceSkills.length === 1 ? "" : "s"} discovered for this chat.</p>
            </div>
          </div>
          <div className="skill-list">{workspaceSkills.length > 0 ? workspaceSkills.map(renderSkill) : <p className="muted small">No workspace skills found for the active workspace.</p>}</div>
        </section>
      </div>
    </>
  );
}

function ProjectMemoryDrawer({
  view,
  busy,
  onClose,
  onCreateUserMemory,
  onUpdateUserMemory,
  onDeleteUserMemory,
  onCreateProjectMemory,
  onUpdateProjectMemory,
  onDeleteProjectMemory,
}: {
  view: Extract<DrawerView, { kind: "memory" }>;
  busy: boolean;
  onClose: () => void;
  onCreateUserMemory: (input: { content: string; status: UserMemoryStatus; pinned: boolean }) => Promise<void>;
  onUpdateUserMemory: (memoryId: string, patch: Partial<Pick<UserMemoryRecord, "content" | "status" | "pinned">>) => Promise<void>;
  onDeleteUserMemory: (memoryId: string) => Promise<void>;
  onCreateProjectMemory: (input: { content: string; category: ProjectMemoryCategory; scope: ProjectMemoryScope; status: ProjectMemoryStatus; pinned: boolean }) => Promise<void>;
  onUpdateProjectMemory: (memoryId: string, patch: Partial<Pick<ProjectMemoryRecord, "content" | "category" | "scope" | "status" | "pinned">>) => Promise<void>;
  onDeleteProjectMemory: (memoryId: string) => Promise<void>;
}): React.ReactElement {
  const [userContent, setUserContent] = useState("");
  const [userStatus, setUserStatus] = useState<UserMemoryStatus>("active");
  const [userPinned, setUserPinned] = useState(false);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [editUserContent, setEditUserContent] = useState("");
  const [editUserStatus, setEditUserStatus] = useState<UserMemoryStatus>("active");
  const [content, setContent] = useState("");
  const [category, setCategory] = useState<ProjectMemoryCategory>("decision");
  const [scope, setScope] = useState<ProjectMemoryScope>("project");
  const [status, setStatus] = useState<ProjectMemoryStatus>("active");
  const [pinned, setPinned] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [editCategory, setEditCategory] = useState<ProjectMemoryCategory>("decision");
  const [editScope, setEditScope] = useState<ProjectMemoryScope>("project");
  const [editStatus, setEditStatus] = useState<ProjectMemoryStatus>("active");
  const [error, setError] = useState<string | null>(null);
  const staleView = view as Extract<DrawerView, { kind: "memory" }> & { memories?: ProjectMemoryRecord[] };
  const userMemories = view.userMemories ?? [];
  const projectMemories = view.projectMemories ?? staleView.memories ?? [];
  const activeUser = userMemories.filter((memory) => memory.status === "active");
  const dismissedUser = userMemories.filter((memory) => memory.status === "dismissed");
  const active = projectMemories.filter((memory) => memory.status === "active");
  const candidates = projectMemories.filter((memory) => memory.status === "candidate");
  const dismissed = projectMemories.filter((memory) => memory.status === "dismissed");
  const saveUser = (): void => {
    if (userContent.trim().length === 0) {
      setError("User memory content is required.");
      return;
    }
    setError(null);
    void onCreateUserMemory({ content: userContent, status: userStatus, pinned: userPinned }).then(() => {
      setUserContent("");
      setUserStatus("active");
      setUserPinned(false);
    }).catch((saveError: unknown) => setError(saveError instanceof Error ? saveError.message : "User memory could not be saved."));
  };
  const save = (): void => {
    if (content.trim().length === 0) {
      setError("Memory content is required.");
      return;
    }
    setError(null);
    void onCreateProjectMemory({ content, category, scope, status, pinned }).then(() => {
      setContent("");
      setCategory("decision");
      setScope("project");
      setStatus("active");
      setPinned(false);
    }).catch((saveError: unknown) => setError(saveError instanceof Error ? saveError.message : "Project memory could not be saved."));
  };
  const startUserEdit = (memory: UserMemoryRecord): void => {
    setEditingUserId(memory.id);
    setEditUserContent(memory.content);
    setEditUserStatus(memory.status);
    setEditingId(null);
  };
  const saveUserEdit = (memory: UserMemoryRecord): void => {
    if (editUserContent.trim().length === 0) {
      setError("User memory content is required.");
      return;
    }
    setError(null);
    void onUpdateUserMemory(memory.id, {
      content: editUserContent,
      status: editUserStatus,
    }).then(() => {
      setEditingUserId(null);
    });
  };
  const startEdit = (memory: ProjectMemoryRecord): void => {
    setEditingId(memory.id);
    setEditContent(memory.content);
    setEditCategory(memory.category);
    setEditScope(memory.scope);
    setEditStatus(memory.status);
    setEditingUserId(null);
  };
  const saveEdit = (memory: ProjectMemoryRecord): void => {
    if (editContent.trim().length === 0) {
      setError("Memory content is required.");
      return;
    }
    setError(null);
    void onUpdateProjectMemory(memory.id, {
      content: editContent,
      category: editCategory,
      scope: editScope,
      status: editStatus,
    }).then(() => {
      setEditingId(null);
    });
  };
  const renderMemory = (memory: ProjectMemoryRecord): React.ReactElement => {
    const editing = editingId === memory.id;
    return (
    <article key={memory.id} className="skill-card">
      <div className="skill-card-head">
        <div>
          <h3>{memory.category}</h3>
          {editing ? null : <p>{memory.content}</p>}
        </div>
        <span className={`skill-source skill-source-${memory.status}`}>{memory.status}</span>
      </div>
      {editing ? (
        <div className="skill-form-grid">
          <label className="runtime-field runtime-field-wide">
            <span className="runtime-field-label">Memory text</span>
            <textarea rows={5} value={editContent} onChange={(event) => setEditContent(event.target.value)} />
          </label>
          <label className="runtime-field">
            <span className="runtime-field-label">Category</span>
            <select value={editCategory} onChange={(event) => setEditCategory(event.target.value as ProjectMemoryCategory)}>
              {["architecture", "style", "constraint", "verification", "decision", "handoff"].map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
          <label className="runtime-field">
            <span className="runtime-field-label">Scope</span>
            <select value={editScope} onChange={(event) => setEditScope(event.target.value as ProjectMemoryScope)}>
              {["project", "session", "lineage"].map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
          <label className="runtime-field">
            <span className="runtime-field-label">Status</span>
            <select value={editStatus} onChange={(event) => setEditStatus(event.target.value as ProjectMemoryStatus)}>
              {["active", "candidate", "dismissed"].map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
        </div>
      ) : null}
      <p className="muted small">
        {memory.scope} · {memory.sourceKind}{memory.sourceProvider !== null ? ` · ${memory.sourceProvider}` : ""} · confidence {Math.round(memory.confidence * 100)}%
      </p>
      <div className="skill-actions">
        <label className="skill-toggle">
          <input type="checkbox" checked={memory.pinned} disabled={busy} onChange={(event) => void onUpdateProjectMemory(memory.id, { pinned: event.currentTarget.checked })} />
          <span>Pinned</span>
        </label>
        {editing ? (
          <>
            <button type="button" className="primary small" disabled={busy || editContent.trim().length === 0} onClick={() => saveEdit(memory)}>Save</button>
            <button type="button" className="ghost small" disabled={busy} onClick={() => setEditingId(null)}>Cancel</button>
          </>
        ) : (
          <>
            <button type="button" className="small" disabled={busy} onClick={() => startEdit(memory)}>Edit</button>
            {memory.status !== "active" ? (
              <button type="button" className="small" disabled={busy} onClick={() => void onUpdateProjectMemory(memory.id, { status: "active" })}>Activate</button>
            ) : null}
            {memory.status !== "dismissed" ? (
              <button type="button" className="ghost small" disabled={busy} onClick={() => void onUpdateProjectMemory(memory.id, { status: "dismissed" })}>Dismiss</button>
            ) : null}
          </>
        )}
        <button type="button" className="ghost small danger-text" disabled={busy} onClick={() => {
          if (window.confirm("Delete this project memory?")) void onDeleteProjectMemory(memory.id);
        }}>
          Delete
        </button>
      </div>
    </article>
  );
  };
  const renderUserMemory = (memory: UserMemoryRecord): React.ReactElement => {
    const editing = editingUserId === memory.id;
    return (
      <article key={memory.id} className="skill-card">
        <div className="skill-card-head">
          <div>
            <h3>User Memory</h3>
            {editing ? null : <p>{memory.content}</p>}
          </div>
          <span className={`skill-source skill-source-${memory.status}`}>{memory.status}</span>
        </div>
        {editing ? (
          <div className="skill-form-grid">
            <label className="runtime-field runtime-field-wide">
              <span className="runtime-field-label">Memory text</span>
              <textarea rows={5} value={editUserContent} onChange={(event) => setEditUserContent(event.target.value)} />
            </label>
            <label className="runtime-field">
              <span className="runtime-field-label">Status</span>
              <select value={editUserStatus} onChange={(event) => setEditUserStatus(event.target.value as UserMemoryStatus)}>
                {["active", "dismissed"].map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </label>
          </div>
        ) : null}
        <p className="muted small">app-wide - {memory.lastInjectedAt === null ? "not injected yet" : `last injected ${formatTime(memory.lastInjectedAt)}`}</p>
        <div className="skill-actions">
          <label className="skill-toggle">
            <input type="checkbox" checked={memory.pinned} disabled={busy} onChange={(event) => void onUpdateUserMemory(memory.id, { pinned: event.currentTarget.checked })} />
            <span>Pinned</span>
          </label>
          {editing ? (
            <>
              <button type="button" className="primary small" disabled={busy || editUserContent.trim().length === 0} onClick={() => saveUserEdit(memory)}>Save</button>
              <button type="button" className="ghost small" disabled={busy} onClick={() => setEditingUserId(null)}>Cancel</button>
            </>
          ) : (
            <>
              <button type="button" className="small" disabled={busy} onClick={() => startUserEdit(memory)}>Edit</button>
              {memory.status !== "active" ? (
                <button type="button" className="small" disabled={busy} onClick={() => void onUpdateUserMemory(memory.id, { status: "active" })}>Activate</button>
              ) : null}
              {memory.status !== "dismissed" ? (
                <button type="button" className="ghost small" disabled={busy} onClick={() => void onUpdateUserMemory(memory.id, { status: "dismissed" })}>Dismiss</button>
              ) : null}
            </>
          )}
          <button type="button" className="ghost small danger-text" disabled={busy} onClick={() => {
            if (window.confirm("Delete this user memory?")) void onDeleteUserMemory(memory.id);
          }}>
            Delete
          </button>
        </div>
      </article>
    );
  };

  return (
    <>
      <header className="drawer-header">
        <div>
          <h2>Memory</h2>
          <p className="muted small">User memory is app-wide. Project memory is scoped to this project and cross-provider handoff.</p>
        </div>
        <button type="button" className="ghost" onClick={onClose} aria-label="Close drawer">×</button>
      </header>
      <div className="drawer-body skills-drawer">
        <section className="runtime-section skill-compose-section">
          <div className="runtime-section-head">
            <div>
              <h3>Add User Memory</h3>
              <p>Save an app-wide preference or durable personal context for every project and provider.</p>
            </div>
          </div>
          <div className="skill-form-grid">
            <label className="runtime-field runtime-field-wide">
              <span className="runtime-field-label">User memory text</span>
              <textarea rows={5} value={userContent} placeholder="e.g. Prefer dense, utilitarian UI for operational tools." onChange={(event) => setUserContent(event.target.value)} />
            </label>
            <label className="runtime-field">
              <span className="runtime-field-label">Status</span>
              <select value={userStatus} onChange={(event) => setUserStatus(event.target.value as UserMemoryStatus)}>
                {["active", "dismissed"].map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </label>
          </div>
          <div className="skill-form-actions">
            <label className="skill-toggle">
              <input type="checkbox" checked={userPinned} disabled={busy} onChange={(event) => setUserPinned(event.currentTarget.checked)} />
              <span>Pin in prompt</span>
            </label>
            <button type="button" className="primary small" disabled={busy || userContent.trim().length === 0} onClick={saveUser}>Save user memory</button>
          </div>
          {error !== null ? <p className="runtime-status-error small" role="alert">{error}</p> : null}
        </section>
        <section className="runtime-section">
          <div className="runtime-section-head"><div><h3>User Memory</h3><p>{activeUser.length} active app-wide memories injected into every provider prompt.</p></div></div>
          <div className="skill-list">{activeUser.length > 0 ? activeUser.map(renderUserMemory) : <p className="muted small">No active user memories yet.</p>}</div>
        </section>
        {dismissedUser.length > 0 ? (
          <section className="runtime-section">
            <div className="runtime-section-head"><div><h3>Dismissed User Memory</h3><p>Kept out of prompts unless reactivated.</p></div></div>
            <div className="skill-list">{dismissedUser.map(renderUserMemory)}</div>
          </section>
        ) : null}
        <section className="runtime-section skill-compose-section">
          <div className="runtime-section-head">
            <div>
              <h3>Add Project Memory</h3>
              <p>Save a durable fact for this project. It is not raw chat history.</p>
            </div>
          </div>
          <div className="skill-form-grid">
            <label className="runtime-field runtime-field-wide">
              <span className="runtime-field-label">Memory text</span>
              <textarea rows={6} value={content} placeholder="e.g. This project uses plain CSS modules and avoids chart libraries." onChange={(event) => setContent(event.target.value)} />
            </label>
            <label className="runtime-field">
              <span className="runtime-field-label">Category</span>
              <select value={category} onChange={(event) => setCategory(event.target.value as ProjectMemoryCategory)}>
                {["architecture", "style", "constraint", "verification", "decision", "handoff"].map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </label>
            <label className="runtime-field">
              <span className="runtime-field-label">Scope</span>
              <select value={scope} onChange={(event) => setScope(event.target.value as ProjectMemoryScope)}>
                {["project", "session", "lineage"].map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </label>
            <label className="runtime-field">
              <span className="runtime-field-label">Status</span>
              <select value={status} onChange={(event) => setStatus(event.target.value as ProjectMemoryStatus)}>
                {["active", "candidate", "dismissed"].map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </label>
          </div>
          <div className="skill-form-actions">
            <label className="skill-toggle">
              <input type="checkbox" checked={pinned} disabled={busy} onChange={(event) => setPinned(event.currentTarget.checked)} />
              <span>Pin in prompt</span>
            </label>
            <button type="button" className="primary small" disabled={busy || content.trim().length === 0} onClick={save}>Save project memory</button>
          </div>
          {error !== null ? <p className="runtime-status-error small" role="alert">{error}</p> : null}
        </section>
        <section className="runtime-section">
          <div className="runtime-section-head"><div><h3>Project Memory</h3><p>{active.length} active project memories injected into provider prompts for this project.</p></div></div>
          <div className="skill-list">{active.length > 0 ? active.map(renderMemory) : <p className="muted small">No active project memories yet.</p>}</div>
        </section>
        {candidates.length > 0 ? (
          <section className="runtime-section">
            <div className="runtime-section-head"><div><h3>Candidates</h3><p>Extracted from provider replies and waiting for review.</p></div></div>
            <div className="skill-list">{candidates.map(renderMemory)}</div>
          </section>
        ) : null}
        {dismissed.length > 0 ? (
          <section className="runtime-section">
            <div className="runtime-section-head"><div><h3>Dismissed Project Memory</h3><p>Kept out of prompts unless reactivated.</p></div></div>
            <div className="skill-list">{dismissed.map(renderMemory)}</div>
          </section>
        ) : null}
      </div>
    </>
  );
}

function RuntimeDrawer({
  view,
  busy,
  onClose,
  onSaveRuntime,
  onStartNativeReview,
}: {
  view: Extract<DrawerView, { kind: "runtime" }>;
  busy: boolean;
  onClose: () => void;
  onSaveRuntime: (provider: SelectableProvider, overrides: RuntimeOverrides | null, steeringNote: string) => Promise<void>;
  onStartNativeReview: () => Promise<void>;
}): React.ReactElement {
  const initial = view.workSession.runtimeOverrides;
  const [provider, setProvider] = useState<SelectableProvider>(
    view.workSession.agentProvider === "ollama"
      ? "ollama"
      : view.workSession.agentProvider === "claude-code"
        ? "claude-code"
        : view.workSession.agentProvider === "antigravity-cli"
          ? "antigravity-cli"
          : "codex-cli",
  );
  const isOllama = provider === "ollama";
  const isClaude = provider === "claude-code";
  const isAgy = provider === "antigravity-cli";
  const isCodex = provider === "codex-cli";
  const [model, setModel] = useState(initial?.model ?? "");
  const [effort, setEffort] = useState<"" | ReasoningEffort>(initial?.reasoningEffort ?? "");
  const [serviceTier, setServiceTier] = useState(initial?.serviceTier ?? "");
  const [runtimeOptions, setRuntimeOptions] = useState<CodexRuntimeOptions | null>(null);
  const [runtimeOptionsError, setRuntimeOptionsError] = useState<string | null>(null);
  const [sandbox, setSandbox] = useState<"" | ExecutorSandboxMode>(initial?.sandboxMode ?? "");
  const [network, setNetwork] = useState<"" | "on" | "off">(
    initial?.networkAccess === null || initial?.networkAccess === undefined ? "" : initial.networkAccess ? "on" : "off",
  );
  const [codexTransportMode, setCodexTransportMode] = useState<"" | CodexTransportMode>(initial?.codexTransportMode ?? "");
  const [timeoutSec, setTimeoutSec] = useState(initial?.timeoutMs != null ? String(Math.round(initial.timeoutMs / 1000)) : "");
  const [temperature, setTemperature] = useState(initial?.temperature != null ? String(initial.temperature) : "");
  const [numCtx, setNumCtx] = useState(initial?.numCtx != null ? String(initial.numCtx) : "");
  const [ultracode, setUltracode] = useState<boolean>(initial?.ultracode === true);
  const [steering, setSteering] = useState(view.workSession.steeringNote);
  const modelOptions = runtimeOptions?.models ?? emptyCodexModelOptions;
  const defaultModelSlug = runtimeOptions?.defaults.model ?? null;
  const defaultModel = defaultModelSlug === null ? null : modelOptions.find((candidate) => candidate.slug === defaultModelSlug) ?? null;
  const selectedModel = useMemo<CodexModelOption | null>(() => {
    if (model.trim().length === 0) {
      return null;
    }
    return modelOptions.find((candidate) => candidate.slug === model.trim()) ?? null;
  }, [model, modelOptions]);
  const modelIsCataloged = model.trim().length === 0 || selectedModel !== null;
  const activeModel = selectedModel ?? defaultModel;
  const effortOptions = useMemo(
    () => activeModel?.supportedReasoningLevels.map((level) => level.effort) ?? fallbackReasoningEfforts,
    [activeModel],
  );
  const serviceTierOptions = useMemo(
    () => activeModel?.serviceTiers ?? [],
    [activeModel],
  );
  const effectiveModelLabel = model.trim().length > 0
    ? labelForModelSlug(modelOptions, model.trim())
    : labelForModelSlug(modelOptions, defaultModelSlug);
  const effectiveReasoningEffort = effort.trim().length > 0
    ? effort
    : runtimeOptions?.defaults.reasoningEffort ?? activeModel?.defaultReasoningLevel ?? null;
  const defaultServiceTier = runtimeOptions?.defaults.serviceTier ?? activeModel?.defaultServiceTier ?? null;
  const effectiveServiceTier = serviceTier === standardServiceTier
    ? "standard"
    : serviceTier.trim().length > 0
      ? serviceTierOptions.find((option) => option.id === serviceTier)?.name ?? serviceTier
      : defaultServiceTier === null
        ? "provider default"
        : serviceTierOptions.find((option) => option.id === defaultServiceTier)?.name ?? defaultServiceTier;
  const effectiveSandbox = sandbox === "" ? runtimeOptions?.defaults.sandboxMode ?? "configured default" : sandbox;
  const effectiveNetwork = network === ""
    ? runtimeOptions?.defaults.networkAccess === null || runtimeOptions?.defaults.networkAccess === undefined
      ? "sandbox default"
      : runtimeOptions.defaults.networkAccess ? "on" : "off"
    : network;
  const effectiveCodexTransportMode = codexTransportMode === "" ? runtimeOptions?.defaults.codexTransportMode ?? null : codexTransportMode;
  const effectiveTimeoutSec = timeoutSec.trim().length > 0
    ? timeoutSec.trim()
    : runtimeOptions?.defaults.timeoutMs !== undefined
      ? String(Math.round(runtimeOptions.defaults.timeoutMs / 1000))
      : "configured default";

  useEffect(() => {
    let canceled = false;
    setRuntimeOptions(null);
    async function loadRuntimeOptions(): Promise<void> {
      try {
        const response = await fetch(`/api/runtime-options?provider=${provider}`, { cache: "no-store" });
        const body = (await response.json()) as unknown;
        if (canceled) return;
        if (typeof body === "object" && body !== null && (body as { ok?: unknown }).ok === true) {
          setRuntimeOptions((body as { data: CodexRuntimeOptions }).data);
          setRuntimeOptionsError(null);
          return;
        }
        setRuntimeOptionsError(
          typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string"
            ? (body as { error: string }).error
            : "Unable to load runtime options.",
        );
      } catch (error) {
        if (!canceled) {
          setRuntimeOptionsError(error instanceof Error ? error.message : "Unable to load runtime options.");
        }
      }
    }
    void loadRuntimeOptions();
    return () => {
      canceled = true;
    };
  }, [provider]);

  const changeProvider = (next: SelectableProvider): void => {
    if (next === provider) return;
    setProvider(next);
    setModel("");
    setEffort("");
    setServiceTier("");
    if (next === "ollama") {
      setSandbox("");
      setNetwork("");
      setCodexTransportMode("");
    } else {
      setTemperature("");
      setNumCtx("");
      if (next === "claude-code" || next === "antigravity-cli") {
        setSandbox("");
        setNetwork("");
      }
      if (next !== "codex-cli") {
        setCodexTransportMode("");
      }
    }
  };

  useEffect(() => {
    if (effort !== "" && !effortOptions.includes(effort)) {
      setEffort("");
    }
  }, [effort, effortOptions]);

  useEffect(() => {
    if (serviceTier !== "" && serviceTier !== standardServiceTier && !serviceTierOptions.some((option) => option.id === serviceTier)) {
      setServiceTier("");
    }
  }, [serviceTier, serviceTierOptions]);

  const save = (): void => {
    const overrides: RuntimeOverrides = {
      ...emptyRuntimeOverrides(),
      model: model.trim().length > 0 ? model.trim() : null,
      reasoningEffort: isOllama || isAgy || effort === "" ? null : effort,
      serviceTier: isCodex || isClaude ? serviceTier.trim().length > 0 ? serviceTier : null : null,
      sandboxMode: !isCodex || sandbox === "" ? null : sandbox,
      networkAccess: !isCodex || network === "" ? null : network === "on",
      codexTransportMode: !isCodex || codexTransportMode === "" ? null : codexTransportMode,
      timeoutMs:
        timeoutSec.trim().length > 0 && Number.isFinite(Number(timeoutSec)) && Number(timeoutSec) > 0
          ? Math.round(Number(timeoutSec) * 1000)
          : null,
      temperature:
        isOllama && temperature.trim().length > 0 && Number.isFinite(Number(temperature)) && Number(temperature) >= 0
          ? Number(temperature)
          : null,
      numCtx:
        isOllama && numCtx.trim().length > 0 && Number.isFinite(Number(numCtx)) && Number(numCtx) > 0
          ? Math.round(Number(numCtx))
          : null,
      ultracode: isClaude && ultracode ? true : null,
    };
    void onSaveRuntime(provider, isRuntimeOverridesEmpty(overrides) ? null : overrides, steering);
  };

  return (
    <>
      <header className="drawer-header">
        <h2>Runtime &amp; steering</h2>
        <button type="button" className="ghost" onClick={onClose} aria-label="Close drawer">
          ✕
        </button>
      </header>
      <div className="drawer-body runtime-drawer">
        <section className="runtime-section">
          <div className="runtime-section-head">
            <h3>Execution</h3>
            <p>Which coding agent runs each task, and how. Leave a field on “Inherit” to keep the value shown beneath it.</p>
          </div>
          <div className="runtime-grid">
            <label className="runtime-field">
              <span className="runtime-field-label">Coding provider</span>
              <select value={provider} onChange={(e) => changeProvider(e.target.value as SelectableProvider)} disabled={busy}>
                <option value="codex-cli">Codex CLI</option>
                <option value="claude-code">Claude Code</option>
                <option value="antigravity-cli">AGY CLI</option>
                <option value="ollama">Ollama (local)</option>
              </select>
              <span className="runtime-effective">now · {provider === "ollama" ? "Ollama" : provider === "claude-code" ? "Claude Code" : provider === "antigravity-cli" ? "AGY CLI" : "Codex CLI"}</span>
            </label>
            <label className="runtime-field">
              <span className="runtime-field-label">Model</span>
              <select value={model} onChange={(e) => setModel(e.target.value)} disabled={busy}>
                <option value="">Inherit</option>
                {!modelIsCataloged ? <option value={model}>{model} (saved)</option> : null}
                {modelOptions.map((option) => (
                  <option key={option.slug} value={option.slug}>
                    {option.displayName}
                  </option>
                ))}
              </select>
              <span className="runtime-effective">now · {effectiveModelLabel}</span>
            </label>
            {isCodex || isClaude ? (
              <>
                <label className="runtime-field">
                  <span className="runtime-field-label">Reasoning effort</span>
                  <select value={effort} onChange={(e) => setEffort(e.target.value as "" | ReasoningEffort)} disabled={busy || (isClaude && effortOptions.length === 0)}>
                    <option value="">{isClaude && effortOptions.length === 0 ? "Not supported" : "Inherit"}</option>
                    {effortOptions.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                  <span className="runtime-effective">now · {isClaude && effortOptions.length === 0 ? "not supported by model" : effectiveReasoningEffort ?? "model default"}</span>
                </label>
                {serviceTierOptions.length > 0 || serviceTier !== "" || defaultServiceTier !== null ? (
                  <label className="runtime-field">
                    <span className="runtime-field-label">Speed tier</span>
                    <select value={serviceTier} onChange={(e) => setServiceTier(e.target.value)} disabled={busy}>
                      <option value="">Inherit</option>
                      <option value={standardServiceTier}>Standard</option>
                      {serviceTier !== "" && serviceTier !== standardServiceTier && !serviceTierOptions.some((option) => option.id === serviceTier) ? (
                        <option value={serviceTier}>{serviceTier} (saved)</option>
                      ) : null}
                      {serviceTierOptions.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.name}
                        </option>
                      ))}
                    </select>
                    <span className="runtime-effective">now · {effectiveServiceTier}</span>
                  </label>
                ) : null}
                {isCodex ? (
                  <label className="runtime-field">
                    <span className="runtime-field-label">Sandbox</span>
                    <select value={sandbox} onChange={(e) => setSandbox(e.target.value as "" | ExecutorSandboxMode)} disabled={busy}>
                      <option value="">Inherit</option>
                      {executorSandboxModes.map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                    <span className="runtime-effective">now · {effectiveSandbox}</span>
                  </label>
                ) : (
                  <label className="runtime-field">
                    <span className="runtime-field-label">Permission mode</span>
                    <select value="acceptEdits" disabled>
                      <option value="acceptEdits">acceptEdits</option>
                    </select>
                    <span className="runtime-effective">configured on server</span>
                  </label>
                )}
                {isClaude ? (
                  <div className="runtime-field runtime-field-wide">
                    <span className="runtime-field-label">Ultracode (multi-agent)</span>
                    <div className="segmented" role="group" aria-label="Ultracode mode">
                      <button type="button" className={`segmented-option${!ultracode ? " segmented-option-on" : ""}`} aria-pressed={!ultracode} disabled={busy} onClick={() => setUltracode(false)}>
                        Off
                      </button>
                      <button type="button" className={`segmented-option${ultracode ? " segmented-option-on" : ""}`} aria-pressed={ultracode} disabled={busy} onClick={() => setUltracode(true)}>
                        On
                      </button>
                    </div>
                    <span className="runtime-effective">{ultracode ? "Claude may orchestrate subagents — high token cost" : "single agent (default)"}</span>
                  </div>
                ) : null}
              </>
            ) : (
              isOllama ? (
                <>
                  <label className="runtime-field">
                    <span className="runtime-field-label">Temperature</span>
                    <input type="number" min={0} max={2} step={0.1} value={temperature} onChange={(e) => setTemperature(e.target.value)} placeholder="Inherit" disabled={busy} />
                    <span className="runtime-effective">now · {temperature.trim().length > 0 ? temperature.trim() : "configured default"}</span>
                  </label>
                  <label className="runtime-field">
                    <span className="runtime-field-label">Context length (num_ctx)</span>
                    <input type="number" min={512} step={512} value={numCtx} onChange={(e) => setNumCtx(e.target.value)} placeholder="Inherit" disabled={busy} />
                    <span className="runtime-effective">now · {numCtx.trim().length > 0 ? numCtx.trim() : "model default"}</span>
                  </label>
                </>
              ) : (
                <label className="runtime-field">
                  <span className="runtime-field-label">Policy</span>
                  <select value="server" disabled>
                    <option value="server">Configured on server</option>
                  </select>
                  <span className="runtime-effective">AGY settings</span>
                </label>
              )
            )}
            <label className="runtime-field">
              <span className="runtime-field-label">Timeout (seconds)</span>
              <input type="number" min={10} step={10} value={timeoutSec} onChange={(e) => setTimeoutSec(e.target.value)} placeholder="Inherit" disabled={busy} />
              <span className="runtime-effective">now · {effectiveTimeoutSec}{/^\d+$/.test(effectiveTimeoutSec) ? "s" : ""}</span>
            </label>
            {isCodex ? (
              <div className="runtime-field runtime-field-wide">
                <span className="runtime-field-label">Network access</span>
                <div className="segmented" role="group" aria-label="Network access">
                  <button type="button" className={`segmented-option${network === "" ? " segmented-option-on" : ""}`} aria-pressed={network === ""} disabled={busy} onClick={() => setNetwork("")}>
                    Inherit
                  </button>
                  <button type="button" className={`segmented-option${network === "on" ? " segmented-option-on" : ""}`} aria-pressed={network === "on"} disabled={busy} onClick={() => setNetwork("on")}>
                    On
                  </button>
                  <button type="button" className={`segmented-option${network === "off" ? " segmented-option-on" : ""}`} aria-pressed={network === "off"} disabled={busy} onClick={() => setNetwork("off")}>
                    Off
                  </button>
                </div>
                <span className="runtime-effective">now · {effectiveNetwork}</span>
              </div>
            ) : null}
            {isCodex ? (
              <label className="runtime-field runtime-field-wide">
                <span className="runtime-field-label">Codex transport</span>
                <select value={codexTransportMode} onChange={(e) => setCodexTransportMode(e.target.value as "" | CodexTransportMode)} disabled={busy}>
                  <option value="">Inherit</option>
                  {codexTransportModes.map((value) => (
                    <option key={value} value={value}>
                      {codexTransportLabel(value)}
                    </option>
                  ))}
                </select>
                <span className="runtime-effective">now - {codexTransportEffectiveLabel(effectiveCodexTransportMode)}; last run - {codexLastTransportLabel(view.lastCodexTransport)}</span>
              </label>
            ) : null}
          </div>
        </section>

        <RuntimeLiveStatus
          provider={provider}
          workSessionId={view.workSession.id}
          model={model.trim().length > 0 ? model.trim() : defaultModelSlug}
          reasoningEffort={effort.trim().length > 0 ? effort : effectiveReasoningEffort}
        />

        {isCodex ? (
          <section className="runtime-section">
            <div className="runtime-section-head">
              <h3>Native review</h3>
              <p>Runs Codex app-server review against current workspace changes.</p>
            </div>
            <button type="button" className="ghost" disabled={busy} onClick={() => void onStartNativeReview()}>
              Review uncommitted changes
            </button>
          </section>
        ) : null}

        {isCodex ? <NativeCodexThreads workSession={view.workSession} busy={busy} /> : null}

        <section className="runtime-section">
          <div className="runtime-section-head">
            <h3>Steering note</h3>
            <p>Applied to planning and every task in this session.</p>
          </div>
          <div className="steering-editor">
            <textarea
              rows={6}
              value={steering}
              onChange={(e) => setSteering(e.target.value)}
              placeholder="e.g. Use TypeScript strict mode. Prefer plain CSS; do not add chart libraries."
              disabled={busy}
            />
            <div className="steering-editor-foot">
              <span className="muted small">{steering.trim().length} characters</span>
            </div>
          </div>
        </section>

        <p className="runtime-note muted small">
          {isOllama
            ? "Ollama runs as an orchestrator-owned agent loop: the model edits files through workspace-confined tools while the orchestrator owns dependency install, verification, and preview."
            : isClaude
              ? "Claude Code runs as a spawned local agent with edit tools enabled and shell/web tools disabled by default; the orchestrator owns dependency install, verification, and preview."
              : isAgy
                ? "AGY CLI runs as a spawned local Antigravity agent in print mode; the selected model is applied to AGY settings before launch, while context and permissions stay owned by AGY settings and env."
                : "Network access only applies under the workspace-write sandbox; danger-full-access already permits network."}
          {runtimeOptions !== null ? ` Catalog: ${runtimeOptions.source}${runtimeOptions.fetchedAt === null ? "" : `, ${new Date(runtimeOptions.fetchedAt).toLocaleTimeString()}`}.` : ""}
          {runtimeOptions?.native?.models ? " Native app-server catalog active." : ""}
          {runtimeOptionsError !== null ? ` Catalog unavailable: ${runtimeOptionsError}` : ""}
          {runtimeOptions?.error ? ` Latest refresh warning: ${runtimeOptions.error}` : ""}
        </p>
      </div>
      <footer className="drawer-footer">
        <button type="button" className="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="primary" onClick={save} disabled={busy}>
          Save
        </button>
      </footer>
    </>
  );
}

interface NativeCodexThreadData {
  threadId: string;
  subagents: CodexSubagentRecord[];
  collabCalls: CodexCollabCallRecord[];
  tree: CodexNativeThreadTreeNode;
}

function agentLabel(agent: Pick<CodexSubagentRecord, "threadId" | "agentNickname" | "agentRole">): string {
  return agent.agentNickname ?? agent.agentRole ?? agent.threadId.slice(0, 8);
}

function toolLabel(tool: CodexCollabCallRecord["tool"]): string {
  switch (tool) {
    case "spawnAgent":
      return "Spawn";
    case "sendInput":
      return "Message";
    case "resumeAgent":
      return "Resume";
    case "wait":
      return "Wait";
    case "closeAgent":
      return "Close";
    default:
      return "Collab";
  }
}

function collabTargetLabel(call: CodexCollabCallRecord, agentsById: Map<string, CodexSubagentRecord>): string {
  if (call.receiverThreadIds.length > 0) {
    return call.receiverThreadIds.map((id) => agentLabel(agentsById.get(id) ?? { threadId: id, agentNickname: null, agentRole: null })).join(", ");
  }
  if (call.tool === "spawnAgent") {
    if (call.status === "failed") return "no child thread";
    if (call.status === "stale") return "turn ended";
    return "pending child";
  }
  if (call.tool === "wait") return "mailbox";
  return "no target";
}

function collabChipTone(status: CodexCollabCallRecord["status"]): "success" | "danger" | "neutral" {
  if (status === "completed") return "success";
  if (status === "failed") return "danger";
  return "neutral";
}

function NativeCodexTreeNode({ node, root }: { node: CodexNativeThreadTreeNode; root?: boolean }): React.ReactElement {
  const label = node.agentNickname ?? node.agentRole ?? (root ? "Root" : node.threadId.slice(0, 8));
  return (
    <li className="codex-thread-node">
      <div className="codex-thread-row">
        <span className="codex-thread-name">{label}</span>
        <span className={`chip chip-${node.status === "completed" ? "success" : node.status === "errored" || node.status === "notFound" ? "danger" : "neutral"}`}>{root ? "root" : node.status}</span>
        <code>{node.threadId.slice(0, 8)}</code>
      </div>
      {node.lastMessage !== null ? <p className="muted small">{node.lastMessage.slice(0, 220)}</p> : null}
      {node.children.length > 0 ? (
        <ul className="codex-thread-tree">
          {node.children.map((child) => <NativeCodexTreeNode key={child.threadId} node={child} />)}
        </ul>
      ) : null}
    </li>
  );
}

function NativeCodexThreads({ workSession, busy }: { workSession: WorkSessionRecord; busy: boolean }): React.ReactElement {
  const [data, setData] = useState<NativeCodexThreadData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [rollbackTurns, setRollbackTurns] = useState("1");
  const [refreshKey, setRefreshKey] = useState(0);
  const hasThread = workSession.codexThreadId !== null;

  useEffect(() => {
    if (!hasThread) {
      setData(null);
      return;
    }
    let canceled = false;
    async function load(): Promise<void> {
      setLoading(true);
      try {
        const response = await fetch(`/api/work-sessions/${encodeURIComponent(workSession.id)}/codex-thread`, { cache: "no-store" });
        const body = (await response.json()) as unknown;
        if (canceled) return;
        if (typeof body === "object" && body !== null && (body as { ok?: unknown }).ok === true) {
          setData((body as { data: NativeCodexThreadData }).data);
          setError(null);
        } else {
          setError(
            typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string"
              ? (body as { error: string }).error
              : "Unable to load Codex native thread.",
          );
        }
      } catch (loadError) {
        if (!canceled) setError(loadError instanceof Error ? loadError.message : "Unable to load Codex native thread.");
      } finally {
        if (!canceled) setLoading(false);
      }
    }
    void load();
    return () => {
      canceled = true;
    };
  }, [hasThread, refreshKey, workSession.id]);

  async function rollback(): Promise<void> {
    const numTurns = Number(rollbackTurns);
    if (!Number.isInteger(numTurns) || numTurns <= 0) return;
    setLoading(true);
    try {
      const response = await fetch(`/api/work-sessions/${encodeURIComponent(workSession.id)}/codex-thread`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rollback", numTurns }),
      });
      const body = (await response.json()) as unknown;
      if (typeof body === "object" && body !== null && (body as { ok?: unknown }).ok === true) {
        setRefreshKey((key) => key + 1);
        setError(null);
      } else {
        setError(
          typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string"
            ? (body as { error: string }).error
            : "Rollback failed.",
        );
      }
    } catch (rollbackError) {
      setError(rollbackError instanceof Error ? rollbackError.message : "Rollback failed.");
    } finally {
      setLoading(false);
    }
  }

  const agentsById = new Map((data?.subagents ?? workSession.codexSubagents ?? []).map((agent) => [agent.threadId, agent]));
  const collabCalls = data?.collabCalls ?? workSession.codexCollabCalls ?? [];

  return (
    <section className="runtime-section native-codex-section">
      <div className="runtime-section-head">
        <h3>
          Codex threads
          <button type="button" className="ghost small runtime-status-refresh" onClick={() => setRefreshKey((key) => key + 1)} disabled={loading || !hasThread} aria-label="Refresh Codex threads">
            {loading ? "..." : "Refresh"}
          </button>
        </h3>
        <p>Native app-server thread tree, subagents, collab tool calls, and rollback.</p>
      </div>
      {!hasThread ? <p className="muted small">No native Codex thread has been started for this session.</p> : null}
      {error !== null ? <p className="runtime-status-error small">{error}</p> : null}
      {hasThread ? (
        <>
          <div className="native-codex-root">
            <span className="field-label">Root thread</span>
            <code>{data?.threadId ?? workSession.codexThreadId}</code>
          </div>
          {data?.tree !== undefined ? (
            <ul className="codex-thread-tree codex-thread-tree-root">
              <NativeCodexTreeNode node={data.tree} root />
            </ul>
          ) : null}
          <div className="native-codex-stats">
            <span>{agentsById.size} subagents</span>
            <span>{collabCalls.length} collab calls</span>
          </div>
          {collabCalls.length > 0 ? (
            <div className="native-codex-calls">
              {collabCalls.slice(-8).reverse().map((call) => (
                <article key={call.id} className="native-codex-call">
                  <div className="native-codex-call-main">
                    <strong className="native-codex-call-title">{toolLabel(call.tool)}</strong>
                    <span className="native-codex-call-route muted small">
                      {call.senderThreadId?.slice(0, 8) ?? "root"} -&gt; {collabTargetLabel(call, agentsById)}
                    </span>
                  </div>
                  <span className={`chip chip-${collabChipTone(call.status)}`}>{call.status}</span>
                  {call.prompt !== null ? <p className="muted small">{call.prompt.slice(0, 180)}</p> : null}
                  {typeof call.failureReason === "string" && call.failureReason.length > 0 ? <p className="runtime-status-error small">{call.failureReason.slice(0, 240)}</p> : null}
                </article>
              ))}
            </div>
          ) : null}
          <div className="native-codex-rollback">
            <label className="runtime-field">
              <span className="runtime-field-label">Rollback turns</span>
              <input type="number" min={1} step={1} value={rollbackTurns} onChange={(e) => setRollbackTurns(e.target.value)} disabled={busy || loading} />
            </label>
            <button type="button" className="ghost" disabled={busy || loading} onClick={() => void rollback()}>
              Roll back native history
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}

function formatTokens(value: number | null): string {
  if (value === null) return "—";
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 100000 ? 0 : 1)}k`;
  return String(value);
}

function formatResetAt(iso: string | null): string {
  if (iso === null) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const diffMs = date.getTime() - Date.now();
  if (diffMs <= 0) return "now";
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function Meter({ percent }: { percent: number }): React.ReactElement {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className="runtime-meter" aria-hidden="true">
      <div className="runtime-meter-fill" style={{ width: `${clamped}%` }} />
    </div>
  );
}

function RuntimeLiveStatus({
  provider,
  workSessionId,
  model,
  reasoningEffort,
}: {
  provider: SelectableProvider;
  workSessionId: string;
  model: string | null;
  reasoningEffort: string | null;
}): React.ReactElement {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [compactBusy, setCompactBusy] = useState(false);
  const [compactNote, setCompactNote] = useState<string | null>(null);

  async function requestCompactNow(): Promise<void> {
    setCompactBusy(true);
    setCompactNote(null);
    try {
      const response = await fetch(`/api/work-sessions/${encodeURIComponent(workSessionId)}/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "compact-now" }),
      });
      const body = (await response.json()) as { ok?: boolean; data?: { requested?: number; path?: string } };
      const requested = body.data?.requested ?? 0;
      setCompactNote(
        body.ok === true
          ? body.data?.path === "claude-idle"
            ? "Claude context compaction completed."
            : requested > 0
              ? `Compaction requested for ${requested} running agent(s).`
            : "Nothing to compact right now."
          : "Compact request failed.",
      );
    } catch {
      setCompactNote("Compact request failed.");
    } finally {
      setCompactBusy(false);
      setReloadToken((token) => token + 1);
    }
  }

  useEffect(() => {
    let canceled = false;
    async function load(): Promise<void> {
      setLoading(true);
      try {
        const params = new URLSearchParams({ provider, workSessionId });
        if (model !== null && model.trim().length > 0) params.set("model", model.trim());
        if (reasoningEffort !== null && reasoningEffort.trim().length > 0) params.set("reasoningEffort", reasoningEffort.trim());
        const response = await fetch(`/api/runtime-status?${params.toString()}`, { cache: "no-store" });
        const body = (await response.json()) as unknown;
        if (canceled) return;
        if (typeof body === "object" && body !== null && (body as { ok?: unknown }).ok === true) {
          setStatus((body as { data: RuntimeStatus }).data);
          setError(null);
        } else {
          setError(
            typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string"
              ? (body as { error: string }).error
              : "Unable to load runtime status.",
          );
        }
      } catch (loadError) {
        if (!canceled) setError(loadError instanceof Error ? loadError.message : "Unable to load runtime status.");
      } finally {
        if (!canceled) setLoading(false);
      }
    }
    void load();
    const timer = setInterval(() => setReloadToken((token) => token + 1), 12000);
    return () => {
      canceled = true;
      clearInterval(timer);
    };
  }, [provider, workSessionId, model, reasoningEffort, reloadToken]);

  const quota = status?.quota ?? null;
  const context = status?.context ?? null;
  const contextDetails = context?.details ?? null;
  const compaction = status?.compaction ?? null;
  const diagnostics = status?.diagnostics ?? [];

  return (
    <section className="runtime-section">
      <div className="runtime-section-head">
        <h3>
          Live status
          <button type="button" className="ghost small runtime-status-refresh" onClick={() => setReloadToken((token) => token + 1)} disabled={loading} aria-label="Refresh live status">
            {loading ? "…" : "↻"}
          </button>
        </h3>
        <p>Remaining quota, context, and compaction for the selected provider. Read-only; sources are labeled.</p>
      </div>

      {error !== null ? <p className="runtime-status-error small">Status unavailable: {error}</p> : null}

      <div className="runtime-status-grid">
        <div className="runtime-status-card">
          <div className="runtime-status-card-head">
            <span className="runtime-status-title">Quota</span>
            <span className="runtime-status-source">{quota === null ? "" : quota.scope === "none" ? "local · no quota" : quota.scope === "cost" ? "plan-based" : quota.scope}</span>
          </div>
          {quota === null ? (
            <p className="muted small">{loading ? "Loading…" : "—"}</p>
          ) : quota.scope === "cost" ? (
            <p className="small">{quota.costUsd !== null ? `Session cost: $${quota.costUsd.toFixed(4)}` : "No cost recorded yet."}</p>
          ) : quota.buckets.length > 0 ? (
            <div className="runtime-status-buckets">
              {quota.buckets.map((bucket) => (
                <div key={bucket.id} className="runtime-status-bucket">
                  <div className="runtime-status-bucket-head small">
                    <span>{bucket.label ?? bucket.id}</span>
                    {bucket.creditsBalance !== null ? (
                      <span className="muted">credits {Number.isFinite(Number(bucket.creditsBalance)) ? Number(bucket.creditsBalance).toFixed(2) : bucket.creditsBalance}</span>
                    ) : null}
                  </div>
                  {bucket.windows.map((window) => (
                    <div key={`${bucket.id}-${window.label}`} className="runtime-status-window">
                      <div className="runtime-status-window-row small">
                        <span>{window.label}</span>
                        <span>{window.remainingPercent}% left{window.resetsAt !== null ? ` · resets ${formatResetAt(window.resetsAt)}` : ""}</span>
                      </div>
                      <Meter percent={window.usedPercent} />
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <p className="muted small">{quota.note}</p>
          )}
        </div>

        <div className="runtime-status-card">
          <div className="runtime-status-card-head">
            <span className="runtime-status-title">Context</span>
            <span className="runtime-status-source">{context === null ? "" : context.scope}</span>
          </div>
          {context === null || context.contextWindow === null ? (
            <p className="muted small">{loading ? "Loading…" : context?.note ?? "—"}</p>
          ) : (
            <>
              <div className="runtime-status-window-row small">
                <span>{formatTokens(context.usedTokens)} / {formatTokens(context.contextWindow)} tokens</span>
                <span>{context.remainingTokens !== null ? `${formatTokens(context.remainingTokens)} left` : "used unknown"}</span>
              </div>
              <Meter percent={context.usedTokens !== null && context.contextWindow > 0 ? (context.usedTokens / context.contextWindow) * 100 : 0} />
              {contextDetails !== null ? (
                <div className="runtime-context-details">
                  {contextDetails.modelLabel !== null || contextDetails.modelSlug !== null || contextDetails.percentUsed !== null ? (
                    <div className="runtime-context-model small">
                      <span>{contextDetails.modelLabel ?? context.model ?? "Claude"}</span>
                      <span className="muted">
                        {[contextDetails.modelSlug, contextDetails.percentUsed !== null ? `${contextDetails.percentUsed}% used` : null].filter(Boolean).join(" · ")}
                      </span>
                    </div>
                  ) : null}
                  {contextDetails.categories.length > 0 ? (
                    <div className="runtime-context-list">
                      {contextDetails.categories.map((category) => (
                        <div key={category.label} className="runtime-context-row small">
                          <span title={category.label}>{category.label}</span>
                          <span title={`${formatTokens(category.tokens)}${category.percent !== null ? ` (${category.percent}%)` : ""}`}>
                            {formatTokens(category.tokens)}{category.percent !== null ? ` (${category.percent}%)` : ""}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {contextDetails.references.length > 0 ? (
                    <div className="runtime-context-list runtime-context-references">
                      {contextDetails.references.slice(0, 8).map((reference) => (
                        <div key={`${reference.section}-${reference.label}`} className="runtime-context-row small">
                          <span title={`${reference.section}: ${reference.label}`}>{reference.section}: {reference.label}</span>
                          <span>{formatTokens(reference.tokens)}</span>
                        </div>
                      ))}
                      {contextDetails.references.length > 8 ? <p className="muted small">And {contextDetails.references.length - 8} more context item(s).</p> : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <p className="muted small runtime-status-foot">{context.note}</p>
            </>
          )}
        </div>

        <div className="runtime-status-card">
          <div className="runtime-status-card-head">
            <span className="runtime-status-title">Compaction</span>
            <span className="runtime-status-source">{compaction === null ? "" : compaction.manualCompaction ? "manual" : compaction.supported ? "auto-only" : "n/a"}</span>
          </div>
          {compaction === null ? (
            <p className="muted small">{loading ? "Loading…" : "—"}</p>
          ) : (
            <>
              <p className="small">
                {compaction.autoObserved
                  ? `Auto-compaction observed${compaction.lastCompactionAt !== null ? ` at ${formatTime(compaction.lastCompactionAt)}` : ""}.`
                  : "No compaction observed this session."}
              </p>
              {compaction.manualCompaction ? (
                <button type="button" className="ghost small" disabled={!compaction.canManualCompact || compactBusy} title={compaction.note} onClick={() => void requestCompactNow()}>
                  {compactBusy ? "Compacting…" : "Compact now"}
                </button>
              ) : null}
              {compactNote !== null ? <p className="small runtime-status-foot">{compactNote}</p> : null}
              <p className="muted small runtime-status-foot">{compaction.note}</p>
            </>
          )}
        </div>
      </div>

      {diagnostics.length > 0 ? (
        <div className="runtime-status-card runtime-diagnostics-card">
          <div className="runtime-status-card-head">
            <span className="runtime-status-title">Runtime doctor</span>
            <span className="runtime-status-source">{diagnostics.length} checks</span>
          </div>
          <div className="runtime-diagnostics-list">
            {diagnostics.map((item) => (
              <div key={item.id} className={`runtime-diagnostic runtime-diagnostic-${item.status}`}>
                <span>{item.label}</span>
                <span title={item.detail}>{item.detail}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {status !== null ? (
        <p className="runtime-note muted small">
          Source: {status.source}{status.fetchedAt !== null ? ` · ${new Date(status.fetchedAt).toLocaleTimeString()}` : ""}.
        </p>
      ) : null}
    </section>
  );
}

function headerForView(view: DrawerView): string {
  switch (view.kind) {
    case "verification":
      return `Verification · ${view.run.status}`;
    case "handoff":
      return "Handoff";
    case "events":
      return `Event log (${view.events.length})`;
    case "artifacts":
      return `Artifacts (${view.artifacts.length})`;
    case "checkpoints":
      return `Checkpoint history (${view.checkpoints.length})`;
    default:
      return "";
  }
}

function bodyForView(
  view: DrawerView,
  busy: boolean,
  onRestoreCheckpoint: (checkpointId: string) => Promise<void>,
  onSurgicalRevertCheckpoint: (checkpointId: string) => Promise<void>,
  onForkCheckpoint: (checkpointId: string) => Promise<void>
): React.ReactElement | null {
  switch (view.kind) {
    case "verification":
      return (
        <>
          <p className="muted">
            Started {formatTime(view.run.startedAt)}
            {view.run.endedAt !== null ? ` · finished ${formatTime(view.run.endedAt)}` : ""}
          </p>
          {view.run.commands.length > 0 ? (
            <ul className="drawer-list">
              {view.run.commands.map((cmd) => (
                <li key={cmd}><code>{cmd}</code></li>
              ))}
            </ul>
          ) : null}
          <pre className="drawer-pre">{view.run.rawOutput || view.run.summary || "No output."}</pre>
        </>
      );
    case "handoff": {
      const summaryIncludesWorkspace = /(^|\n)Workspace:\s*/.test(view.handoff.summaryMarkdown);
      return (
        <>
          {!summaryIncludesWorkspace && view.workspacePath !== null && view.workspacePath.trim().length > 0 ? (
            <div className="drawer-meta-block">
              <span>Workspace</span>
              <code className="card-inline-code">{view.workspacePath}</code>
            </div>
          ) : null}
          <pre className="drawer-pre">{view.handoff.summaryMarkdown}</pre>
          {view.handoff.openQuestions.length > 0 ? (
            <>
              <h3>Open questions</h3>
              <ul className="drawer-list">
                {view.handoff.openQuestions.map((question) => (
                  <li key={question}>{question}</li>
                ))}
              </ul>
            </>
          ) : null}
          {view.handoff.nextSteps.length > 0 ? (
            <>
              <h3>Next steps</h3>
              <ul className="drawer-list">
                {view.handoff.nextSteps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      );
    }
    case "events":
      return (
        <ul className="drawer-events">
          {view.events.length === 0 ? <li className="muted">No events yet.</li> : null}
          {view.events.map((event) => {
            const projection = projectEventToTimeline(event);
            return (
              <li key={event.id} className={`event-row event-${projection.tone}`}>
                <div className="event-row-head">
                  <strong>{projection.title}</strong>
                  <span className="muted">{formatTime(projection.createdAt)}</span>
                </div>
                <div>{projection.detail}</div>
                <div className="muted small">{projection.meta}</div>
              </li>
            );
          })}
        </ul>
      );
    case "artifacts":
      return (
        <ul className="drawer-artifacts">
          {view.artifacts.length === 0 ? <li className="muted">No artifacts yet.</li> : null}
          {view.artifacts.map((artifact) => (
            <li key={artifact.id}>
              <div className="event-row-head">
                <strong>{typeof artifact.metadata.artifactRole === "string" ? artifact.metadata.artifactRole.replace(/_/g, " ") : artifact.artifactKind}</strong>
                <span className="muted">{formatTime(artifact.createdAt)}</span>
              </div>
              {artifact.artifactKind === "screenshot" || artifact.artifactKind === "image" ? (
                <a
                  href={`/api/artifacts/${artifact.id}`}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => logClientProcess("info", "artifact.open", {
                    artifactId: artifact.id,
                    artifactKind: artifact.artifactKind,
                    contentType: typeof artifact.metadata.contentType === "string" ? artifact.metadata.contentType : null,
                    role: typeof artifact.metadata.artifactRole === "string" ? artifact.metadata.artifactRole : null,
                  })}
                >
                  <Image
                    className="drawer-artifact-thumb"
                    src={`/api/artifacts/${artifact.id}`}
                    alt={artifact.artifactKind === "image" ? "Uploaded image artifact" : "Snapshot screenshot artifact"}
                    width={360}
                    height={203}
                    unoptimized
                  />
                </a>
              ) : null}
              <div><code>{artifact.storageUri}</code></div>
              <a
                href={`/api/artifacts/${artifact.id}`}
                target="_blank"
                rel="noreferrer"
                onClick={() => logClientProcess("info", "artifact.open", {
                  artifactId: artifact.id,
                  artifactKind: artifact.artifactKind,
                  contentType: typeof artifact.metadata.contentType === "string" ? artifact.metadata.contentType : null,
                  role: typeof artifact.metadata.artifactRole === "string" ? artifact.metadata.artifactRole : null,
                })}
              >
                <button type="button" className="ghost small">Open artifact</button>
              </a>
            </li>
          ))}
        </ul>
      );
    case "checkpoints": {
      const tasksById = new Map(view.tasks.map((task) => [task.id, task]));
      const checkpoints = [...view.checkpoints].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return (
        <ul className="drawer-events">
          {checkpoints.length === 0 ? <li className="muted">No checkpoints yet.</li> : null}
          {checkpoints.map((checkpoint) => {
            const task = checkpoint.taskId === null ? null : tasksById.get(checkpoint.taskId) ?? null;
            const isCurrent = checkpoint.id === view.currentCheckpointId;
            const canRestore = !isCurrent && checkpoint.trigger !== "pre_restore" && checkpoint.trigger !== "pre_surgical_revert";
            const canSurgicalRevert = checkpoint.trigger === "post_task" && checkpoint.previousCheckpointId !== null && checkpoint.filesChanged > 0;
            return (
              <li key={checkpoint.id} className={`event-row event-${isCurrent ? "success" : "neutral"}`}>
                <div className="event-row-head">
                  <strong>{checkpoint.trigger.replace(/_/g, " ")}</strong>
                  <span className="muted">{formatTime(checkpoint.createdAt)}</span>
                </div>
                <div>{task?.title ?? checkpoint.summary}</div>
                <div className="muted small">
                  {checkpoint.filesChanged} changed file{checkpoint.filesChanged === 1 ? "" : "s"}
                  {checkpoint.agentRunId !== null ? ` · run ${checkpoint.agentRunId.slice(0, 8)}` : ""}
                  {isCurrent ? " · current" : ""}
                </div>
                <div className="card-actions">
                  <button
                    type="button"
                    className={canRestore ? "danger-text small" : "ghost small"}
                    disabled={busy || !canRestore}
                    title={isCurrent ? "This checkpoint is already current" : "Restore the workspace to this checkpoint"}
                    onClick={() => {
                      const ok = window.confirm("Restore the workspace to this checkpoint? The chat will fold back to this point, collapsing the later steps into a \"Restored to here\" marker you can expand. Nothing is deleted — a safety checkpoint is saved first, so you can restore forward again.");
                      if (ok) void onRestoreCheckpoint(checkpoint.id);
                    }}
                  >
                    {isCurrent ? "Current" : "Restore to here"}
                  </button>
                  <button
                    type="button"
                    className="ghost small"
                    disabled={busy || !canSurgicalRevert}
                    title={canSurgicalRevert ? "Keep later changes and only undo this checkpoint's file changes" : "Surgical revert is available for post-task checkpoints with file changes"}
                    onClick={() => {
                      const ok = window.confirm("Surgically revert this task checkpoint? Later changes will be kept, but the operation may fail if later edits overlap.");
                      if (ok) void onSurgicalRevertCheckpoint(checkpoint.id);
                    }}
                  >
                    Revert task changes
                  </button>
                  <button
                    type="button"
                    className="ghost small"
                    disabled={busy}
                    title="Create a new chat and workspace from this checkpoint"
                    onClick={() => void onForkCheckpoint(checkpoint.id)}
                  >
                    Fork from here
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      );
    }
    default:
      return null;
  }
}
