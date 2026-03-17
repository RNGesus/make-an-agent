import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { ApprovalPanel } from "../components/approval-panel";
import { PolicyPanel } from "../components/policy-panel";
import { RepositoryLibraryPanel, WorkspaceScanPanel } from "../components/repository-panels";
import { TaskDetailPanel, TaskFormPanel, TaskListPanel } from "../components/task-panels";
import { useOperatorApp } from "../lib/operator-app";
import { useRepoWorkspace } from "../lib/repo-workspace";

export function ReposDashboardPage(props: { repoId?: string; taskId?: string }) {
  const navigate = useNavigate();
  const {
    approvals,
    importRepository,
    refreshScanCandidates,
    repositories,
    resolveApproval,
    savePolicy,
    scanCandidates,
    rejectApproval,
  } = useOperatorApp();
  const selectedRepository =
    repositories.find((entry) => entry.repository.id === props.repoId) ?? repositories[0] ?? null;
  const selectedApproval =
    approvals.find((approval) => approval.id === approvals[0]?.id) ?? approvals[0] ?? null;
  const workspace = useRepoWorkspace(selectedRepository?.repository.id ?? null, props.taskId);

  useEffect(() => {
    if (!props.repoId && selectedRepository) {
      void navigate({
        params: { repoId: selectedRepository.repository.id },
        replace: true,
        to: "/repos/$repoId",
      });
    }
  }, [navigate, props.repoId, selectedRepository]);

  return (
    <div className="layout">
      <section className="stack-column">
        <RepositoryLibraryPanel
          onRescan={async () => {
            await refreshScanCandidates();
          }}
          registeredCount={repositories.length}
          repositories={repositories}
          scanCount={scanCandidates.length}
          selectedRepoId={selectedRepository?.repository.id ?? null}
        />
        <WorkspaceScanPanel
          candidates={scanCandidates}
          onImport={async (rootPath, parentSource) => {
            const detail = await importRepository(rootPath, parentSource);

            if (detail) {
              void navigate({
                params: { repoId: detail.repository.id },
                to: "/repos/$repoId",
              });
            }
          }}
        />
      </section>

      <section className="content-column">
        <PolicyPanel
          onSubmit={async (payload) => {
            if (!selectedRepository) {
              return;
            }

            await savePolicy(selectedRepository.repository.id, payload);
          }}
          repositoryDetail={selectedRepository}
        />

        <ApprovalPanel
          approvals={approvals}
          onApprove={async (approvalId, scope) => {
            const task = await resolveApproval(approvalId, scope);

            if (task) {
              void navigate({
                params: {
                  repoId: task.repository.id,
                  taskId: task.task.id,
                },
                to: "/repos/$repoId/tasks/$taskId",
              });
            }
          }}
          onReject={async (approvalId) => {
            const task = await rejectApproval(approvalId);

            if (task) {
              void navigate({
                params: {
                  repoId: task.repository.id,
                  taskId: task.task.id,
                },
                to: "/repos/$repoId/tasks/$taskId",
              });
            }
          }}
          selectedApproval={selectedApproval}
          selectedApprovalId={selectedApproval?.id ?? null}
        />

        <section className="task-grid">
          <TaskFormPanel
            onSubmit={async (formData) => {
              const detail = await workspace.createTask(formData);

              if (detail) {
                void navigate({
                  params: {
                    repoId: detail.repository.id,
                    taskId: detail.task.id,
                  },
                  to: "/repos/$repoId/tasks/$taskId",
                });
              }
            }}
            repositoryDetail={selectedRepository}
          />
          <TaskListPanel
            repoId={selectedRepository?.repository.id ?? null}
            selectedTaskId={workspace.previewTaskId}
            tasks={workspace.tasks}
          />
          <TaskDetailPanel
            onRetry={async (taskId) => {
              const detail = await workspace.retryTask(taskId);

              if (detail) {
                void navigate({
                  params: {
                    repoId: detail.repository.id,
                    taskId: detail.task.id,
                  },
                  to: "/repos/$repoId/tasks/$taskId",
                });
              }
            }}
            taskDetail={workspace.selectedTask}
          />
        </section>
      </section>
    </div>
  );
}
