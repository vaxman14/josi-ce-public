/** The server owns eligibility, count and refresh cadence. Never infer pending
 * from cached task state or trim requests by summary, age or display position. */
export interface ApprovalSnapshot<T> {
  approvals: T[];
  count: number;
  refreshAfterMs: number;
}

export function watchApprovals<T>(
  fetchSnapshot: () => Promise<ApprovalSnapshot<T>>,
  publish: (snapshot: ApprovalSnapshot<T>) => void,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  let delay = 2000;
  async function refresh() {
    try {
      const snapshot = await fetchSnapshot();
      if (stopped) return;
      delay = snapshot.refreshAfterMs;
      publish(snapshot);
    } catch { /* Keep the last successful snapshot; retry transient failures. */ }
    if (!stopped) timer = setTimeout(() => void refresh(), delay);
  }
  void refresh();
  return () => { stopped = true; clearTimeout(timer); };
}
