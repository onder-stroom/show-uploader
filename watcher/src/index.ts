// replaced in Task 9; a stub keeps `build` green until then.
import 'dotenv/config';
import { loadConfig } from './config';

const config = loadConfig();
console.log(`recordings service configured for ${config.recordingsDir}`);
