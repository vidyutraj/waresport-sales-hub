/** Shared entry-point preamble for CLI scripts: load .env.local, then .env. */
import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(process.cwd(), '.env.local'), quiet: true });
config({ path: resolve(process.cwd(), '.env'), quiet: true });
