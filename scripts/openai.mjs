import { spawnSync } from 'node:child_process';

// Pass credentials through the environment, never through command arguments.
const result = spawnSync('openai', process.argv.slice(2), { stdio: 'inherit', env: process.env });
if (result.error) console.error('OpenAI CLI unavailable. Install: brew install openai/tools/openai');
process.exit(result.status ?? 1);
