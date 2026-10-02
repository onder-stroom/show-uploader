import { describe, expect, it } from 'vitest';
import { UseCaseError } from '../../src/usecases/errors';
import { createShow } from '../../src/usecases/shows';
import { fakeDeps } from '../fakes';

const input = { title: 'Bosbar Broadcast', date: '2026-09-30', startTime: '14:00', endTime: '16:00' };
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as UseCaseError);

describe('createShow', () => {
  it('creates a draft on the default strand when none is chosen', async () => {
    const deps = fakeDeps();
    await createShow(input, deps);
    expect(deps.agenda.createDraft).toHaveBeenCalledWith({ ...input, strandId: 'strand-cs' });
  });

  it('uses the chosen strand', async () => {
    const deps = fakeDeps();
    await createShow({ ...input, strandId: 'strand-bos' }, deps);
    expect(deps.agenda.createDraft).toHaveBeenCalledWith(expect.objectContaining({ strandId: 'strand-bos' }));
  });

  it('refuses a strand the agenda does not have', async () => {
    const deps = fakeDeps();
    expect((await refusal(createShow({ ...input, strandId: 'ghost' }, deps)))?.code).toBe('NOT_FOUND');
    expect(deps.agenda.createDraft).not.toHaveBeenCalled();
  });

  it('creates without a strand when the agenda has none flagged default', async () => {
    const deps = fakeDeps({ strands: [{ id: 'strand-bos', name: 'De Bosbar', isDefault: false }] });
    await createShow(input, deps);
    expect(deps.agenda.createDraft).toHaveBeenCalledWith(expect.objectContaining({ strandId: null }));
  });

  it('keeps the plain title: a pasted "<date> @ <strand>" suffix is dropped', async () => {
    const deps = fakeDeps();
    await createShow({ ...input, title: '  Bosbar Broadcast 30.09.2026 @ De Bosbar ' }, deps);
    expect(deps.agenda.createDraft).toHaveBeenCalledWith(expect.objectContaining({ title: 'Bosbar Broadcast' }));
  });

  it('refuses an empty title, and one that is only a suffix', async () => {
    const deps = fakeDeps();
    expect((await refusal(createShow({ ...input, title: '   ' }, deps)))?.code).toBe('PRECONDITION_FAILED');
    expect((await refusal(createShow({ ...input, title: '30.09.2026 @ De Bosbar' }, deps)))?.code).toBe('PRECONDITION_FAILED');
    expect(deps.agenda.createDraft).not.toHaveBeenCalled();
  });

  it('refuses a show that starts and ends at the same time, but lets one cross midnight', async () => {
    const deps = fakeDeps();
    expect((await refusal(createShow({ ...input, endTime: '14:00' }, deps)))?.code).toBe('PRECONDITION_FAILED');
    await createShow({ ...input, startTime: '23:00', endTime: '01:00' }, deps);
    expect(deps.agenda.createDraft).toHaveBeenCalledTimes(1);
  });

  it('refuses the same night added twice, comparing the title without case', async () => {
    const deps = fakeDeps({ shows: [{ id: 'show-9', title: 'bosbar broadcast', date: '2026-09-30', startTime: '14:00' }] });
    expect((await refusal(createShow(input, deps)))?.code).toBe('CONFLICT');
    expect(deps.agenda.createDraft).not.toHaveBeenCalled();
  });

  it('lets a same-titled show on another night or at another time through', async () => {
    const deps = fakeDeps({ shows: [{ id: 'show-9', title: 'Bosbar Broadcast', date: '2026-09-23', startTime: '14:00' }] });
    await createShow(input, deps);
    await createShow({ ...input, startTime: '18:00', endTime: '20:00' }, fakeDeps({ shows: [{ id: 'show-9', title: 'Bosbar Broadcast', date: '2026-09-30', startTime: '14:00' }] }));
    expect(deps.agenda.createDraft).toHaveBeenCalledTimes(1);
  });
});
