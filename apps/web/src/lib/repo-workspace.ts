import { startTransition, useEffect, useState } from "react";
import { useOperatorApp } from "./operator-app";
import { apiRequest, type TaskDetail, type TaskSummary, toTaskPayload } from "./operator-api";

export function useRepoWorkspace(repoId: string | null, requestedTaskId?: string | null) {
  const { refreshApprovals, runAction, setNotice } = useOperatorApp();
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [selectedTask, setSelectedTask] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(false);

  const previewTaskId = requestedTaskId ?? tasks[0]?.task.id ?? null;

  useEffect(() => {
    if (!repoId) {
      setTasks([]);
      setSelectedTask(null);
      return;
    }

    setLoading(true);
    void refreshTasks(repoId).finally(() => {
      setLoading(false);
    });
  }, [repoId]);

  useEffect(() => {
    if (!previewTaskId) {
      setSelectedTask(null);
      return;
    }

    void loadTaskDetail(previewTaskId);
  }, [previewTaskId]);

  async function refreshTasks(nextRepoId: string) {
    const payload = await apiRequest<{ tasks: TaskSummary[] }>(
      `/api/tasks?repo_id=${encodeURIComponent(nextRepoId)}`,
    );

    startTransition(() => {
      setTasks(payload.tasks);
    });
  }

  async function loadTaskDetail(taskId: string) {
    const detail = await apiRequest<TaskDetail>(`/api/tasks/${encodeURIComponent(taskId)}`);

    startTransition(() => {
      setSelectedTask(detail);
    });
  }

  async function createTask(formData: FormData) {
    if (!repoId) {
      return null;
    }

    const detail = await runAction("Creating task...", () =>
      apiRequest<TaskDetail>("/api/tasks", {
        body: JSON.stringify(toTaskPayload(formData, repoId)),
        method: "POST",
      }),
    );

    if (!detail) {
      return null;
    }

    setNotice(`Created task ${detail.task.title}.`);
    await Promise.all([refreshTasks(repoId), refreshApprovals()]);
    setSelectedTask(detail);
    return detail;
  }

  async function retryTask(taskId: string) {
    const detail = await runAction("Running task...", () =>
      apiRequest<TaskDetail>(`/api/tasks/${encodeURIComponent(taskId)}/retry`, {
        method: "POST",
      }),
    );

    if (!detail) {
      return null;
    }

    setNotice(`Updated task ${detail.task.title}.`);

    if (repoId) {
      await Promise.all([refreshTasks(repoId), refreshApprovals()]);
    } else {
      await refreshApprovals();
    }

    setSelectedTask(detail);
    return detail;
  }

  return {
    createTask,
    loading,
    previewTaskId,
    retryTask,
    selectedTask,
    tasks,
  };
}
