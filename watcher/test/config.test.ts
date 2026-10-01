import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config';

const base = { RECORDINGS_DIR: 'C:/Users/koray/Videos/OBS recordings', AGENT_TOKEN: 'x'.repeat(24) };

describe('loadConfig', () => {
  it('applies safe defaults: loopback only, track 1 is the mix', () => {
    const c = loadConfig(base);
    expect(c.listenHost).toBe('127.0.0.1');
    expect(c.listenPort).toBe(8787);
    expect(c.mixAudioStream).toBe(0);
    expect(c.retentionDays).toBe(14);
    expect(c.tools).toEqual({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' });
  });

  it('keeps derived files in a hidden folder inside the recordings folder by default', () => {
    expect(loadConfig(base).workDir.replace(/\\/g, '/')).toBe('C:/Users/koray/Videos/OBS recordings/.show-uploader');
  });

  it('refuses a missing or short token, because the service serves video', () => {
    expect(() => loadConfig({ RECORDINGS_DIR: 'x' })).toThrow();
    expect(() => loadConfig({ ...base, AGENT_TOKEN: 'short' })).toThrow(/16/);
  });
});
