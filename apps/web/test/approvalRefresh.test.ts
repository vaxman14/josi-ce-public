import { afterEach, expect, it, vi } from 'vitest';
import { watchApprovals } from '../src/lib/approvalRefresh.js';
afterEach(() => vi.useRealTimers());
it('publishes backend count and exact IDs and follows the backend refresh cadence', async () => {
  vi.useFakeTimers();
  const initial = { approvals: [{id:'exact-one'},{id:'exact-two'}], count:102, refreshAfterMs:750 };
  const updated = { approvals: [{id:'exact-two'}], count:1, refreshAfterMs:250 };
  const fetch = vi.fn().mockResolvedValueOnce(initial).mockResolvedValue(updated);
  const publish = vi.fn(); const stop=watchApprovals(fetch,publish);
  await vi.advanceTimersByTimeAsync(0);
  expect(publish).toHaveBeenLastCalledWith(initial);
  await vi.advanceTimersByTimeAsync(749); expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(publish).toHaveBeenLastCalledWith(updated);
  await vi.advanceTimersByTimeAsync(250); expect(fetch).toHaveBeenCalledTimes(3);
  stop(); await vi.advanceTimersByTimeAsync(1000); expect(fetch).toHaveBeenCalledTimes(3);
});
it('does not publish late responses after unmount and retries a failed read', async () => {
  vi.useFakeTimers();
  let resolve!: (value: {approvals:never[];count:number;refreshAfterMs:number}) => void;
  const fetch=vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementation(() => new Promise(r=>{resolve=r;}));
  const publish=vi.fn(); const stop=watchApprovals(fetch,publish);
  await vi.advanceTimersByTimeAsync(2000); expect(fetch).toHaveBeenCalledTimes(2);
  stop(); resolve({approvals:[],count:0,refreshAfterMs:100});
  await vi.advanceTimersByTimeAsync(1000); expect(publish).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(2);
});
