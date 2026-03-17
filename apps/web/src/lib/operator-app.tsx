import { createContext, startTransition, use, useEffect, useState } from "react";
import type { ApprovalRecord, ApprovalScope, RepositoryPolicyRecord } from "shared";
import {
  apiRequest,
  getApiTargetLabel,
  type RepositoryDetail,
  type RepositoryScanCandidate,
  type TaskDetail,
  toErrorMessage,
} from "./operator-api";

type OperatorAppContextValue = {
  apiTargetLabel: string;
  approvals: ApprovalRecord[];
  error: string | null;
  importRepository: (rootPath: string, parentSource: string) => Promise<RepositoryDetail | null>;
  loading: boolean;
  notice: string | null;
  refreshApprovals: () => Promise<void>;
  refreshRepositories: () => Promise<void>;
  refreshScanCandidates: () => Promise<void>;
  rejectApproval: (approvalId: string) => Promise<TaskDetail | null>;
  repositories: RepositoryDetail[];
  savePolicy: (
    repoId: string,
    payload: Partial<RepositoryPolicyRecord>,
  ) => Promise<RepositoryDetail | null>;
  scanCandidates: RepositoryScanCandidate[];
  setNotice: (message: string | null) => void;
  working: string | null;
  resolveApproval: (approvalId: string, scope: ApprovalScope | null) => Promise<TaskDetail | null>;
  runAction: <T>(label: string, action: () => Promise<T>) => Promise<T | null>;
};

const OperatorAppContext = createContext<OperatorAppContextValue | null>(null);

export function OperatorAppProvider(props: { children: React.ReactNode }) {
  const [repositories, setRepositories] = useState<RepositoryDetail[]>([]);
  const [scanCandidates, setScanCandidates] = useState<RepositoryScanCandidate[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void bootstrap();
  }, []);

  async function bootstrap() {
    try {
      await Promise.all([refreshRepositories(), refreshScanCandidates(), refreshApprovals()]);
    } catch (nextError) {
      setError(toErrorMessage(nextError));
      setNotice(null);
    } finally {
      setLoading(false);
    }
  }

  async function refreshRepositories() {
    const payload = await apiRequest<{ repositories: RepositoryDetail[] }>("/api/repos");

    startTransition(() => {
      setRepositories(payload.repositories);
    });
  }

  async function refreshScanCandidates() {
    const payload = await apiRequest<{ candidates: RepositoryScanCandidate[] }>("/api/repos/scan", {
      method: "POST",
    });

    startTransition(() => {
      setScanCandidates(payload.candidates);
    });
  }

  async function refreshApprovals() {
    const payload = await apiRequest<{ approvals: ApprovalRecord[] }>("/api/approvals");

    startTransition(() => {
      setApprovals(payload.approvals);
    });
  }

  async function runAction<T>(label: string, action: () => Promise<T>) {
    setWorking(label);
    setError(null);

    try {
      return await action();
    } catch (nextError) {
      setError(toErrorMessage(nextError));
      setNotice(null);
      return null;
    } finally {
      setWorking(null);
    }
  }

  async function importRepository(rootPath: string, parentSource: string) {
    const detail = await runAction("Importing repository...", () =>
      apiRequest<RepositoryDetail>("/api/repos", {
        body: JSON.stringify({ parent_source: parentSource, root_path: rootPath }),
        method: "POST",
      }),
    );

    if (!detail) {
      return null;
    }

    setNotice(`Imported ${detail.repository.name}.`);
    await Promise.all([refreshRepositories(), refreshScanCandidates()]);
    return detail;
  }

  async function savePolicy(repoId: string, payload: Partial<RepositoryPolicyRecord>) {
    const detail = await runAction("Saving policy...", () =>
      apiRequest<RepositoryDetail>(`/api/repos/${encodeURIComponent(repoId)}/policy`, {
        body: JSON.stringify(payload),
        method: "PATCH",
      }),
    );

    if (!detail) {
      return null;
    }

    setRepositories((current) =>
      current.map((entry) => (entry.repository.id === detail.repository.id ? detail : entry)),
    );
    setNotice(`Saved policy for ${detail.repository.name}.`);
    return detail;
  }

  async function resolveApproval(approvalId: string, scope: ApprovalScope | null) {
    const result = await runAction("Resolving approval...", () =>
      apiRequest<{ approval: ApprovalRecord; task: TaskDetail }>(
        `/api/approvals/${encodeURIComponent(approvalId)}/approve`,
        {
          body: JSON.stringify(scope ? { scope } : {}),
          method: "POST",
        },
      ),
    );

    if (!result) {
      return null;
    }

    setNotice(`Approved ${result.approval.approval_type} for ${result.task.task.title}.`);
    await Promise.all([refreshApprovals(), refreshRepositories()]);
    return result.task;
  }

  async function rejectApproval(approvalId: string) {
    const result = await runAction("Rejecting approval...", () =>
      apiRequest<{ approval: ApprovalRecord; task: TaskDetail }>(
        `/api/approvals/${encodeURIComponent(approvalId)}/reject`,
        {
          body: JSON.stringify({}),
          method: "POST",
        },
      ),
    );

    if (!result) {
      return null;
    }

    setNotice(`Rejected ${result.approval.approval_type} for ${result.task.task.title}.`);
    await Promise.all([refreshApprovals(), refreshRepositories()]);
    return result.task;
  }

  return (
    <OperatorAppContext
      value={{
        apiTargetLabel: getApiTargetLabel(),
        approvals,
        error,
        importRepository,
        loading,
        notice,
        refreshApprovals,
        refreshRepositories,
        refreshScanCandidates,
        rejectApproval,
        repositories,
        resolveApproval,
        runAction,
        savePolicy,
        scanCandidates,
        setNotice,
        working,
      }}
    >
      {props.children}
    </OperatorAppContext>
  );
}

export function useOperatorApp() {
  const context = use(OperatorAppContext);

  if (!context) {
    throw new Error("useOperatorApp must be used inside OperatorAppProvider.");
  }

  return context;
}
