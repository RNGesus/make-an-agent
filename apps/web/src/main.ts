import {
  autonomyModes,
  taskGoalTypes,
  type AutonomyMode,
  type RepositoryPolicyRecord,
  type RepositoryRecord,
  type TaskGoalType,
  type TaskRecord,
} from "shared";
import "./style.css";

type RepositoryDetail = {
  repository: RepositoryRecord;
  policy: RepositoryPolicyRecord;
};

type TaskSummary = {
  task: TaskRecord;
  repository: Pick<RepositoryRecord, "id" | "name" | "default_branch">;
};

type RepositoryScanCandidate = {
  name: string;
  root_path: string;
  parent_source: string;
  default_branch: string;
  remote_url: string | null;
  github_owner: string | null;
  github_repo: string | null;
  is_registered: boolean;
  registered_repo_id: string | null;
};

type AppState = {
  apiBaseUrl: string;
  repositories: RepositoryDetail[];
  selectedRepoId: string | null;
  scanCandidates: RepositoryScanCandidate[];
  tasks: TaskSummary[];
  selectedTaskId: string | null;
  selectedTask: TaskSummary | null;
  loading: boolean;
  working: string | null;
  notice: string | null;
  error: string | null;
};

const state: AppState = {
  apiBaseUrl: (import.meta.env.VITE_API_BASE_URL ?? "").trim(),
  repositories: [],
  selectedRepoId: null,
  scanCandidates: [],
  tasks: [],
  selectedTaskId: null,
  selectedTask: null,
  loading: true,
  working: null,
  notice: null,
  error: null,
};

const appRootElement = document.querySelector<HTMLDivElement>("#app");

if (!appRootElement) {
  throw new Error("Expected #app container to exist.");
}

const appRoot = appRootElement;

void bootstrap();

async function bootstrap() {
  render();

  try {
    await refreshRepositories();
    await refreshScanCandidates();
  } catch (error) {
    setError(toErrorMessage(error));
  } finally {
    state.loading = false;
    render();
  }
}

async function refreshRepositories() {
  const payload = await apiRequest<{ repositories: RepositoryDetail[] }>("/api/repos");

  state.repositories = payload.repositories;

  if (state.repositories.length === 0) {
    state.selectedRepoId = null;
    state.tasks = [];
    state.selectedTaskId = null;
    state.selectedTask = null;
    return;
  }

  if (
    !state.selectedRepoId ||
    !state.repositories.some((entry) => entry.repository.id === state.selectedRepoId)
  ) {
    state.selectedRepoId = state.repositories[0]?.repository.id ?? null;
  }

  await refreshTasks();
}

async function refreshScanCandidates() {
  const payload = await apiRequest<{ candidates: RepositoryScanCandidate[] }>("/api/repos/scan", {
    method: "POST",
  });

  state.scanCandidates = payload.candidates;
}

async function refreshTasks() {
  if (!state.selectedRepoId) {
    state.tasks = [];
    state.selectedTaskId = null;
    state.selectedTask = null;
    return;
  }

  const payload = await apiRequest<{ tasks: TaskSummary[] }>(
    `/api/tasks?repo_id=${encodeURIComponent(state.selectedRepoId)}`,
  );

  state.tasks = payload.tasks;

  if (
    !state.selectedTaskId ||
    !state.tasks.some((entry) => entry.task.id === state.selectedTaskId)
  ) {
    state.selectedTaskId = state.tasks[0]?.task.id ?? null;
  }

  if (!state.selectedTaskId) {
    state.selectedTask = null;
    return;
  }

  state.selectedTask = await apiRequest<TaskSummary>(
    `/api/tasks/${encodeURIComponent(state.selectedTaskId)}`,
  );
}

async function selectRepository(repoId: string) {
  state.selectedRepoId = repoId;
  state.selectedTaskId = null;
  state.selectedTask = null;
  state.error = null;
  render();

  try {
    await refreshTasks();
  } catch (error) {
    setError(toErrorMessage(error));
  } finally {
    render();
  }
}

async function selectTask(taskId: string) {
  state.selectedTaskId = taskId;
  state.error = null;
  render();

  try {
    state.selectedTask = await apiRequest<TaskSummary>(`/api/tasks/${encodeURIComponent(taskId)}`);
  } catch (error) {
    setError(toErrorMessage(error));
  } finally {
    render();
  }
}

async function importRepository(rootPath: string, parentSource: string) {
  await runAction("Importing repository...", async () => {
    const detail = await apiRequest<RepositoryDetail>("/api/repos", {
      method: "POST",
      body: JSON.stringify({ root_path: rootPath, parent_source: parentSource }),
    });

    state.notice = `Imported ${detail.repository.name}.`;
    await refreshRepositories();
    await refreshScanCandidates();
    state.selectedRepoId = detail.repository.id;
    await refreshTasks();
  });
}

async function savePolicy(form: HTMLFormElement) {
  const selectedRepository = getSelectedRepository();

  if (!selectedRepository) {
    return;
  }

  const formData = new FormData(form);
  const payload = {
    autonomy_mode: requireSelectValue(formData, "autonomy_mode") as AutonomyMode,
    allowed_root: requireStringValue(formData, "allowed_root"),
    allow_read: readCheckbox(form, "allow_read"),
    allow_edit: readCheckbox(form, "allow_edit"),
    allow_bash: readCheckbox(form, "allow_bash"),
    allow_git_write: readCheckbox(form, "allow_git_write"),
    allow_pr_create: readCheckbox(form, "allow_pr_create"),
    approval_required_for_edit: readCheckbox(form, "approval_required_for_edit"),
    approval_required_for_commit: readCheckbox(form, "approval_required_for_commit"),
    approval_required_for_pr: readCheckbox(form, "approval_required_for_pr"),
    approval_required_for_risky_bash: readCheckbox(form, "approval_required_for_risky_bash"),
    cheap_provider: requireStringValue(formData, "cheap_provider"),
    cheap_model: requireStringValue(formData, "cheap_model"),
    strong_provider: requireStringValue(formData, "strong_provider"),
    strong_model: requireStringValue(formData, "strong_model"),
    classifier_provider: optionalStringValue(formData, "classifier_provider"),
    classifier_model: optionalStringValue(formData, "classifier_model"),
    max_escalations: requireNumberValue(formData, "max_escalations"),
    max_task_budget_usd: requireNumberValue(formData, "max_task_budget_usd"),
  };

  await runAction("Saving policy...", async () => {
    const detail = await apiRequest<RepositoryDetail>(
      `/api/repos/${encodeURIComponent(selectedRepository.repository.id)}/policy`,
      {
        method: "PATCH",
        body: JSON.stringify(payload),
      },
    );

    state.repositories = state.repositories.map((entry) =>
      entry.repository.id === detail.repository.id ? detail : entry,
    );
    state.notice = `Saved policy for ${detail.repository.name}.`;
  });
}

async function createTaskFromForm(form: HTMLFormElement) {
  const selectedRepository = getSelectedRepository();

  if (!selectedRepository) {
    return;
  }

  const formData = new FormData(form);
  const title = optionalStringValue(formData, "title");
  const goalType = optionalStringValue(formData, "goal_type") as TaskGoalType | null;
  const expectedFileCount = optionalNumberValue(formData, "expected_file_count");
  const payload = {
    repo_id: selectedRepository.repository.id,
    user_prompt: requireStringValue(formData, "user_prompt"),
    ...(title ? { title } : {}),
    ...(goalType ? { goal_type: goalType } : {}),
    ...(expectedFileCount === null ? {} : { expected_file_count: expectedFileCount }),
  };

  await runAction("Creating task...", async () => {
    const detail = await apiRequest<TaskSummary>("/api/tasks", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    form.reset();
    state.notice = `Created task ${detail.task.title}.`;
    await refreshTasks();
    state.selectedTaskId = detail.task.id;
    state.selectedTask = detail;
  });
}

async function runAction(label: string, action: () => Promise<void>) {
  state.working = label;
  state.error = null;
  render();

  try {
    await action();
  } catch (error) {
    setError(toErrorMessage(error));
  } finally {
    state.working = null;
    render();
  }
}

function render() {
  const selectedRepository = getSelectedRepository();
  const apiTarget = state.apiBaseUrl || window.location.origin;

  appRoot.innerHTML = `
    <div class="page-shell">
      <div class="orb orb-coral"></div>
      <div class="orb orb-teal"></div>

      <header class="hero panel">
        <div>
          <p class="eyebrow">Pi Remote Control App</p>
          <h1>Repo intake, policy controls, and task routing now share one operator surface.</h1>
          <p class="lede">
            This slice follows the approved plan: scan existing workspaces, register repos, tune per-repo
            autonomy, then create tasks that persist routing decisions for the cheap and strong model tiers.
          </p>
        </div>

        <div class="hero-meta">
          <div>
            <p class="eyebrow">API target</p>
            <strong>${escapeHtml(apiTarget)}</strong>
          </div>
          <div>
            <p class="eyebrow">Milestone focus</p>
            <strong>M1 + M2</strong>
          </div>
          <div>
            <p class="eyebrow">Live state</p>
            <strong>${state.working ? escapeHtml(state.working) : state.loading ? "Loading control plane..." : "Ready"}</strong>
          </div>
        </div>
      </header>

      ${renderBanner()}

      <main class="layout">
        <section class="stack-column">
          <article class="panel">
            <div class="section-head">
              <div>
                <p class="eyebrow">Repository Library</p>
                <h2>Scan the workspace parent and import repos into the registry.</h2>
              </div>
              <button class="ghost-button" type="button" data-action="scan-repos">Rescan parent</button>
            </div>
            <div class="stat-strip">
              <div>
                <span class="stat-value">${state.repositories.length}</span>
                <span class="stat-label">registered</span>
              </div>
              <div>
                <span class="stat-value">${state.scanCandidates.length}</span>
                <span class="stat-label">discovered</span>
              </div>
            </div>
            <div class="repo-list">${renderRepositoryList()}</div>
          </article>

          <article class="panel">
            <div class="section-head compact-head">
              <div>
                <p class="eyebrow">Workspace Scan</p>
                <h2>Import candidates</h2>
              </div>
            </div>
            <div class="candidate-list">${renderCandidates()}</div>
          </article>
        </section>

        <section class="content-column">
          <article class="panel">
            <div class="section-head">
              <div>
                <p class="eyebrow">Policy Editor</p>
                <h2>${selectedRepository ? escapeHtml(selectedRepository.repository.name) : "Choose a repository"}</h2>
              </div>
              ${selectedRepository ? `<span class="badge">${escapeHtml(selectedRepository.repository.default_branch)}</span>` : ""}
            </div>
            ${renderPolicyPanel(selectedRepository)}
          </article>

          <section class="task-grid">
            <article class="panel">
              <div class="section-head compact-head">
                <div>
                  <p class="eyebrow">Task Intake</p>
                  <h2>Create a routed task</h2>
                </div>
              </div>
              ${renderTaskForm(selectedRepository)}
            </article>

            <article class="panel">
              <div class="section-head compact-head">
                <div>
                  <p class="eyebrow">Task History</p>
                  <h2>${selectedRepository ? `Tasks for ${escapeHtml(selectedRepository.repository.name)}` : "Waiting for a repo"}</h2>
                </div>
              </div>
              <div class="task-list">${renderTaskList()}</div>
            </article>

            <article class="panel detail-panel">
              <div class="section-head compact-head">
                <div>
                  <p class="eyebrow">Routing Detail</p>
                  <h2>${state.selectedTask ? escapeHtml(state.selectedTask.task.title) : "Select a task"}</h2>
                </div>
              </div>
              ${renderTaskDetail()}
            </article>
          </section>
        </section>
      </main>
    </div>
  `;

  bindEvents();
}

function renderBanner() {
  if (!state.notice && !state.error) {
    return "";
  }

  const kind = state.error ? "error" : "notice";
  const message = state.error ?? state.notice ?? "";

  return `<section class="banner banner-${kind}">${escapeHtml(message)}</section>`;
}

function renderRepositoryList() {
  if (state.repositories.length === 0) {
    return `<p class="empty-state">No repositories are registered yet.</p>`;
  }

  return state.repositories
    .map((entry) => {
      const isSelected = entry.repository.id === state.selectedRepoId;

      return `
        <button class="repo-item ${isSelected ? "repo-item-selected" : ""}" type="button" data-repo-id="${escapeHtml(entry.repository.id)}">
          <span>
            <strong>${escapeHtml(entry.repository.name)}</strong>
            <small>${escapeHtml(entry.repository.root_path)}</small>
          </span>
          <span class="repo-meta">
            <span class="chip">${escapeHtml(entry.policy.autonomy_mode)}</span>
            <span class="chip chip-soft">${escapeHtml(entry.policy.strong_model)}</span>
          </span>
        </button>
      `;
    })
    .join("");
}

function renderCandidates() {
  if (state.scanCandidates.length === 0) {
    return `<p class="empty-state">No git repositories were found under the configured workspace parent.</p>`;
  }

  return state.scanCandidates
    .map((candidate) => {
      const action = candidate.is_registered
        ? `<button class="ghost-button" type="button" data-repo-id="${escapeHtml(candidate.registered_repo_id ?? "")}">View repo</button>`
        : `<button class="solid-button" type="button" data-import-root="${escapeHtml(candidate.root_path)}" data-import-parent="${escapeHtml(candidate.parent_source)}">Import</button>`;

      return `
        <article class="candidate-card">
          <div>
            <strong>${escapeHtml(candidate.name)}</strong>
            <p>${escapeHtml(candidate.root_path)}</p>
          </div>
          <div class="candidate-meta">
            <span class="chip">${escapeHtml(candidate.default_branch)}</span>
            <span class="chip chip-soft">${candidate.github_repo ? escapeHtml(candidate.github_repo) : "local"}</span>
            ${action}
          </div>
        </article>
      `;
    })
    .join("");
}

function renderPolicyPanel(selectedRepository: RepositoryDetail | null) {
  if (!selectedRepository) {
    return `<p class="empty-state">Import or select a repository to edit its policy and model profile.</p>`;
  }

  const { policy, repository } = selectedRepository;

  return `
    <div class="repo-overview">
      <div>
        <p class="eyebrow">Workspace root</p>
        <strong>${escapeHtml(repository.root_path)}</strong>
      </div>
      <div>
        <p class="eyebrow">Remote</p>
        <strong>${escapeHtml(repository.remote_url ?? "No origin configured")}</strong>
      </div>
    </div>

    <form id="policy-form" class="form-stack">
      <div class="field-grid two-up">
        <label>
          <span>Autonomy mode</span>
          <select name="autonomy_mode">${renderOptions(autonomyModes, policy.autonomy_mode)}</select>
        </label>
        <label>
          <span>Allowed root</span>
          <input name="allowed_root" value="${escapeHtml(policy.allowed_root)}" />
        </label>
      </div>

      <div class="field-grid four-up toggle-grid">
        ${renderToggle("allow_read", "Read access", policy.allow_read)}
        ${renderToggle("allow_edit", "Edit files", policy.allow_edit)}
        ${renderToggle("allow_bash", "Run bash", policy.allow_bash)}
        ${renderToggle("allow_git_write", "Git writes", policy.allow_git_write)}
        ${renderToggle("allow_pr_create", "Create PRs", policy.allow_pr_create)}
        ${renderToggle("approval_required_for_edit", "Approve edits", policy.approval_required_for_edit)}
        ${renderToggle("approval_required_for_commit", "Approve commits", policy.approval_required_for_commit)}
        ${renderToggle("approval_required_for_pr", "Approve PRs", policy.approval_required_for_pr)}
        ${renderToggle(
          "approval_required_for_risky_bash",
          "Approve risky bash",
          policy.approval_required_for_risky_bash,
        )}
      </div>

      <div class="field-grid two-up">
        <label>
          <span>Cheap provider</span>
          <input name="cheap_provider" value="${escapeHtml(policy.cheap_provider)}" />
        </label>
        <label>
          <span>Cheap model</span>
          <input name="cheap_model" value="${escapeHtml(policy.cheap_model)}" />
        </label>
        <label>
          <span>Strong provider</span>
          <input name="strong_provider" value="${escapeHtml(policy.strong_provider)}" />
        </label>
        <label>
          <span>Strong model</span>
          <input name="strong_model" value="${escapeHtml(policy.strong_model)}" />
        </label>
        <label>
          <span>Classifier provider</span>
          <input name="classifier_provider" value="${escapeHtml(policy.classifier_provider ?? "")}" />
        </label>
        <label>
          <span>Classifier model</span>
          <input name="classifier_model" value="${escapeHtml(policy.classifier_model ?? "")}" />
        </label>
        <label>
          <span>Max escalations</span>
          <input name="max_escalations" type="number" min="0" step="1" value="${policy.max_escalations}" />
        </label>
        <label>
          <span>Task budget USD</span>
          <input name="max_task_budget_usd" type="number" min="0" step="0.01" value="${policy.max_task_budget_usd}" />
        </label>
      </div>

      <div class="form-actions">
        <button class="solid-button" type="submit">Save policy</button>
      </div>
    </form>
  `;
}

function renderTaskForm(selectedRepository: RepositoryDetail | null) {
  if (!selectedRepository) {
    return `<p class="empty-state">Choose a repository before submitting a task.</p>`;
  }

  return `
    <form id="task-form" class="form-stack">
      <div class="field-grid two-up">
        <label>
          <span>Goal type</span>
          <select name="goal_type">
            <option value="">Infer from prompt</option>
            ${renderOptions(taskGoalTypes, null)}
          </select>
        </label>
        <label>
          <span>Expected files</span>
          <input name="expected_file_count" type="number" min="0" step="1" placeholder="optional" />
        </label>
      </div>

      <label>
        <span>Task title</span>
        <input name="title" placeholder="optional short label" />
      </label>

      <label>
        <span>Prompt</span>
        <textarea name="user_prompt" rows="6" placeholder="Describe the repo question, plan, fix, or implementation request."></textarea>
      </label>

      <div class="form-actions">
        <button class="solid-button" type="submit">Create routed task</button>
      </div>
    </form>
  `;
}

function renderTaskList() {
  if (state.tasks.length === 0) {
    return `<p class="empty-state">No tasks have been submitted for this repository yet.</p>`;
  }

  return state.tasks
    .map((entry) => {
      const isSelected = entry.task.id === state.selectedTaskId;

      return `
        <button class="task-item ${isSelected ? "task-item-selected" : ""}" type="button" data-task-id="${escapeHtml(entry.task.id)}">
          <span>
            <strong>${escapeHtml(entry.task.title)}</strong>
            <small>${escapeHtml(entry.task.goal_type)} · ${escapeHtml(entry.task.status)}</small>
          </span>
          <span class="tier tier-${escapeHtml(entry.task.routing_tier ?? "pending")}">${escapeHtml(entry.task.routing_tier ?? "pending")}</span>
        </button>
      `;
    })
    .join("");
}

function renderTaskDetail() {
  if (!state.selectedTask) {
    return `<p class="empty-state">Select a task to inspect the stored routing decision.</p>`;
  }

  const { task, repository } = state.selectedTask;
  const classifierConfidence =
    task.classifier_confidence === null
      ? "Not used"
      : `${Math.round(task.classifier_confidence * 100)}%`;
  const classifierScore =
    task.classifier_score === null ? "Not used" : task.classifier_score.toFixed(2);

  return `
    <div class="detail-stack">
      <div class="detail-row">
        <span class="chip">${escapeHtml(repository.name)}</span>
        <span class="tier tier-${escapeHtml(task.routing_tier ?? "pending")}">${escapeHtml(task.routing_tier ?? "pending")}</span>
      </div>
      <p class="detail-prompt">${escapeHtml(task.user_prompt)}</p>
      <dl class="detail-grid">
        <div>
          <dt>Goal type</dt>
          <dd>${escapeHtml(task.goal_type)}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>${escapeHtml(task.status)}</dd>
        </div>
        <div>
          <dt>Classifier score</dt>
          <dd>${escapeHtml(classifierScore)}</dd>
        </div>
        <div>
          <dt>Classifier confidence</dt>
          <dd>${escapeHtml(classifierConfidence)}</dd>
        </div>
      </dl>
      <div class="routing-callout">
        <p class="eyebrow">Routing reason</p>
        <p>${escapeHtml(task.routing_reason ?? "Routing has not been computed yet.")}</p>
      </div>
    </div>
  `;
}

function bindEvents() {
  document
    .querySelector<HTMLElement>("[data-action='scan-repos']")
    ?.addEventListener("click", () => {
      void runAction("Scanning workspace parent...", async () => {
        await refreshScanCandidates();
        state.notice = `Found ${state.scanCandidates.length} candidate repositories.`;
      });
    });

  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-repo-id]")) {
    button.addEventListener("click", () => {
      const repoId = button.dataset.repoId;

      if (repoId) {
        void selectRepository(repoId);
      }
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-import-root]")) {
    button.addEventListener("click", () => {
      const rootPath = button.dataset.importRoot;
      const parentSource = button.dataset.importParent;

      if (rootPath && parentSource) {
        void importRepository(rootPath, parentSource);
      }
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-task-id]")) {
    button.addEventListener("click", () => {
      const taskId = button.dataset.taskId;

      if (taskId) {
        void selectTask(taskId);
      }
    });
  }

  document.querySelector<HTMLFormElement>("#policy-form")?.addEventListener("submit", (event) => {
    event.preventDefault();

    if (event.currentTarget instanceof HTMLFormElement) {
      void savePolicy(event.currentTarget);
    }
  });

  document.querySelector<HTMLFormElement>("#task-form")?.addEventListener("submit", (event) => {
    event.preventDefault();

    if (event.currentTarget instanceof HTMLFormElement) {
      void createTaskFromForm(event.currentTarget);
    }
  });
}

function getSelectedRepository() {
  return state.repositories.find((entry) => entry.repository.id === state.selectedRepoId) ?? null;
}

function renderOptions(values: readonly string[], selectedValue: string | null) {
  return values
    .map(
      (value) =>
        `<option value="${escapeHtml(value)}" ${selectedValue === value ? "selected" : ""}>${escapeHtml(value)}</option>`,
    )
    .join("");
}

function renderToggle(name: string, label: string, checked: boolean) {
  return `
    <label class="toggle-card">
      <input name="${escapeHtml(name)}" type="checkbox" ${checked ? "checked" : ""} />
      <span>${escapeHtml(label)}</span>
    </label>
  `;
}

async function apiRequest<T>(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);

  headers.set("accept", "application/json");

  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(resolveApiUrl(path), {
    ...init,
    headers,
  });
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;

  if (!response.ok) {
    throw new Error(payload?.error ?? `Request failed with status ${response.status}.`);
  }

  return payload as T;
}

function resolveApiUrl(path: string) {
  return new URL(path, state.apiBaseUrl || window.location.origin).toString();
}

function requireStringValue(formData: FormData, key: string) {
  const value = formData.get(key);

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} is required.`);
  }

  return value.trim();
}

function optionalStringValue(formData: FormData, key: string) {
  const value = formData.get(key);

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : null;
}

function requireSelectValue(formData: FormData, key: string) {
  const value = optionalStringValue(formData, key);

  if (!value) {
    throw new Error(`${key} is required.`);
  }

  return value;
}

function requireNumberValue(formData: FormData, key: string) {
  const value = requireStringValue(formData, key);
  const parsed = Number(value);

  if (Number.isNaN(parsed)) {
    throw new Error(`${key} must be a number.`);
  }

  return parsed;
}

function optionalNumberValue(formData: FormData, key: string) {
  const value = optionalStringValue(formData, key);

  if (value === null) {
    return null;
  }

  const parsed = Number(value);

  if (Number.isNaN(parsed)) {
    throw new Error(`${key} must be a number.`);
  }

  return parsed;
}

function readCheckbox(form: HTMLFormElement, name: string) {
  return form.querySelector<HTMLInputElement>(`input[name='${name}']`)?.checked ?? false;
}

function setError(message: string) {
  state.error = message;
  state.notice = null;
}

function toErrorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Something went wrong while talking to the control plane.";
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
