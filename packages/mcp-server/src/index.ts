import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ---- Types (duplicated from backend for standalone MCP server) ----
interface Card {
  suit: "♠" | "♥" | "♦" | "♣";
  rank: string;
  value: number;
}

interface GameState {
  sessionId: string;
  phase: "waiting" | "preflop" | "flop" | "turn" | "river" | "showdown";
  deck: Card[];
  playerHand: Card[];
  opponentHand: Card[];
  communityCards: Card[];
  pot: number;
  playerStack: number;
  opponentStack: number;
  currentBet: number;
  lastAction: string;
  winner: string | null;
  updatedAt: string;
}

// ---- Supabase / fallback ----
const supabaseUrl = process.env.SUPABASE_URL ?? "";
const supabaseKey = process.env.SUPABASE_ANON_KEY ?? "";
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;
const memoryStore = new Map<string, GameState>();

async function saveState(state: GameState): Promise<void> {
  memoryStore.set(state.sessionId, state);
  if (!supabase) return;
  await supabase.from("games").upsert({
    session_id: state.sessionId,
    state,
    updated_at: new Date().toISOString(),
  });
}

async function loadState(sessionId: string): Promise<GameState | null> {
  if (supabase) {
    const { data } = await supabase
      .from("games")
      .select("state")
      .eq("session_id", sessionId)
      .single();
    if (data) return data.state as GameState;
  }
  return memoryStore.get(sessionId) ?? null;
}

// ---- Deck helpers ----
function createDeck(): Card[] {
  const suits: Card["suit"][] = ["♠", "♥", "♦", "♣"];
  const ranks = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
  const values = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
  const deck: Card[] = [];
  for (const suit of suits) {
    for (let i = 0; i < ranks.length; i++) {
      deck.push({ suit, rank: ranks[i], value: values[i] });
    }
  }
  return deck;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function formatCard(card: Card): string {
  return `${card.rank}${card.suit}`;
}

function formatState(state: GameState): string {
  const hand = state.playerHand.map(formatCard).join(" ");
  const community = state.communityCards.map(formatCard).join(" ") || "(none yet)";
  return [
    `🎰 **Voice Poker** — Session: ${state.sessionId}`,
    `Phase: ${state.phase.toUpperCase()}`,
    ``,
    `Your hand: ${hand}`,
    `Community cards: ${community}`,
    ``,
    `Pot: $${state.pot} | Your stack: $${state.playerStack} | Opponent stack: $${state.opponentStack}`,
    `Current bet: $${state.currentBet}`,
    ``,
    `Last action: ${state.lastAction}`,
    state.winner ? `🏆 Winner: ${state.winner === "player" ? "YOU!" : "Opponent"}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// ---- MCP Server ----
const server = new McpServer({
  name: "voice-poker",
  version: "0.1.0",
});

// Tool: poker_new_game
server.registerTool(
  "poker_new_game",
  {
    description:
      "Start a new Texas Hold'em poker game. Shuffles the deck, deals 2 cards to the player and 2 to the opponent, and sets up blinds. Returns the initial game state.",
    inputSchema: {
      sessionId: z
        .string()
        .optional()
        .describe("Optional session ID. If omitted, a new ID is generated."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  async ({ sessionId }) => {
    const id = sessionId ?? `game-${Date.now()}`;
    const deck = shuffle(createDeck());
    const state: GameState = {
      sessionId: id,
      phase: "preflop",
      deck: deck.slice(4),
      playerHand: [deck[0], deck[1]],
      opponentHand: [deck[2], deck[3]],
      communityCards: [],
      pot: 30,
      playerStack: 985,
      opponentStack: 985,
      currentBet: 15,
      lastAction: "Game started! Small blind $15, Big blind $30. Your turn.",
      winner: null,
      updatedAt: new Date().toISOString(),
    };
    await saveState(state);
    return { content: [{ type: "text", text: formatState(state) }] };
  }
);

// Tool: poker_get_state
server.registerTool(
  "poker_get_state",
  {
    description: "Get the current state of an ongoing poker game including hand, community cards, pot size, and available actions.",
    inputSchema: {
      sessionId: z.string().describe("The game session ID returned by poker_new_game."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ sessionId }) => {
    const state = await loadState(sessionId);
    if (!state) {
      return {
        content: [{ type: "text", text: `No game found with session ID: ${sessionId}. Use poker_new_game to start.` }],
        isError: true,
      };
    }
    return { content: [{ type: "text", text: formatState(state) }] };
  }
);

// Tool: poker_deal
server.registerTool(
  "poker_deal",
  {
    description:
      "Deal the next community cards: flop (3 cards), turn (1 card), or river (1 card). Automatically advances the game phase. Use after both players have acted.",
    inputSchema: {
      sessionId: z.string().describe("The game session ID."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async ({ sessionId }) => {
    const state = await loadState(sessionId);
    if (!state) {
      return {
        content: [{ type: "text", text: `No game found: ${sessionId}` }],
        isError: true,
      };
    }
    if (state.phase === "showdown") {
      return {
        content: [{ type: "text", text: "Game is over. Start a new game with poker_new_game." }],
        isError: true,
      };
    }

    if (state.phase === "preflop") {
      state.phase = "flop";
      state.communityCards = state.deck.splice(0, 3);
      state.lastAction = `Flop: ${state.communityCards.map(formatCard).join(" ")}`;
    } else if (state.phase === "flop") {
      state.phase = "turn";
      const card = state.deck.splice(0, 1)[0];
      state.communityCards.push(card);
      state.lastAction = `Turn: ${formatCard(card)}`;
    } else if (state.phase === "turn") {
      state.phase = "river";
      const card = state.deck.splice(0, 1)[0];
      state.communityCards.push(card);
      state.lastAction = `River: ${formatCard(card)}`;
    } else {
      return {
        content: [{ type: "text", text: "All community cards have been dealt. Use poker_action to finish the hand." }],
      };
    }

    state.updatedAt = new Date().toISOString();
    await saveState(state);
    return { content: [{ type: "text", text: formatState(state) }] };
  }
);

// Tool: poker_action
server.registerTool(
  "poker_action",
  {
    description:
      "Perform a player action: fold (give up the hand), call (match current bet), or raise (increase the bet). Returns the updated game state.",
    inputSchema: {
      sessionId: z.string().describe("The game session ID."),
      action: z.enum(["fold", "call", "raise"]).describe("The action to take: fold, call, or raise."),
      amount: z
        .number()
        .optional()
        .describe("Raise amount in dollars (only used when action is 'raise'). Defaults to 2x current bet."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async ({ sessionId, action, amount }) => {
    const state = await loadState(sessionId);
    if (!state) {
      return {
        content: [{ type: "text", text: `No game found: ${sessionId}` }],
        isError: true,
      };
    }
    if (state.phase === "showdown") {
      return {
        content: [{ type: "text", text: "Game is over. Start a new game with poker_new_game." }],
        isError: true,
      };
    }

    if (action === "fold") {
      state.winner = "opponent";
      state.opponentStack += state.pot;
      state.lastAction = "You folded. Opponent wins the pot!";
      state.phase = "showdown";
    } else if (action === "call") {
      state.playerStack -= state.currentBet;
      state.pot += state.currentBet;
      state.lastAction = `You called $${state.currentBet}. Pot is now $${state.pot}.`;

      if (state.phase === "river") {
        state.phase = "showdown";
        state.winner = Math.random() > 0.5 ? "player" : "opponent";
        if (state.winner === "player") {
          state.playerStack += state.pot;
          state.lastAction = `You called $${state.currentBet}. SHOWDOWN — You win $${state.pot}! 🎉`;
        } else {
          state.opponentStack += state.pot;
          state.lastAction = `You called $${state.currentBet}. SHOWDOWN — Opponent wins $${state.pot}.`;
        }
      }
    } else if (action === "raise") {
      const raiseAmount = amount ?? state.currentBet * 2;
      if (raiseAmount > state.playerStack) {
        return {
          content: [{ type: "text", text: `Raise of $${raiseAmount} exceeds your stack of $${state.playerStack}.` }],
          isError: true,
        };
      }
      state.playerStack -= raiseAmount;
      state.pot += raiseAmount;
      state.currentBet = raiseAmount;
      state.lastAction = `You raised to $${raiseAmount}. Pot is $${state.pot}.`;
    }

    state.updatedAt = new Date().toISOString();
    await saveState(state);
    return { content: [{ type: "text", text: formatState(state) }] };
  }
);

// ---- Start server ----
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("🎴 Voice Poker MCP Server running (stdio)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
