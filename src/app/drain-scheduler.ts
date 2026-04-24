import type { Logger } from "pino";

import type { WorkflowEngine } from "../workflow/index.js";

export interface DrainScheduler {
  schedule(): void;
  drainNow(): Promise<void>;
}

interface Drainable {
  drainNext(): Promise<unknown>;
}

export function createDrainScheduler(engine: WorkflowEngine, logger: Logger): DrainScheduler {
  return createGenericDrainScheduler(engine, logger, "workflow");
}

export function createGenericDrainScheduler(
  engine: Drainable,
  logger: Logger,
  label: string,
): DrainScheduler {
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
      logger.error({ error, label }, `${label} drain failed`);
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
