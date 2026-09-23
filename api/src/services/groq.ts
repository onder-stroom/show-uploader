import Groq from 'groq-sdk';
import { env } from '../env';

const groq = new Groq({ apiKey: env.GROQ_API_KEY });

export type GeneratedMeta = {
  youtubeDescription: string;
  mixcloudDescription: string;
  tags: string[];
};

/**
 * Upload copy from what the agenda record actually says — nothing else.
 *
 * The model knows nothing about the artist, so anything it "adds" is invented:
 * it has claimed a live set was recorded in a studio and given an artist a genre
 * they don't play. Wrong copy goes out under the show's name on YouTube and
 * MixCloud, so the prompt forbids embellishment outright and the temperature is
 * low. Thin notes are supposed to produce thin copy.
 *
 * `genres` are the curated PocketBase genres — real facts, and the tag
 * vocabulary the archive already uses.
 */
export async function generateMeta(
  title: string,
  description: string,
  genres: string[] = []
): Promise<GeneratedMeta> {
  const chat = await groq.chat.completions.create({
    model: env.GROQ_MODEL,
    messages: [
      {
        role: 'system',
        content: [
          'You write copy for music show uploads.',
          'Use ONLY the facts given to you. You do not know this artist — never state anything about their style, genre, influences, equipment, guests, label or history unless it is in the text provided.',
          'Never invent where or how the recording was made: not "recorded in the studio", not "live from", not a city, venue or date.',
          'If the notes are thin, write less. One plain line is a fine answer; padding it with guesses is not.',
          'Brief, human, no hype, no filler, no buzzwords. The music is the value — the text just sets context.',
          'Never mention AI. Respond with JSON only.',
        ].join(' '),
      },
      {
        role: 'user',
        content: [
          `Show title: "${title}"`,
          `Notes from the agenda (may be empty): "${description}"`,
          genres.length
            ? `Genres on the record — these are the only genres you may name: ${genres.join(', ')}`
            : 'No genres are known for this show. Do not name any genre.',
          '',
          'Return JSON:',
          '{"youtubeDescription":"1-3 lines, only what the notes support","mixcloudDescription":"1-2 lines","tags":["5 to 8 lowercase tags, drawn from the genres above and words that actually appear in the notes or title"]}',
        ].join('\n'),
      },
    ],
    response_format: { type: 'json_object' },
    // Low: this is a rewrite of given facts, not a creative task.
    temperature: 0.2,
  });

  const raw = chat.choices[0]?.message?.content ?? '{}';
  const parsed = JSON.parse(raw) as Partial<GeneratedMeta>;

  return {
    youtubeDescription: parsed.youtubeDescription ?? title,
    mixcloudDescription: parsed.mixcloudDescription ?? title,
    // Deduped in code, not trusted to the prompt: with nothing to work from, a
    // model pads the list by repeating itself ("sips, sencho, sips, sencho").
    tags: cleanTags(parsed.tags),
  };
}

function cleanTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const seen = new Set<string>();
  for (const tag of tags) {
    if (typeof tag !== 'string') continue;
    const clean = tag.trim().toLowerCase();
    if (clean) seen.add(clean);
  }
  return [...seen].slice(0, 8);
}
