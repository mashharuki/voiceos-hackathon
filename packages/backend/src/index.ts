import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createClient } from "@supabase/supabase-js";
import { Hono } from "hono";
import { cors } from "hono/cors";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- Supabase ----
const supabaseUrl = process.env.SUPABASE_URL ?? "";
const supabaseKey = process.env.SUPABASE_ANON_KEY ?? "";
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

// ---- In-memory fallback ----
const memoryStore = new Map<string, GameState>();

// ---- Types ----
export interface Card {
  suit: "♠" | "♥" | "♦" | "♣";
  rank: string;
  value: number;
}

export interface GameState {
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

// ---- Game logic helpers ----
export function createDeck(): Card[] {
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

export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---- DB helpers ----
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

// ---- App ----
const app = new Hono();
app.use("*", cors());

// Serve frontend HTML
app.get("/", (c) => {
  const html = readFileSync(join(__dirname, "public", "index.html"), "utf-8");
  return c.html(html);
});

// Get game state
app.get("/api/state/:sessionId", async (c) => {
  const state = await loadState(c.req.param("sessionId"));
  if (!state) return c.json({ error: "Game not found" }, 404);
  return c.json(state);
});

// New game
app.post("/api/new-game", async (c) => {
  const body = await c.req.json<{ sessionId?: string }>();
  const sessionId = body.sessionId ?? `game-${Date.now()}`;
  const deck = shuffle(createDeck());
  const state: GameState = {
    sessionId,
    phase: "preflop",
    deck: deck.slice(4),
    playerHand: [deck[0], deck[1]],
    opponentHand: [deck[2], deck[3]],
    communityCards: [],
    pot: 30,
    playerStack: 985,
    opponentStack: 985,
    currentBet: 15,
    lastAction: "Game started. Small blind: $15, Big blind: $30",
    winner: null,
    updatedAt: new Date().toISOString(),
  };
  await saveState(state);
  return c.json(state);
});

// Player action
app.post("/api/action", async (c) => {
  const body = await c.req.json<{ sessionId: string; action: "fold" | "call" | "raise"; amount?: number }>();
  const state = await loadState(body.sessionId);
  if (!state) return c.json({ error: "Game not found" }, 404);

  const { action, amount } = body;

  if (action === "fold") {
    state.winner = "opponent";
    state.opponentStack += state.pot;
    state.lastAction = "You folded. Opponent wins the pot!";
    state.phase = "showdown";
  } else if (action === "call") {
    state.playerStack -= state.currentBet;
    state.pot += state.currentBet;
    state.lastAction = `You called $${state.currentBet}`;
    // Advance phase
    if (state.phase === "preflop") {
      state.phase = "flop";
      state.communityCards = state.deck.splice(0, 3);
    } else if (state.phase === "flop") {
      state.phase = "turn";
      state.communityCards.push(...state.deck.splice(0, 1));
    } else if (state.phase === "turn") {
      state.phase = "river";
      state.communityCards.push(...state.deck.splice(0, 1));
    } else if (state.phase === "river") {
      state.phase = "showdown";
      // Simple random winner for demo
      state.winner = Math.random() > 0.5 ? "player" : "opponent";
      if (state.winner === "player") {
        state.playerStack += state.pot;
        state.lastAction = "Showdown! You win the pot!";
      } else {
        state.opponentStack += state.pot;
        state.lastAction = "Showdown! Opponent wins the pot!";
      }
    }
  } else if (action === "raise") {
    const raiseAmount = amount ?? state.currentBet * 2;
    state.playerStack -= raiseAmount;
    state.pot += raiseAmount;
    state.currentBet = raiseAmount;
    state.lastAction = `You raised to $${raiseAmount}`;
  }

  state.updatedAt = new Date().toISOString();
  await saveState(state);
  return c.json(state);
});

// Deal community cards (called by MCP)
app.post("/api/deal", async (c) => {
  const body = await c.req.json<{ sessionId: string }>();
  const state = await loadState(body.sessionId);
  if (!state) return c.json({ error: "Game not found" }, 404);

  if (state.phase === "preflop") {
    state.phase = "flop";
    state.communityCards = state.deck.splice(0, 3);
    state.lastAction = "Flop dealt";
  } else if (state.phase === "flop") {
    state.phase = "turn";
    state.communityCards.push(...state.deck.splice(0, 1));
    state.lastAction = "Turn dealt";
  } else if (state.phase === "turn") {
    state.phase = "river";
    state.communityCards.push(...state.deck.splice(0, 1));
    state.lastAction = "River dealt";
  }

  state.updatedAt = new Date().toISOString();
  await saveState(state);
  return c.json(state);
});

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, () => {
  console.log(`🎰 Voice Poker backend running on http://localhost:${port}`);
});
