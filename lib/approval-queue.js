/**
 * The single-slot approval queue.
 *
 * The Web client keeps one pending approval per session and replaces an older
 * prompt with a newer one, so two approvals that overlap in time would leave the
 * first one permanently unanswerable. This queue makes overlap impossible: only
 * one request holds the slot, and the rest wait until it settles. System-related
 * requests — the ones that can disturb the machine or another program — are
 * served before ordinary ones while they wait.
 *
 * @module dsh-project-guard/lib/approval-queue
 */

/**
 * @param {boolean} prioritizeSystem serve waiting system requests first.
 */
export function createApprovalQueue(prioritizeSystem) {
  let busy = false;
  const waiting = [];

  const pump = () => {
    if (busy || waiting.length === 0) return;
    let index = 0;
    if (prioritizeSystem) {
      const firstSystem = waiting.findIndex((entry) => entry.priority === true);
      if (firstSystem !== -1) index = firstSystem;
    }
    const [entry] = waiting.splice(index, 1);
    busy = true;
    entry.detach();
    entry.grant();
  };

  return {
    /**
     * Wait for the single slot.
     *
     * @param {AbortSignal|undefined} signal the requesting call's signal.
     * @param {boolean} priority whether this request concerns the system.
     * @returns {Promise<boolean>} `true` when the slot is held, `false` when the
     *   request was aborted while waiting.
     */
    acquire(signal, priority) {
      return new Promise((resolve) => {
        if (signal?.aborted) {
          resolve(false);
          return;
        }
        const entry = { priority, grant: () => resolve(true), detach: () => {} };
        if (signal !== undefined) {
          const onAbort = () => {
            const at = waiting.indexOf(entry);
            if (at === -1) return;
            waiting.splice(at, 1);
            resolve(false);
          };
          signal.addEventListener('abort', onAbort, { once: true });
          entry.detach = () => signal.removeEventListener('abort', onAbort);
        }
        waiting.push(entry);
        pump();
      });
    },

    /** Release the slot and let the next waiter in. */
    release() {
      busy = false;
      pump();
    },

    /** Release every waiter, used when the plugin unloads. */
    drain() {
      for (const entry of waiting.splice(0, waiting.length)) {
        entry.detach();
        entry.grant();
      }
    },

    /** Diagnostics for tests. */
    get size() {
      return waiting.length;
    },
    get held() {
      return busy;
    }
  };
}
