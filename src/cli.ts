import { DesktopObserver } from './observer';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('npm run tui -- [--probe] [--duration=5000]\nRead-only Codex desktop monitor. Node 24+.\n--probe: metadata-only connection and status report; exits after duration.');
} else {
  const probe = args.includes('--probe');
  if (!probe && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    console.error('The dashboard needs an interactive terminal. Use npm run probe for a connection report.');
    process.exitCode = 1;
  } else {
    const observer = new DesktopObserver();
    const stop = () => observer.stop();
    if (probe) {
      process.once('SIGINT', () => { stop(); process.exit(0); });
      process.once('SIGTERM', () => { stop(); process.exit(0); });
      const duration = Number(args.find(a => a.startsWith('--duration='))?.split('=')[1] || 5000);
      if (!Number.isFinite(duration) || duration < 100 || duration > 60000) throw new Error('Duration must be 100–60000 ms');
      let updates = 0;
      observer.on('update', () => updates++);
      observer.start();
      setTimeout(() => {
        stop();
        const agents = observer.agents;
        console.log(JSON.stringify({ health: observer.health, discovered: agents.length,
          live: agents.filter(a => a.evidence === 'live').length, updates,
          statuses: Object.fromEntries(['WORKING', 'WAITING', 'IDLE', 'DONE', 'ERROR', 'UNKNOWN'].map(s => [s, agents.filter(a => a.runtime === s).length])),
          // No titles, directories, prompts, responses or request payloads in diagnostics.
          observed: agents.filter(a => a.evidence === 'live').map(a => ({ id: a.externalId, status: a.runtime, awaitingInput: a.awaitingInput })),
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
