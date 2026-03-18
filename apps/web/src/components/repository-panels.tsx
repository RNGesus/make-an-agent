import { Link } from "@tanstack/react-router";
import type { RepositoryDetail, RepositoryScanCandidate } from "../lib/operator-api";

type RepositoryLibraryPanelProps = {
  onRescan: () => Promise<void>;
  registeredCount: number;
  repositories: RepositoryDetail[];
  scanCount: number;
  selectedRepoId: string | null;
};

type WorkspaceScanPanelProps = {
  candidates: RepositoryScanCandidate[];
  onImport: (rootPath: string, parentSource: string) => Promise<void>;
  warning: string | null;
};

export function RepositoryLibraryPanel(props: RepositoryLibraryPanelProps) {
  return (
    <article className="panel">
      <div className="section-head">
        <div>
          <p className="eyebrow">Repository Library</p>
          <h2>Scan the workspace parent and import repos into the registry.</h2>
        </div>
        <button className="ghost-button" onClick={() => void props.onRescan()} type="button">
          Rescan parent
        </button>
      </div>

      <div className="stat-strip">
        <div>
          <span className="stat-value">{props.registeredCount}</span>
          <span className="stat-label">registered</span>
        </div>
        <div>
          <span className="stat-value">{props.scanCount}</span>
          <span className="stat-label">discovered</span>
        </div>
      </div>

      <div className="repo-list">
        {props.repositories.length === 0 ? (
          <p className="empty-state">No repositories are registered yet.</p>
        ) : (
          props.repositories.map((entry) => {
            const isSelected = entry.repository.id === props.selectedRepoId;

            return (
              <Link
                className={`repo-item ${isSelected ? "repo-item-selected" : ""}`}
                key={entry.repository.id}
                params={{ repoId: entry.repository.id }}
                to="/repos/$repoId"
              >
                <span>
                  <strong>{entry.repository.name}</strong>
                  <small>{entry.repository.root_path}</small>
                </span>
                <span className="repo-meta">
                  <span className="chip">{entry.policy.autonomy_mode}</span>
                  <span className="chip chip-soft">{entry.policy.strong_model}</span>
                </span>
              </Link>
            );
          })
        )}
      </div>
    </article>
  );
}

export function WorkspaceScanPanel(props: WorkspaceScanPanelProps) {
  return (
    <article className="panel">
      <div className="section-head compact-head">
        <div>
          <p className="eyebrow">Workspace Scan</p>
          <h2>Import candidates</h2>
        </div>
      </div>

      <div className="candidate-list">
        {props.candidates.length === 0 ? (
          <p className="empty-state">
            {props.warning ??
              "No git repositories were found under the configured workspace parent."}
          </p>
        ) : (
          props.candidates.map((candidate) => (
            <article className="candidate-card" key={candidate.root_path}>
              <div>
                <strong>{candidate.name}</strong>
                <p>{candidate.root_path}</p>
              </div>
              <div className="candidate-meta">
                <span className="chip">{candidate.default_branch}</span>
                <span className="chip chip-soft">{candidate.github_repo ?? "local"}</span>
                {candidate.is_registered && candidate.registered_repo_id ? (
                  <Link
                    className="ghost-button"
                    params={{ repoId: candidate.registered_repo_id }}
                    to="/repos/$repoId"
                  >
                    View repo
                  </Link>
                ) : (
                  <button
                    className="solid-button"
                    onClick={() =>
                      void props.onImport(candidate.root_path, candidate.parent_source)
                    }
                    type="button"
                  >
                    Import
                  </button>
                )}
              </div>
            </article>
          ))
        )}
      </div>
    </article>
  );
}
