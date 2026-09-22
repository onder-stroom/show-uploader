import { describe, it, expect } from 'vitest';
import { showSlug, uniqueSlug } from '../src/show-slug';

/**
 * Every case below is a real folder name from the production bucket. Synthetic
 * examples would not have caught the double epoch prefix, the single-digit
 * dates, or the show billed a day after it was recorded.
 */
describe('showSlug on real recordings', () => {
  const cases: [string, string][] = [
    ['1783776608000-misharog_10.07.2026__coming_soon__2026-07-10_15-52-25', '2026-07-10-misharog'],
    [
      '1784459530766-oko_stellar_invites_kin_soul_17.07.2026__coming_soon__2026-07-17_15-56-10',
      '2026-07-17-oko-stellar-invites-kin-soul',
    ],
    ['1784465055735-sawt_17.07.2026__coming_soon__2026-07-17_18-00-31', '2026-07-17-sawt'],
    ['1784493542092-marijn_ottenhof_10.07.2026__coming_soon__2026-07-10_19-59-29', '2026-07-10-marijn-ottenhof'],
    ['1784493571380-mills_17.07.2026__coming_soon__2026-07-17_18-00-31', '2026-07-17-mills'],
    ['1784493585533-elektrische_tijd_10.07.2026__coming_soon__2026-07-10_15-52-25', '2026-07-10-elektrische-tijd'],
    ['1784983694943-guy_ohm_24.07.2026__coming_soon__2026-07-24_13-40-26', '2026-07-24-guy-ohm'],
    // Trailing separators before the date must not leave a dangling dash.
    ['1785252972275-insert__24.07.2026__coming_soon__2026-07-24_13-40-26', '2026-07-24-insert'],
    ['1785252985219-odile___deena_24.07.2026__coming_soon__2026-07-24_13-40-26', '2026-07-24-odile-deena'],
    ['1785678494940-leena_31.07.2026__coming_soon__2026-07-31_18-02-44', '2026-07-31-leena'],
    ['1786167006973-mogus_b2b_boemtjak__8.8.2026__coming_soon__2026-08-07_16-29-47', '2026-08-08-mogus-b2b-boemtjak'],
    ['1786194078396-renni_8.8.2026__coming_soon__2026-08-07_16-29-47', '2026-08-08-renni'],
  ];

  it.each(cases)('%s → %s', (input, expected) => {
    expect(showSlug(input)).toBe(expected);
  });

  // No capture stamp at all, and a single-digit month.
  it('handles a name carrying only a dotted date', () => {
    expect(showSlug('1785678482962-yalla_compltere_31.7.2026')).toBe('2026-07-31-yalla-compltere');
  });

  // This recording was replaced, so it picked up a second upload prefix.
  it('strips stacked epoch prefixes', () => {
    expect(
      showSlug('1785757336716-1785677613218-radio__z_onderdak_31.07.2026__coming_soon__2026-07-31_15-59-04_1')
    ).toBe('2026-07-31-radio-z-onderdak');
  });

  // The billed date and the capture date genuinely differ — an evening show is
  // recorded the day before it airs. Filing under the billed date is the point.
  it('prefers the billed date over the capture stamp', () => {
    expect(showSlug('1786166988525-palmbomen_ii_8.8.2026__coming_soon__2026-08-07_16-29-47')).toBe(
      '2026-08-08-palmbomen-ii'
    );
  });

  it('falls back to the capture stamp when the title carries no date', () => {
    expect(showSlug('1786166988525-some_show__2026-08-07_16-29-47')).toBe('2026-08-07-some-show');
  });

  it('keeps the name when there is no date at all rather than inventing one', () => {
    expect(showSlug('1786166988525-mystery_recording')).toBe('mystery-recording');
  });

  // Re-running the rename must not re-slug an already-renamed folder.
  it('is idempotent', () => {
    const once = showSlug('1783776608000-misharog_10.07.2026__coming_soon__2026-07-10_15-52-25');
    expect(showSlug(once)).toBe(once);
  });
});

describe('uniqueSlug', () => {
  // Merging two shows into one folder would have one overwrite the other's
  // video.mp4 and audio.m4a.
  it('disambiguates a repeated slug instead of colliding', () => {
    const taken = new Set<string>();
    expect(uniqueSlug('2026-07-17-mills', taken)).toBe('2026-07-17-mills');
    expect(uniqueSlug('2026-07-17-mills', taken)).toBe('2026-07-17-mills-2');
    expect(uniqueSlug('2026-07-17-mills', taken)).toBe('2026-07-17-mills-3');
  });
});
