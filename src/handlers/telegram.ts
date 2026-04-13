import { Telegraf } from 'telegraf';
import { IStorage } from '../storage/interface';
import { GitHubManager } from './github';
import { DirectoryManager } from './directory';
import { MessageFormatter } from '../utils/formatter';
import { message } from 'telegraf/filters';
import { Config } from '../config/config';
import { PermissionManager } from './permission-manager';
import { AgentMessage } from '../models/agent-message';
import { AgentToolInfo, IAgentManager } from './agent-manager';
import { ApplyAgentConfigResult, applyAgentConfig } from '../services/agent-config-apply';
import { AgentConfigEvents } from '../services/agent-config-events';
import { AgentConfigSavedEvent, AgentConfigSnapshot, onAgentConfigSaved } from '../services/agent-config-store';

// Import handlers
import { CommandHandler } from './telegram/commands/command-handler';
import { CallbackHandler } from './telegram/callbacks/callback-handler';
import { MessageHandler } from './telegram/messages/message-handler';
import { ToolHandler } from './telegram/tools/tool-handler';
import { FileBrowserHandler } from './telegram/file-browser/file-browser-handler';
import { ProjectHandler } from './telegram/project/project-handler';

export class TelegramHandler {
  private bot: Telegraf;
  private github: GitHubManager;
  private directory: DirectoryManager;
  private storage: IStorage;
  private agentManager: IAgentManager;
  private formatter: MessageFormatter;
  private config: Config;
  private permissionManager: PermissionManager;
  
  // Handlers
  private commandHandler: CommandHandler;
  private callbackHandler: CallbackHandler;
  private messageHandler: MessageHandler;
  private toolHandler: ToolHandler;
  private fileBrowserHandler: FileBrowserHandler;
  private projectHandler: ProjectHandler;
  private agentConfigEvents: AgentConfigEvents;
  private latestAgentConfig: AgentConfigSnapshot | null = null;
  private lastAnnouncedRevisionByChat: Map<number, string> = new Map();
  private pendingAckByRevision: Map<string, Set<number>> = new Map();
  private disposeAgentConfigSavedListener: (() => void) | null = null;

  constructor(
    bot: Telegraf,
    github: GitHubManager,
    directory: DirectoryManager,
    agentManager: IAgentManager,
    storage: IStorage,
    formatter: MessageFormatter,
    config: Config,
    permissionManager: PermissionManager
  ) {
    this.bot = bot;
    this.github = github;
    this.directory = directory;
    this.storage = storage;
    this.agentManager = agentManager;
    this.formatter = formatter;
    this.config = config;
    this.permissionManager = permissionManager;
    this.agentConfigEvents = new AgentConfigEvents();
    this.disposeAgentConfigSavedListener = onAgentConfigSaved((event: AgentConfigSavedEvent) => {
      this.handleAgentConfigSaved(event);
    });
    this.agentConfigEvents.on('changed', (snapshot: AgentConfigSnapshot) => {
      this.latestAgentConfig = snapshot;
      void this.applySnapshot(snapshot)
        .then(() => this.applyPendingAcks(snapshot))
        .catch((error) => console.error('[AgentConfig] Error applying changed snapshot:', error));
    });
    this.agentConfigEvents.start();
    this.latestAgentConfig = this.agentConfigEvents.getLatest();
    if (this.latestAgentConfig) {
      void this.applySnapshot(this.latestAgentConfig)
        .then(() => this.applyPendingAcks(this.latestAgentConfig!))
        .catch((error) => console.error('[AgentConfig] Error applying initial snapshot:', error));
    }

    // Initialize handlers
    this.commandHandler = new CommandHandler(this.storage, this.formatter, this.agentManager, this.config, this.bot);
    this.projectHandler = new ProjectHandler(this.storage, this.github, this.directory, this.formatter, this.bot);
    this.toolHandler = new ToolHandler(this.storage, this.formatter, this.config, this.bot, this.agentManager);
    this.fileBrowserHandler = new FileBrowserHandler(this.storage, this.directory, this.formatter, this.config, this.bot);
    this.messageHandler = new MessageHandler(this.storage, this.github, this.formatter, this.agentManager, this.projectHandler, this.bot, this.config, this.fileBrowserHandler);
    this.callbackHandler = new CallbackHandler(this.formatter, this.projectHandler, this.storage, this.fileBrowserHandler, this.bot, this.permissionManager, this.agentManager, this.config, this.commandHandler);


    this.setupHandlers();
  }

  public async handleAgentResponse(userId: string, message: AgentMessage | null, toolInfo?: AgentToolInfo, parentToolUseId?: string): Promise<void> {
    const chatId = parseInt(userId);
    if (isNaN(chatId)) return;

    // If message is null, this indicates completion
    if (!message) {
      return;
    }

    await this.handleAgentMessage(chatId, message, toolInfo, parentToolUseId);
  }

  public async handleAgentError(userId: string, error: string): Promise<void> {
    const chatId = parseInt(userId);
    if (isNaN(chatId)) return;

    try {
      await this.bot.telegram.sendMessage(
        chatId,
        this.formatter.formatError(`Agent Error: ${error}`),
        { parse_mode: 'MarkdownV2' }
      );
    } catch (error) {
      console.error('Error sending error message:', error);
    }
  }


  private setupHandlers(): void {
    this.bot.use(async (ctx, next) => {
      await this.syncAgentConfigForChat(ctx.chat?.id);
      await next();
    });

    // Command handlers
    this.bot.start((ctx) => this.commandHandler.handleStart(ctx));
    this.bot.command('createproject', (ctx) => this.commandHandler.handleCreateProject(ctx));
    this.bot.command('listproject', (ctx) => this.commandHandler.handleListProject(ctx));
    this.bot.command('exitproject', (ctx) => this.commandHandler.handleExitProject(ctx));

    this.bot.command('help', (ctx) => this.commandHandler.handleHelp(ctx));
    this.bot.command('ls', (ctx) => this.fileBrowserHandler.handleLsCommand(ctx));
    this.bot.command('auth', (ctx) => this.commandHandler.handleAuth(ctx));

    // Model selection command
    this.bot.command('agentconfig', (ctx) => this.commandHandler.handleAgent(ctx));

    // Onboarding reset command
    this.bot.command('resetonboarding', (ctx) => this.commandHandler.handleResetOnboarding(ctx));

    // Text message handler
    this.bot.on(message('text'), (ctx) => this.messageHandler.handleTextMessage(ctx));

    // Photo message handler
    this.bot.on(message('photo'), (ctx) => this.messageHandler.handlePhotoMessage(ctx));

    // Voice message handler
    this.bot.on(message('voice'), (ctx) => this.messageHandler.handleVoiceMessage(ctx));

    this.bot.on('callback_query', (ctx) => this.callbackHandler.handleCallback(ctx));
  }

  public async handleAgentMessage(chatId: number, message: AgentMessage, toolInfo?: AgentToolInfo, parentToolUseId?: string): Promise<void> {
    const user = await this.storage.getUserSession(chatId);
    if (!user || !user.sessionId) return;

    if (toolInfo) {
      if (toolInfo.isToolUse) {
        await this.toolHandler.handleToolUse(chatId, message, toolInfo, user, parentToolUseId);
        return;
      }
      if (toolInfo.isToolResult) {
        await this.toolHandler.handleToolResult(chatId, message, toolInfo, user, parentToolUseId);
        return;
      }
    }

    await this.messageHandler.handleRegularMessage(chatId, message, user.permissionMode);
  }

  public async cleanup(): Promise<void> {
    try {
      this.agentConfigEvents.stop();
      this.disposeAgentConfigSavedListener?.();
      this.disposeAgentConfigSavedListener = null;
      console.log('TelegramHandler cleanup completed');
    } catch (error) {
      console.error('Error during cleanup:', error);
    }
  }

  private async applySnapshot(snapshot: AgentConfigSnapshot, chatId?: number): Promise<void> {
    const result = await this.applySnapshotToChat(snapshot, chatId);
    if (!result) return;

    if (!result.success) {
      console.error(`[AgentConfig] Failed to apply snapshot: ${result.reason || 'unknown reason'}`);
      return;
    }

    if (!chatId) return;

    if (result.appliedToChat && !result.unchanged) {
      await this.sendAppliedMessage(chatId, snapshot, result, 'auto');
    }
  }

  private async applySnapshotToChat(
    snapshot: AgentConfigSnapshot,
    chatId?: number,
    abortRunningQuery = false
  ): Promise<ApplyAgentConfigResult | null> {
    const result = await applyAgentConfig({
      snapshot,
      config: this.config,
      agentManager: this.agentManager,
      storage: this.storage,
      ...(typeof chatId === 'number' ? { chatId } : {}),
      abortRunningQuery,
    });

    return result;
  }

  private async syncAgentConfigForChat(chatId?: number): Promise<void> {
    if (!chatId || !this.latestAgentConfig) return;

    const revision = this.latestAgentConfig.revision;
    const result = await this.applySnapshotToChat(this.latestAgentConfig, chatId, false);
    if (!result) return;

    if (!result.success) {
      console.error(`[AgentConfig] Failed to sync chat ${chatId}: ${result.reason || 'unknown reason'}`);
      return;
    }

    if (!result.appliedToChat || result.unchanged) {
      return;
    }

    if (this.lastAnnouncedRevisionByChat.get(chatId) === revision) return;
    await this.sendAppliedMessage(chatId, this.latestAgentConfig, result, 'auto');
  }

  private handleAgentConfigSaved(event: AgentConfigSavedEvent): void {
    if (event.origin !== 'chat') return;
    if (typeof event.chatId !== 'number') return;
    this.latestAgentConfig = event.snapshot;
    this.registerPendingAck(event.snapshot.revision, event.chatId);
    void this.applySnapshot(event.snapshot)
      .then(() => this.applyPendingAcks(event.snapshot))
      .catch((error) => console.error('[AgentConfig] Error applying chat-saved snapshot:', error));
  }

  private registerPendingAck(revision: string, chatId: number): void {
    const existing = this.pendingAckByRevision.get(revision);
    if (existing) {
      existing.add(chatId);
    } else {
      this.pendingAckByRevision.set(revision, new Set([chatId]));
    }
  }

  private async applyPendingAcks(snapshot: AgentConfigSnapshot): Promise<void> {
    const pendingChats = this.pendingAckByRevision.get(snapshot.revision);
    if (!pendingChats || pendingChats.size === 0) return;

    this.pendingAckByRevision.delete(snapshot.revision);
    for (const chatId of pendingChats) {
      const result = await this.applySnapshotToChat(snapshot, chatId, true);
      if (!result || !result.success) {
        console.error(`[AgentConfig] Failed pending apply for chat ${chatId}: ${result?.reason || 'unknown reason'}`);
        continue;
      }
      if (!result.appliedToChat) {
        continue;
      }
      await this.sendAppliedMessage(chatId, snapshot, result, 'saved');
    }
  }

  private async sendAppliedMessage(
    chatId: number,
    snapshot: AgentConfigSnapshot,
    result: ApplyAgentConfigResult,
    mode: 'auto' | 'saved'
  ): Promise<void> {
    const revision = snapshot.revision;
    const alreadyActive = result.unchanged;
    const sessionNote = result.sessionReset ? '\n🧹 Existing provider session was reset.' : '';
    const abortNote = result.queryAborted ? '\n🛑 Current query was stopped.' : '';
    const headline = mode === 'saved'
      ? (alreadyActive ? '✅ Agent config already active' : '✅ Agent config applied')
      : '🔄 Agent config applied';

    await this.bot.telegram.sendMessage(
      chatId,
      `${headline}: **${snapshot.provider} - ${result.modelDisplayName}**${sessionNote}${abortNote}`,
      { parse_mode: 'Markdown' }
    );
    this.lastAnnouncedRevisionByChat.set(chatId, revision);
  }
}
