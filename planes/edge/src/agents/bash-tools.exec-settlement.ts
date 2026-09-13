import {
  authorityOutcomeFromExecProcess,
  finishExecKernelAuthorityGate,
  type ExecBeforeSpawnGate,
} from "./bash-tools.exec-kernel-authority-gate.js";
import type { ExecProcessOutcome } from "./bash-tools.exec-runtime.js";
/**
 * Settlement of one exec tool call's process outcome for the local hosts (gateway inline and
 * sandbox, which share `runExecProcess`): records the outcome, finalizes the background task
 * ledger, and sends the APEX kernel authority receipt (`finish`) for the approval the kernel
 * consumed before the spawn.
 *
 * The receipt is fire-and-forget: by the time the process settles the effect has already
 * run, `finish()` never throws, and a settlement that fires twice (a finalizer failure
 * rebuilds the outcome) still sends exactly one receipt because the gate forgets the
 * consumed id after the first.
 */
import type { BackgroundExecTaskHandle } from "./bash-tools.exec-task-tracking.js";
import { finalizeBackgroundExecTask } from "./bash-tools.exec-task-tracking.js";

export type ExecProcessSettlement = {
  outcome: ExecProcessOutcome | null;
  backgroundTask: BackgroundExecTaskHandle | null;
  /** Set once the exec tool has built the call's kernel gate; absent in native mode. */
  kernelAuthorityGate: ExecBeforeSpawnGate | undefined;
  settle: (outcome: ExecProcessOutcome) => void;
};

export function createExecProcessSettlement(): ExecProcessSettlement {
  const settlement: ExecProcessSettlement = {
    outcome: null,
    backgroundTask: null,
    kernelAuthorityGate: undefined,
    settle(outcome: ExecProcessOutcome) {
      settlement.outcome = outcome;
      finalizeBackgroundExecTask({ handle: settlement.backgroundTask, outcome });
      void finishExecKernelAuthorityGate(
        settlement.kernelAuthorityGate,
        authorityOutcomeFromExecProcess(outcome),
      );
    },
  };
  return settlement;
}
