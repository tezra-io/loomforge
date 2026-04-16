import type { Logger } from "pino";

import type { WorkflowEngine } from "../workflow/index.js";

export interface DrainScheduler {
  schedule(): void;
  drainNow(): Promise<void>;
}

export function createDrainScheduler(engine: WorkflowEngine, logger: Logger): DrainScheduler {
  let draining = false;
  let rescheduleRequested = false;

  async function drainLoop(): Promise<void> {
    if (draining) {
      rescheduleRequested = true;
      return;
    }

    draining = true;
    try {
      do {
        rescheduleRequested = false;
        while (await engine.drainNext()) {
          continue;
        }
      } while (rescheduleRequested);
    } catch (error) {
      logger.error({ error }, "workflow drain failed");
    } finally {
      draining = false;
    }
  }

  return {
    schedule: () => {
      void drainLoop();
    },
    drainNow: drainLoop,
  };
}
