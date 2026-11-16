import { EventEmitter } from 'node:events';
import { DesktopObserver } from './observer';
import { ClaudeObserver } from './claude-observer';
import type { Agent } from './model';
import type { ProviderHealth } from './shared/types';

export interface MonitorHealth {
  provider?: ProviderHealth['provider'];
  state: ProviderHealth['state'];
  message: string;
  lastObservedAt: number | null;
  providers?: ProviderHealth[];
}

export interface SessionObserver extends EventEmitter {
  agents: Agent[];
  health: MonitorHealth;
  start(): void;
  stop(): void;
}

interface ProviderObserver extends SessionObserver { health: ProviderHealth }

/** Providers retain separate identities and health; either may run on its own. */
export class MonitorObserver extends EventEmitter implements SessionObserver {
  agents: Agent[] = [];
  health: MonitorHealth = { state: 'connecting', message: 'Connecting to session providers', lastObservedAt: null };
  private started = false;
  constructor(readonly providers: ProviderObserver[] = [new DesktopObserver(), new ClaudeObserver()]) {
    super();
  }
  private update = () => {
    this.agents = this.providers.flatMap(provider => provider.agents);
    const health = this.providers.map(provider => ({ ...provider.health }));
    // A missing Codex catalog is normal on Claude-only machines. Other catalog errors remain failures.
    const relevant = health.length === 1 ? health : health.filter(provider => provider.available !== false);
    const state = relevant.some(provider => provider.state === 'degraded') ? 'degraded' :
      relevant.some(provider => provider.state === 'live') ? 'live' :
      relevant.some(provider => provider.state === 'connecting') ? 'connecting' : 'offline';
    this.health = { state, message: health.map(provider => `${provider.provider}: ${provider.message}`).join(' · '),
      lastObservedAt: Math.max(0, ...health.map(provider => provider.lastObservedAt ?? 0)) || null, providers: health };
    this.emit('update');
  };
  start() {
    if (this.started) return;
    this.started = true;
    for (const provider of this.providers) provider.on('update', this.update);
    for (const provider of this.providers) provider.start();
    this.update();
  }
  stop() {
    for (const provider of this.providers) { provider.off('update', this.update); provider.stop(); }
    this.started = false;
  }
}
