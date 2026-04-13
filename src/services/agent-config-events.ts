import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { AgentConfigSnapshot, ensureAgentConfigFile, getAgentConfigPath, readAgentConfig } from './agent-config-store';

export class AgentConfigEvents extends EventEmitter {
  private watcher: fs.FSWatcher | null = null;
  private latest: AgentConfigSnapshot | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private readonly configPath = getAgentConfigPath();
  private readonly configDir = path.dirname(this.configPath);
  private readonly configFileName = path.basename(this.configPath);

  start(): void {
    if (this.watcher) return;

    const initial = ensureAgentConfigFile();
    this.latest = initial;

    this.watcher = fs.watch(this.configDir, (_event, fileName) => {
      if (fileName && fileName.toString() !== this.configFileName) return;
      this.scheduleRefresh();
    });
  }

  stop(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.watcher?.close();
    this.watcher = null;
  }

  getLatest(): AgentConfigSnapshot | null {
    return this.latest;
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.refresh();
    }, 50);
  }

  private refresh(): void {
    const next = readAgentConfig() || ensureAgentConfigFile();
    if (!next) return;
    if (this.latest?.revision === next.revision) return;
    this.latest = next;
    this.emit('changed', next);
  }
}
