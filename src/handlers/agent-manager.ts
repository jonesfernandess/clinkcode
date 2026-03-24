import { AgentMessage } from '../models/agent-message';

export interface AgentToolInfo {
  toolId: string;
  toolName: string;
  isToolUse: boolean;
  isToolResult: boolean;
}

export interface AgentCallbacks {
  onClaudeResponse: (userId: string, message: AgentMessage | null, toolInfo?: AgentToolInfo, parentToolUseId?: string) => Promise<void>;
  onClaudeError: (userId: string, error: string) => void;
}

export interface IAgentManager {
  addMessageToStream(chatId: number, prompt: string): Promise<void>;
  addImageMessageToStream(chatId: number, base64Data: string, mediaType: string, caption?: string): Promise<void>;
  abortQuery(chatId: number): Promise<boolean>;
  isQueryRunning(chatId: number): boolean;
  shutdown(): Promise<void>;
}

