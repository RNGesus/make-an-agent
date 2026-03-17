import { autonomyModes } from "shared";
import type { RepositoryDetail } from "../lib/operator-api";
import { toPolicyPayload } from "../lib/operator-api";

type PolicyPanelProps = {
  onSubmit: (payload: ReturnType<typeof toPolicyPayload>) => Promise<void>;
  repositoryDetail: RepositoryDetail | null;
};

export function PolicyPanel(props: PolicyPanelProps) {
  const selectedRepository = props.repositoryDetail;

  return (
    <article className="panel">
      <div className="section-head">
        <div>
          <p className="eyebrow">Policy Editor</p>
          <h2>{selectedRepository ? selectedRepository.repository.name : "Choose a repository"}</h2>
        </div>
        {selectedRepository ? (
          <span className="badge">{selectedRepository.repository.default_branch}</span>
        ) : null}
      </div>

      {!selectedRepository ? (
        <p className="empty-state">
          Import or select a repository to edit its policy and model profile.
        </p>
      ) : (
        <>
          <div className="repo-overview">
            <div>
              <p className="eyebrow">Workspace root</p>
              <strong>{selectedRepository.repository.root_path}</strong>
            </div>
            <div>
              <p className="eyebrow">Remote</p>
              <strong>{selectedRepository.repository.remote_url ?? "No origin configured"}</strong>
            </div>
          </div>

          <form
            className="form-stack panel-form"
            onSubmit={(event) => {
              event.preventDefault();
              void props.onSubmit(toPolicyPayload(new FormData(event.currentTarget)));
            }}
          >
            <div className="field-grid two-up">
              <label>
                <span>Autonomy mode</span>
                <select defaultValue={selectedRepository.policy.autonomy_mode} name="autonomy_mode">
                  {autonomyModes.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Allowed root</span>
                <input defaultValue={selectedRepository.policy.allowed_root} name="allowed_root" />
              </label>
            </div>

            <div className="field-grid four-up toggle-grid">
              <ToggleCard
                checked={selectedRepository.policy.allow_read}
                label="Read access"
                name="allow_read"
              />
              <ToggleCard
                checked={selectedRepository.policy.allow_edit}
                label="Edit files"
                name="allow_edit"
              />
              <ToggleCard
                checked={selectedRepository.policy.allow_bash}
                label="Run bash"
                name="allow_bash"
              />
              <ToggleCard
                checked={selectedRepository.policy.allow_git_write}
                label="Git writes"
                name="allow_git_write"
              />
              <ToggleCard
                checked={selectedRepository.policy.allow_pr_create}
                label="Create PRs"
                name="allow_pr_create"
              />
              <ToggleCard
                checked={selectedRepository.policy.approval_required_for_edit}
                label="Approve edits"
                name="approval_required_for_edit"
              />
              <ToggleCard
                checked={selectedRepository.policy.approval_required_for_commit}
                label="Approve commits"
                name="approval_required_for_commit"
              />
              <ToggleCard
                checked={selectedRepository.policy.approval_required_for_pr}
                label="Approve PRs"
                name="approval_required_for_pr"
              />
              <ToggleCard
                checked={selectedRepository.policy.approval_required_for_risky_bash}
                label="Approve risky bash"
                name="approval_required_for_risky_bash"
              />
            </div>

            <div className="field-grid two-up">
              <TextField
                defaultValue={selectedRepository.policy.cheap_provider}
                label="Cheap provider"
                name="cheap_provider"
              />
              <TextField
                defaultValue={selectedRepository.policy.cheap_model}
                label="Cheap model"
                name="cheap_model"
              />
              <TextField
                defaultValue={selectedRepository.policy.strong_provider}
                label="Strong provider"
                name="strong_provider"
              />
              <TextField
                defaultValue={selectedRepository.policy.strong_model}
                label="Strong model"
                name="strong_model"
              />
              <TextField
                defaultValue={selectedRepository.policy.classifier_provider ?? ""}
                label="Classifier provider"
                name="classifier_provider"
              />
              <TextField
                defaultValue={selectedRepository.policy.classifier_model ?? ""}
                label="Classifier model"
                name="classifier_model"
              />
              <TextField
                defaultValue={String(selectedRepository.policy.max_escalations)}
                label="Max escalations"
                min="0"
                name="max_escalations"
                step="1"
                type="number"
              />
              <TextField
                defaultValue={String(selectedRepository.policy.max_task_budget_usd)}
                label="Task budget USD"
                min="0"
                name="max_task_budget_usd"
                step="0.01"
                type="number"
              />
            </div>

            <div className="form-actions">
              <button className="solid-button" type="submit">
                Save policy
              </button>
            </div>
          </form>
        </>
      )}
    </article>
  );
}

function TextField(props: {
  defaultValue: string;
  label: string;
  min?: string;
  name: string;
  step?: string;
  type?: string;
}) {
  return (
    <label>
      <span>{props.label}</span>
      <input
        defaultValue={props.defaultValue}
        min={props.min}
        name={props.name}
        step={props.step}
        type={props.type ?? "text"}
      />
    </label>
  );
}

function ToggleCard(props: { checked: boolean; label: string; name: string }) {
  return (
    <label className="toggle-card">
      <input defaultChecked={props.checked} name={props.name} type="checkbox" />
      <span>{props.label}</span>
    </label>
  );
}
