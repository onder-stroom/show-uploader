import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { deps } from '../../deps';
import { UseCaseError } from '../../usecases/errors';
import { agentStatus, cutStatuses, listRecordings, loadDraft, recordingPeaks, rescanRecordings, saveDraft, signPreviewPath, startCuts } from '../../usecases/recording-cuts';
import { protectedProcedure, router } from '../trpc';

// Validation and error mapping only. The rules live in usecases/recording-cuts.ts.
function refuse(err: unknown): never {
  if (err instanceof UseCaseError) throw new TRPCError({ code: err.code, message: err.message });
  throw err;
}

const Ref = z.object({ ref: z.string().min(1) });

const Segment = z.object({
  startS: z.number().finite(),
  endS: z.number().finite(),
  showId: z.string().min(1),
});

export const recordingsRouter = router({
  /** Recordings on the OBS PC, or `{ reachable: false }`. */
  list: protectedProcedure.query(() => listRecordings(deps)),

  /** Which build the PC service is, and whether it is new enough. */
  agentStatus: protectedProcedure.query(() => agentStatus(deps)),

  /** The segments saved for a recording; a PC that is off or too old gives `problem`, never an error. */
  getDraft: protectedProcedure.input(Ref).query(async ({ input }) => {
    try {
      return await loadDraft(input.ref, deps);
    } catch (err) {
      refuse(err);
    }
  }),

  saveDraft: protectedProcedure
    .input(z.object({ ref: z.string().min(1), segments: z.array(z.unknown()).max(100) }))
    .mutation(async ({ input }) => {
      try {
        return await saveDraft(input.ref, input.segments, deps);
      } catch (err) {
        refuse(err);
      }
    }),

  /** Ask the PC to look at its folder now, so files deleted by hand disappear at once. */
  rescan: protectedProcedure.mutation(() => rescanRecordings(deps)),

  peaks: protectedProcedure.input(Ref).query(async ({ input }) => {
    try {
      return await recordingPeaks(input.ref, deps);
    } catch (err) {
      refuse(err);
    }
  }),

  // Keyed by recording, so the client signs once per viewing session and the <video src>
  // never swaps while it plays (see AGENTS.md: no signed URLs in polled responses).
  signPreview: protectedProcedure.input(Ref).query(async ({ input }) => {
    try {
      return await signPreviewPath(input.ref, deps);
    } catch (err) {
      refuse(err);
    }
  }),

  startCuts: protectedProcedure
    .input(z.object({ ref: z.string().min(1), segments: z.array(Segment).min(1).max(20) }))
    .mutation(async ({ input }) => {
      try {
        return await startCuts(input, deps);
      } catch (err) {
        refuse(err);
      }
    }),

  cutStatuses: protectedProcedure
    .input(z.object({ cutIds: z.array(z.string().min(1)).max(50) }))
    .query(({ input }) => cutStatuses(input.cutIds, deps)),
});
