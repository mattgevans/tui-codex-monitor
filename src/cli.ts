import { MonitorObserver } from './monitor-observer';
import { statusSnapshot } from './snapshot';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('npm run tui -- [--json | --probe] [--session ID] [--duration=5000]\nRead-only Codex and Claude Code session monitor. Node 24+.\nAll supported providers are discovered automatically on every launch.\n--json: current session status as JSON; exits after duration.\n--session ID: filter JSON output to an exact native or provider-prefixed session ID (also --session=ID); exits nonzero if not found.\n--probe: metadata-only connection and status report; exits after duration.');
} else {
  const probe = args.includes('--probe');
  const json = args.includes('--json');
  if (args.some(arg => arg === '--provider' || arg.startsWith('--provider=')))
    throw new Error('Provider selection was removed; all supported providers are discovered automatically. Run npm run tui.');
  const sessionArgs = args.filter(arg => arg === '--session' || arg.startsWith('--session='));
  if (sessionArgs.length > 1) throw new Error('Use --session only once');
  const sessionArg = sessionArgs[0];
  const sessionId = sessionArg === '--session' ? args[args.indexOf(sessionArg) + 1] : sessionArg?.slice('--session='.length);
  if (sessionArg && (!sessionId || sessionId.startsWith('--'))) throw new Error('--session requires a session ID');
  if (sessionArg && !json) throw new Error('--session requires --json');
  if (probe && json) throw new Error('Use either --json or --probe, not both');
  if (!probe && !json && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    console.error('The dashboard needs an interactive terminal. Use npm run tui -- --json for current status or npm run probe for a connection report.');
    process.exitCode = 1;
  } else {
    const observer = new MonitorObserver();
    const stop = () => observer.stop();
    if (probe || json) {
      process.once('SIGINT', () => { stop(); process.exit(0); });
      process.once('SIGTERM', () => { stop(); process.exit(0); });
      const duration = Number(args.find(a => a.startsWith('--duration='))?.split('=')[1] || 5000);
      if (!Number.isFinite(duration) || duration < 100 || duration > 60000) throw new Error('Duration must be 100–60000 ms');
      let updates = 0;
      observer.on('update', () => updates++);
      observer.start();
      setTimeout(() => {
        if (json) {
          try {
            const agents = sessionId ? observer.agents.filter(agent => agent.externalId === sessionId || agent.id === sessionId) : observer.agents;
            console.log(JSON.stringify(statusSnapshot({ agents, health: observer.health }), null, 2));
            if (observer.health.state === 'degraded' || (sessionId && agents.length === 0)) process.exitCode = 1;
          } catch (error) {
            console.error(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
          } finally {
            stop();
          }
          return;
        }
        stop();
        const agents = observer.agents;
        console.log(JSON.stringify({ health: observer.health, discovered: agents.length,
          live: agents.filter(a => a.evidence === 'live').length, updates,
          statuses: Object.fromEntries(['WORKING', 'WAITING', 'IDLE', 'DONE', 'ERROR', 'EXITED', 'UNKNOWN'].map(s => [s, agents.filter(a => a.runtime === s).length])),
          // No titles, directories, prompts, responses or request payloads in diagnostics.
          observed: agents.filter(a => a.evidence === 'live').map(a => ({ id: a.externalId, provider: a.provider, status: a.runtime, awaitingInput: a.awaitingInput })),
        }, null, 2));
        if (observer.health.state !== 'live' || !agents.some(a => a.evidence === 'live')) process.exitCode = 1;
      }, duration);
    } else {
      const { dashboard } = await import('./ui');
      dashboard(observer);
      observer.start();
    }
  }
}
