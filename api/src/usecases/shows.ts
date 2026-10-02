import { baseTitle } from '@show-uploader/domain';
import type { ApiDeps } from '../ports';
import { UseCaseError } from './errors';

export type NewShowInput = {
  title: string;
  /** YYYY-MM-DD, UTC like every agenda time. */
  date: string;
  /** HH:MM, UTC. */
  startTime: string;
  /** HH:MM, UTC. At or before the start means the show ends the next day. */
  endTime: string;
  /** Left out, the agenda's default strand. */
  strandId?: string | null;
};

const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Add a show the agenda does not have (a Bosbar night, an extra), as a draft archive record in
 * PocketBase. It then appears in the "to process" list like any other show.
 */
export async function createShow(input: NewShowInput, { agenda }: Pick<ApiDeps, 'agenda'>) {
  // The record keeps the plain title: a pasted "<date> @ <strand>" suffix is not part of it.
  const title = baseTitle(input.title);
  if (!title) throw new UseCaseError('PRECONDITION_FAILED', 'A show needs a title');
  if (input.startTime === input.endTime) throw new UseCaseError('PRECONDITION_FAILED', 'A show cannot start and end at the same time');

  const strands = await agenda.listStrands();
  const strand = input.strandId ? strands.find((s) => s.id === input.strandId) : strands.find((s) => s.isDefault);
  if (input.strandId && !strand) throw new UseCaseError('NOT_FOUND', 'That strand does not exist');

  // The same night added twice makes two records for one recording; stop it here.
  const drafts = await agenda.listDrafts();
  if (drafts.some((d) => d.date === input.date && d.startTime === input.startTime && sameText(d.title, title))) {
    throw new UseCaseError('CONFLICT', 'That show is already in the list');
  }

  return agenda.createDraft({ title, date: input.date, startTime: input.startTime, endTime: input.endTime, strandId: strand?.id ?? null });
}
