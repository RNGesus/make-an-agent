import { startTransition, useEffect, useState } from "react";
import { useOperatorApp } from "./operator-app";
import {
  apiRequest,
  type TaskActionResult,
  type TaskDetail,
  type TaskDiff,
  type TaskSummary,
  toTaskPayload,
} from "./operator-api";

export function useRepoWorkspace(repoId: string | null, requestedTaskId?: string | null) {
  const { refreshApprovals, runAction, setNotice } = useOperatorApp();
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [selectedTask, setSelectedTask] = useState<TaskDetail | null>(null);
  const [selectedTaskDiff, setSelectedTaskDiff] = useState<TaskDiff | null>(null);
  const [loading, setLoading] = useState(false);

  const previewTaskId = requestedTaskId ?? tasks[0]?.task.id ?? null;

  useEffect(() => {
    if (!repoId) {
      setTasks([]);
      setSelectedTask(null);
      setSelectedTaskDiff(null);
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
      setSelectedTaskDiff(null);
      return;
    }

    void Promise.all([loadTaskDetail(previewTaskId), loadTaskDiff(previewTaskId)]);
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

  async function loadTaskDiff(taskId: string) {
    const diff = await apiRequest<TaskDiff>(`/api/tasks/${encodeURIComponent(taskId)}/diff`);

    startTransition(() => {
      setSelectedTaskDiff(diff);
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
    await loadTaskDiff(detail.task.id);
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
    await loadTaskDiff(detail.task.id);
    return detail;
  }

  async function commitTask(taskId: string, message?: string) {
    const result = await runAction("Committing task branch...", () =>
      apiRequest<TaskActionResult>(`/api/tasks/${encodeURIComponent(taskId)}/commit`, {
        body: JSON.stringify(message ? { message } : {}),
        method: "POST",
      }),
    );

    if (!result) {
      return null;
    }

    if (repoId) {
      await Promise.all([refreshTasks(repoId), refreshApprovals()]);
    } else {
      await refreshApprovals();
    }

    await loadTaskDiff(result.task.task.id);
    setSelectedTask(result.task);
    setNotice(
      result.approval
        ? `Requested commit approval for ${result.task.task.title}.`
        : `Committed changes for ${result.task.task.title}.`,
    );

    return result;
  }

  async function createPullRequest(taskId: string) {
    const result = await runAction("Preparing pull request draft...", () =>
      apiRequest<TaskActionResult>(`/api/tasks/${encodeURIComponent(taskId)}/pr`, {
        body: JSON.stringify({}),
        method: "POST",
      }),
    );

    if (!result) {
      return null;
    }

    if (repoId) {
      await Promise.all([refreshTasks(repoId), refreshApprovals()]);
    } else {
      await refreshApprovals();
    }

    await loadTaskDiff(result.task.task.id);
    setSelectedTask(result.task);
    setNotice(
      result.approval
        ? `Requested PR approval for ${result.task.task.title}.`
        : `Prepared a PR draft for ${result.task.task.title}.`,
    );

    return result;
  }

  return {
    commitTask,
    createPullRequest,
    createTask,
    loading,
    previewTaskId,
    retryTask,
    selectedTask,
    selectedTaskDiff,
    tasks,
  };
}
