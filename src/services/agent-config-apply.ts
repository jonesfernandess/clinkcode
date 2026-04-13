import { Config } from '../config/config';
import { IAgentManager } from '../handlers/agent-manager';
import { getModelsForProvider } from '../models/types';
import { IStorage } from '../storage/interface';
import { AgentConfigSnapshot } from './agent-config-store';

export interface ApplyAgentConfigOptions {
  snapshot: AgentConfigSnapshot;
  config: Config;
  agentManager: IAgentManager;
  storage: IStorage;
  chatId?: number;
  abortRunningQuery?: boolean;
}

export interface ApplyAgentConfigResult {
  success: boolean;
  reason?: 'provider_switch_unsupported';
  providerChanged: boolean;
  modelChanged: boolean;
  sessionReset: boolean;
  queryAborted: boolean;
  appliedToChat: boolean;
  unchanged: boolean;
  modelDisplayName: string;
}

export async function applyAgentConfig(options: ApplyAgentConfigOptions): Promise<ApplyAgentConfigResult> {
  const {
    snapshot,
    config,
    agentManager,
    storage,
    chatId,
    abortRunningQuery = false,
  } = options;

  let providerChanged = false;
  if (agentManager.provider !== snapshot.provider) {
    if (!agentManager.setProvider) {
      return {
        success: false,
        reason: 'provider_switch_unsupported',
        providerChanged: true,
        modelChanged: false,
        sessionReset: false,
        queryAborted: false,
        appliedToChat: false,
        unchanged: true,
        modelDisplayName: snapshot.model,
      };
    }

    await agentManager.setProvider(snapshot.provider);
    providerChanged = true;
  }

  config.agent.provider = snapshot.provider;
  config.agent.defaultModel = snapshot.model;

  const modelInfo = getModelsForProvider(snapshot.provider).find((model) => model.value === snapshot.model);
  const modelDisplayName = modelInfo?.displayName || snapshot.model;

  if (!chatId) {
    return {
      success: true,
      providerChanged,
      modelChanged: false,
      sessionReset: false,
      queryAborted: false,
      appliedToChat: false,
      unchanged: !providerChanged,
      modelDisplayName,
    };
  }

  const user = await storage.getUserSession(chatId);
  if (!user) {
    return {
      success: true,
      providerChanged,
      modelChanged: false,
      sessionReset: false,
      queryAborted: false,
      appliedToChat: false,
      unchanged: !providerChanged,
      modelDisplayName,
    };
  }

  let queryAborted = false;
  if (abortRunningQuery && agentManager.isQueryRunning(chatId)) {
    queryAborted = await agentManager.abortQuery(chatId);
  }

  const modelChanged = user.currentModel !== snapshot.model || !user.hasSelectedModel;
  let sessionReset = false;

  if (providerChanged && user.sessionId) {
    delete user.sessionId;
    sessionReset = true;
  }

  if (modelChanged) {
    user.setModel(snapshot.model);
  }

  if (providerChanged || modelChanged || sessionReset) {
    await storage.saveUserSession(user);
  }

  return {
    success: true,
    providerChanged,
    modelChanged,
    sessionReset,
    queryAborted,
    appliedToChat: true,
    unchanged: !(providerChanged || modelChanged || sessionReset),
    modelDisplayName,
  };
}

