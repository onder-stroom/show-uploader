import { vi, describe, it, expect } from 'vitest';

vi.mock('../../src/env', () => ({
  env: { POCKETBASE_URL: 'https://pb.test' },
}));

import { toAgendaShow } from '../../src/services/shows-api';

const base = {
  id: 'ep1',
  title: 'Mills Boogie',
  notes: 'A Miami Bass special',
  startTime: '2026-07-17 18:00:00.000Z',
  endTime: '2026-07-17 20:00:00.000Z',
  image: '',
  genres: [] as string[],
  collectionId: 'pbc_episodes',
};

describe('toAgendaShow', () => {
  it('splits startTime/endTime into date + HH:MM', () => {
    const s = toAgendaShow(base);
    expect(s.date).toBe('2026-07-17');
    expect(s.startTime).toBe('18:00');
    expect(s.endTime).toBe('20:00');
  });

  it('maps title and notes', () => {
    const s = toAgendaShow(base);
    expect(s.title).toBe('Mills Boogie');
    expect(s.description).toBe('A Miami Bass special');
  });

  it('builds a PocketBase file URL when an image is set, else null', () => {
    expect(toAgendaShow(base).imageUrl).toBeNull();
    const withImg = toAgendaShow({ ...base, image: 'cover.jpg' });
    expect(withImg.imageUrl).toBe('https://pb.test/api/files/pbc_episodes/ep1/cover.jpg');
  });

  it('maps expanded genre names to tags, empty to null', () => {
    expect(toAgendaShow(base).tags).toBeNull();
    const withGenres = toAgendaShow({ ...base, expand: { genres: [{ name: 'house' }, { name: 'disco' }] } });
    expect(withGenres.tags).toEqual(['house', 'disco']);
  });

  it('maps the linked series blurb to showDescription, else null', () => {
    expect(toAgendaShow(base).showDescription).toBeNull();
    const withShow = toAgendaShow({ ...base, expand: { series: { description: 'weekly boogie hour' } } });
    expect(withShow.showDescription).toBe('weekly boogie hour');
    // empty string collapses to null (falsy) so the UI can fall back cleanly
    expect(toAgendaShow({ ...base, expand: { series: { description: '' } } }).showDescription).toBeNull();
  });

  it('tolerates missing optional fields', () => {
    const s = toAgendaShow({ ...base, title: undefined, notes: undefined });
    expect(s.title).toBe('');
    expect(s.description).toBe('');
  });
});
