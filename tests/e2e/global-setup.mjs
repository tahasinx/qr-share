import { startAll } from './servers.mjs';

export default async function globalSetup() {
  const stop = await startAll();
  return stop;
}
