// Every source (BlueDot, Pylon, email, Teams, Google Chat) hands back conversations in this one
// shape. Adding a source = writing one function that returns these.

export interface Conversation {
  source: "bluedot" | "pylon" | "email" | "teams" | "google_chat" | "slack";
  sourceId: string;
  title: string;
  occurredAt: string; // ISO
  participants: { name?: string; email?: string }[];
  url: string | null;
  /** Full readable text: speaker-labelled transcript with [mm:ss] stamps, or the message log. */
  rawText: string;
  rawJson?: unknown;
  /** When the source already knows the account (e.g. a Pylon issue), its domains, used for matching. */
  accountDomains?: string[];
}

/**
 * One message in a chat or email thread. Chat-like sources return messages instead of whole
 * conversations: the engine stores each message once and only reads what's new.
 */
export interface ChatMessage {
  source: "pylon" | "email" | "teams" | "google_chat" | "slack";
  threadId: string;
  threadTitle: string;
  threadUrl: string | null;
  messageId: string;
  sentAt: string; // ISO
  author: { name?: string; email?: string };
  text: string;
  accountDomains?: string[];
}

export interface SourceBatch {
  /** Finished, one-shot conversations (calls). */
  conversations: Conversation[];
  /** Individual chat / email messages (deduped by the engine). */
  messages: ChatMessage[];
}

/**
 * Stores chat messages right away. Chat sources call it before saving a cursor, so a run that
 * gets cut off keeps what it already read instead of moving the cursor past unsaved messages.
 */
export type SaveMessages = (messages: ChatMessage[]) => Promise<void>;

export interface Source {
  name: Conversation["source"];
  /** True when the source is set up; unconfigured sources are skipped, not errors. */
  enabled(): Promise<boolean>;
  /**
   * Conversations that happened in [since, until). `known` holds source ids already archived,
   * so a source can skip the expensive per-item fetch for them. A source should leave out
   * items that aren't ready yet (e.g. a call still transcribing); the overlapping window picks
   * them up on a later tick.
   */
  fetch(since: Date, until: Date, known: Set<string>, save: SaveMessages): Promise<SourceBatch>;
}
