import { readFileSync, writeFileSync, existsSync } from 'fs';

const LOG_FILE = '/tmp/campaign-member-logs.json';

export function readLogs() {
  try {
    if (existsSync(LOG_FILE)) {
      const data = readFileSync(LOG_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error('Error reading logs:', e.message);
  }
  return [];
}

export function appendLog(entry) {
  const logs = readLogs();
  logs.unshift(entry); // newest first
  // Keep last 100 entries
  const trimmed = logs.slice(0, 100);
  writeFileSync(LOG_FILE, JSON.stringify(trimmed, null, 2));
  return trimmed;
}
