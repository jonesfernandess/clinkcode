import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import {
  AgentModel,
  AgentProvider,
  DEFAULT_PROVIDER,
  getDefaultModelForProvider,
  resolveModelForProvider,
} from '../models/types';

const CLINK_CONFIG_DIR = path.join(os.homedir(), '.clinkcode');
const CLI_CONFIG_PATH = path.join(CLINK_CONFIG_DIR, 'config.json');
const LEGACY_AGENT_CONFIG_PATH = path.join(CLINK_CONFIG_DIR, 'agent-config.json');

export interface AgentConfigSnapshot {
  provider: AgentProvider;
  model: AgentModel;
  revision: string;
}

export interface AgentConfigInput {
  provider: AgentProvider;
  model: AgentModel;
}

export type AgentConfigChangeOrigin = 'chat' | 'cli' | 'system';

export interface SaveAgentConfigOptions {
  origin?: AgentConfigChangeOrigin;
  chatId?: number;
}

export interface AgentConfigSavedEvent {
  snapshot: AgentConfigSnapshot;
  origin: AgentConfigChangeOrigin;
  chatId?: number;
}

interface ConfigJsonShape {
  agentProvider?: unknown;
  agentModel?: unknown;
  // Legacy keys from previous single-purpose file
  provider?: unknown;
  model?: unknown;
  [key: string]: unknown;
}

const savedEvents = new EventEmitter();

export function getAgentConfigPath(): string {
  return CLI_CONFIG_PATH;
}

export function ensureAgentConfigFile(): AgentConfigSnapshot {
  const existing = readAgentConfigFromDisk(CLI_CONFIG_PATH);
  if (existing) {
    if (existing.needsRewrite) {
      return saveAgentConfig(existing.normalized, { origin: 'system' });
    }
    return existing.snapshot;
  }

  const legacy = readAgentConfigFromDisk(LEGACY_AGENT_CONFIG_PATH);
  if (legacy) {
    return saveAgentConfig(legacy.normalized, { origin: 'system' });
  }

  if (fs.existsSync(CLI_CONFIG_PATH)) {
    return saveAgentConfig(getDefaultAgentConfig(), { origin: 'system' });
  }

  const seeded = seedAgentConfigFromEnv();
  return saveAgentConfig(seeded, { origin: 'system' });
}

export function readAgentConfig(): AgentConfigSnapshot | null {
  const existing = readAgentConfigFromDisk(CLI_CONFIG_PATH);
  if (existing) {
    if (existing.needsRewrite) {
      return saveAgentConfig(existing.normalized, { origin: 'system' });
    }
    return existing.snapshot;
  }

  if (fs.existsSync(CLI_CONFIG_PATH)) {
    return saveAgentConfig(getDefaultAgentConfig(), { origin: 'system' });
  }

  return null;
}

export function saveAgentConfig(input: AgentConfigInput, options?: SaveAgentConfigOptions): AgentConfigSnapshot {
  const normalized = normalizeAgentConfig(input);

  fs.mkdirSync(CLINK_CONFIG_DIR, { recursive: true });
  const currentConfig = readConfigJson(CLI_CONFIG_PATH) || {};
  currentConfig.agentProvider = normalized.provider;
  currentConfig.agentModel = normalized.model;
  delete currentConfig.provider;
  delete currentConfig.model;

  const tempPath = `${CLI_CONFIG_PATH}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(currentConfig, null, 2)}\n`, 'utf-8');
  fs.renameSync(tempPath, CLI_CONFIG_PATH);

  const stats = fs.statSync(CLI_CONFIG_PATH);
  const snapshot: AgentConfigSnapshot = {
    ...normalized,
    revision: buildRevision(stats.mtimeMs, normalized.provider, normalized.model),
  };

  const event: AgentConfigSavedEvent = {
    snapshot,
    origin: options?.origin || 'system',
  };
  if (typeof options?.chatId === 'number') {
    event.chatId = options.chatId;
  }
  savedEvents.emit('saved', event);

  return snapshot;
}

export function onAgentConfigSaved(listener: (event: AgentConfigSavedEvent) => void): () => void {
  savedEvents.on('saved', listener);
  return () => savedEvents.off('saved', listener);
}

interface ReadAgentConfigDiskResult {
  snapshot: AgentConfigSnapshot;
  normalized: AgentConfigInput;
  needsRewrite: boolean;
}

function readAgentConfigFromDisk(filePath: string): ReadAgentConfigDiskResult | null {
  try {
    const stats = fs.statSync(filePath);
    const parsed = readConfigJson(filePath);
    if (!parsed) return null;

    const rawProvider = (parsed.agentProvider ?? parsed.provider) as AgentProvider | undefined;
    const rawModel = (parsed.agentModel ?? parsed.model) as AgentModel | undefined;
    const provider = rawProvider || DEFAULT_PROVIDER;
    const model = (rawModel || '') as AgentModel;

    const normalized = normalizeAgentConfig({ provider, model });
    const snapshot: AgentConfigSnapshot = {
      ...normalized,
      revision: buildRevision(stats.mtimeMs, normalized.provider, normalized.model),
    };

    const hasLegacyKeys = 'provider' in parsed || 'model' in parsed;
    const needsRewrite = parsed.agentProvider !== normalized.provider
      || parsed.agentModel !== normalized.model
      || hasLegacyKeys;
    return { snapshot, normalized, needsRewrite };
  } catch {
    return null;
  }
}

function readConfigJson(filePath: string): ConfigJsonShape | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as ConfigJsonShape;
  } catch {
    return null;
  }
}

function normalizeAgentConfig(input: AgentConfigInput): AgentConfigInput {
  const provider = input.provider === 'claude' || input.provider === 'codex'
    ? input.provider
    : DEFAULT_PROVIDER;
  const model = resolveModelForProvider(provider, input.model);
  return { provider, model };
}

function seedAgentConfigFromEnv(): AgentConfigInput {
  const envProvider = process.env.AGENT_PROVIDER;
  const provider: AgentProvider = envProvider === 'claude' || envProvider === 'codex'
    ? envProvider
    : DEFAULT_PROVIDER;

  const envModel = process.env.AGENT_MODEL as AgentModel | undefined;
  const model = envModel
    ? resolveModelForProvider(provider, envModel)
    : getDefaultModelForProvider(provider);

  return { provider, model };
}

function getDefaultAgentConfig(): AgentConfigInput {
  const provider = DEFAULT_PROVIDER;
  return {
    provider,
    model: getDefaultModelForProvider(provider),
  };
}

function buildRevision(mtimeMs: number, provider: AgentProvider, model: AgentModel): string {
  return `${mtimeMs}:${provider}:${model}`;
}
