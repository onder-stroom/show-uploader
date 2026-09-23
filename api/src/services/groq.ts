import Groq from 'groq-sdk';
import { env } from '../env';

const groq = new Groq({ apiKey: env.GROQ_API_KEY });

export type GeneratedMeta = {
  youtubeDescription: string;
  mixcloudDescription: string;
  tags: string[];
};

export async function generateMeta(
  title: string,
  description: string
): Promise<GeneratedMeta> {
  const chat = await groq.chat.completions.create({
    model: env.GROQ_MODEL,
    messages: [
      {
        role: 'system',
        content:
          'You write copy for music show uploads. Rules: brief, human, no hype, no filler, no buzzwords. The music is the value — the text just sets context. Never mention AI. Respond with JSON only.',
      },
      {
        role: 'user',
        content: `Show: "${title}"\nNotes: "${description}"\n\nReturn JSON:\n{"youtubeDescription":"2-3 lines max","mixcloudDescription":"1-2 lines max","tags":["5 to 8 lowercase tags"]}`,
      },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.4,
  });

  const raw = chat.choices[0]?.message?.content ?? '{}';
  const parsed = JSON.parse(raw) as Partial<GeneratedMeta>;

  return {
    youtubeDescription: parsed.youtubeDescription ?? title,
    mixcloudDescription: parsed.mixcloudDescription ?? title,
    tags: Array.isArray(parsed.tags) ? parsed.tags : [],
  };
}
