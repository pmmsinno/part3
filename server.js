const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingInterval: 10000,
  pingTimeout: 5000,
});

app.use(express.static(path.join(__dirname, "public")));

// Debug
const publicPath = path.join(__dirname, "public");
console.log("__dirname:", __dirname);
console.log("Public path:", publicPath);
console.log("Public exists:", fs.existsSync(publicPath));
if (fs.existsSync(publicPath)) console.log("Public contents:", fs.readdirSync(publicPath));

// ─── Round Configuration ─────────────────────────────────────
// Rounds 1-4: SURVIVAL — survive for durationSec, don't get caught
// Round 5:    FINAL RACE — race to 100% progress, first to finish wins
const ROUNDS = [
  {
    type: "survival", durationSec: 60, gracePeriodMs: 1000,
    greenDuration: { min: 3000, max: 5500 },
    redDuration: { min: 2000, max: 3500 },
    label: "WARM-UP",
  },
  {
    type: "survival", durationSec: 55, gracePeriodMs: 850,
    greenDuration: { min: 2500, max: 5000 },
    redDuration: { min: 1800, max: 3200 },
    label: "GETTING HARDER",
  },
  {
    type: "survival", durationSec: 50, gracePeriodMs: 700,
    greenDuration: { min: 2000, max: 4000 },
    redDuration: { min: 1500, max: 3000 },
    label: "SERIOUS",
  },
  {
    type: "survival", durationSec: 45, gracePeriodMs: 600,
    greenDuration: { min: 1500, max: 3500 },
    redDuration: { min: 1500, max: 2800 },
    label: "INTENSE",
  },
  {
    type: "race", durationSec: null, gracePeriodMs: 500,
    greenDuration: { min: 1000, max: 2500 },
    redDuration: { min: 1200, max: 2500 },
    progressRate: 0.8,
    label: "⚡ FINAL RACE ⚡",
  },
];

function getRoundConfig(round) {
  return ROUNDS[Math.min(Math.max(round - 1, 0), ROUNDS.length - 1)];
}

// ─── Game State ──────────────────────────────────────────────
const game = {
  phase: "lobby",
  light: "red",
  players: new Map(),
  round: 0,
  lightTimer: null,
  graceTimer: null,
  countdownTimer: null,
  roundTimer: null,
  roundStartTime: null,
  progressToWin: 100,
  eliminationPending: false,
  eliminationOrder: [],
  finishOrder: [],
  usedNames: new Set(),
  tournamentActive: false,
};

function createPlayer(id, name) {
  return {
    id, name: name.substring(0, 15),
    progress: 0, alive: true, holding: false,
    eliminated: false, finishedAt: null, eliminatedInRound: null,
  };
}

function getPlayersArray() {
  return Array.from(game.players.values()).map(p => ({
    id: p.id, name: p.name, progress: p.progress,
    alive: p.alive, holding: p.holding,
    finishedAt: p.finishedAt, eliminatedInRound: p.eliminatedInRound,
  }));
}

function getAlivePlayers() {
  return Array.from(game.players.values()).filter(p => p.alive);
}

function getCurrentRound() {
  return getRoundConfig(game.round || 1);
}

function isRaceRound() {
  return getCurrentRound().type === "race";
}

function getRoundTimeLeft() {
  const rc = getCurrentRound();
  if (rc.type !== "survival" || !game.roundStartTime) return null;
  const elapsed = (Date.now() - game.roundStartTime) / 1000;
  return Math.max(0, rc.durationSec - elapsed);
}

function getLeaderboard() {
  const entries = [];
  game.finishOrder.forEach((f, i) => {
    entries.push({ name: f.name, id: f.id, position: i + 1, status: "winner", round: f.round });
  });
  const alive = Array.from(game.players.values()).filter(p => p.alive && !p.finishedAt);
  alive.sort((a, b) => b.progress - a.progress);
  alive.forEach(p => {
    entries.push({ name: p.name, id: p.id, position: entries.length + 1, status: "alive", round: null });
  });
  [...game.eliminationOrder].reverse().forEach(e => {
    entries.push({ name: e.name, id: e.id, position: entries.length + 1, status: "eliminated", round: e.round });
  });
  return entries;
}

function getPlayerPosition(playerId) {
  const lb = getLeaderboard();
  const entry = lb.find(e => e.id === playerId);
  return entry ? { position: entry.position, total: lb.length, status: entry.status } : null;
}

function broadcastGameState() {
  const rc = getCurrentRound();
  io.to("tv").emit("gameState", {
    phase: game.phase,
    light: game.light,
    players: getPlayersArray(),
    round: game.round,
    tournamentActive: game.tournamentActive,
    roundType: rc.type,
    roundLabel: rc.label,
    timeLeft: getRoundTimeLeft(),
    difficulty: { gracePeriodMs: rc.gracePeriodMs, roundLabel: rc.label },
    leaderboard: getLeaderboard(),
  });
}

function broadcastToPhones() {
  const rc = getCurrentRound();
  game.players.forEach(player => {
    const pos = getPlayerPosition(player.id);
    io.to(player.id).emit("playerState", {
      phase: game.phase,
      light: game.light,
      progress: player.progress,
      alive: player.alive,
      holding: player.holding,
      round: game.round,
      position: pos,
      tournamentActive: game.tournamentActive,
      roundType: rc.type,
      roundLabel: rc.label,
      timeLeft: getRoundTimeLeft(),
    });
  });
}

function broadcastAll() {
  broadcastGameState();
  broadcastToPhones();
}

// ─── Time ticker for survival rounds (updates countdown on TV/phones) ──
let tickInterval = null;

function startTimeTicker() {
  if (tickInterval) clearInterval(tickInterval);
  tickInterval = setInterval(() => {
    if (game.phase !== "playing") { clearInterval(tickInterval); return; }
    const tl = getRoundTimeLeft();
    if (tl !== null && tl <= 0) {
      clearInterval(tickInterval);
      endSurvivalRound();
      return;
    }
    // Broadcast time update every second
    broadcastAll();
  }, 1000);
}

function stopTimeTicker() {
  if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
}

// ─── Progress (only in race rounds) ──────────────────────────
let progressInterval = null;

function startProgressTracking() {
  if (!isRaceRound()) return;
  if (progressInterval) clearInterval(progressInterval);
  progressInterval = setInterval(() => {
    if (game.phase !== "playing" || game.light !== "green") return;
    const rc = getCurrentRound();
    let someoneFinished = false;
    game.players.forEach(player => {
      if (player.alive && player.holding && !player.finishedAt) {
        player.progress = Math.min(game.progressToWin, player.progress + rc.progressRate);
        if (player.progress >= game.progressToWin) {
          player.finishedAt = Date.now();
          someoneFinished = true;
          game.finishOrder.push({ id: player.id, name: player.name, round: game.round });
        }
      }
    });
    broadcastAll();
    if (someoneFinished) checkForRaceWinner();
  }, 100);
}

function stopProgressTracking() {
  if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
}

// ─── Light Switching ─────────────────────────────────────────
function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function switchToGreen() {
  if (game.phase !== "playing") return;
  if (getAlivePlayers().length === 0) { endRound(null); return; }

  game.light = "green";
  game.eliminationPending = false;
  broadcastAll();

  const rc = getCurrentRound();
  game.lightTimer = setTimeout(() => switchToRed(), randomBetween(rc.greenDuration.min, rc.greenDuration.max));
}

function switchToRed() {
  if (game.phase !== "playing") return;
  game.light = "red";
  game.eliminationPending = true;
  broadcastAll();

  const rc = getCurrentRound();
  game.graceTimer = setTimeout(() => eliminateHolders(), rc.gracePeriodMs);
}

function eliminatePlayer(player) {
  player.alive = false;
  player.eliminated = true;
  player.holding = false;
  player.eliminatedInRound = game.round;
  game.eliminationOrder.push({ id: player.id, name: player.name, round: game.round });
}

function eliminateHolders() {
  if (game.phase !== "playing" || game.light !== "red") return;
  game.eliminationPending = false;

  const eliminated = [];
  game.players.forEach(player => {
    if (player.alive && player.holding) {
      eliminatePlayer(player);
      eliminated.push({ id: player.id, name: player.name });
    }
  });

  if (eliminated.length > 0) {
    io.to("tv").emit("eliminations", eliminated);
    eliminated.forEach(e => {
      const pos = getPlayerPosition(e.id);
      io.to(e.id).emit("eliminated", { position: pos });
    });
  }

  broadcastAll();

  const alive = getAlivePlayers();
  if (alive.length === 0) { endRound(null); return; }

  // Race round: if only 1 left, they win
  if (isRaceRound() && alive.length === 1) {
    const w = alive[0];
    game.finishOrder.push({ id: w.id, name: w.name, round: game.round });
    w.finishedAt = Date.now();
    endRound(w);
    return;
  }

  // Survival round: check if time is up
  const tl = getRoundTimeLeft();
  if (tl !== null && tl <= 0) {
    endSurvivalRound();
    return;
  }

  const rc = getCurrentRound();
  game.lightTimer = setTimeout(() => switchToGreen(), randomBetween(rc.redDuration.min, rc.redDuration.max));
}

function checkForRaceWinner() {
  const roundFinishers = game.finishOrder.filter(f => f.round === game.round);
  if (roundFinishers.length > 0) {
    const winner = game.players.get(roundFinishers[0].id);
    endRound(winner);
  }
}

function endSurvivalRound() {
  if (game.phase === "roundEnd" || game.phase === "gameOver") return;
  game.phase = "roundEnd";
  clearAllTimers();
  stopProgressTracking();
  stopTimeTicker();
  game.light = "red";

  const alive = getAlivePlayers();
  const nextRoundIndex = Math.min(game.round, ROUNDS.length - 1);
  const nextRc = ROUNDS[nextRoundIndex];

  io.to("tv").emit("roundEnd", {
    round: game.round,
    survivors: alive.map(p => ({ id: p.id, name: p.name })),
    totalAlive: alive.length,
    totalPlayers: game.players.size,
    leaderboard: getLeaderboard(),
    nextRound: game.round + 1,
    nextRoundLabel: nextRc.label,
    nextRoundType: nextRc.type,
  });

  game.players.forEach(player => {
    const pos = getPlayerPosition(player.id);
    io.to(player.id).emit("playerState", {
      phase: "roundEnd", light: "red", progress: 0,
      alive: player.alive, holding: false, round: game.round,
      position: pos, tournamentActive: true,
      roundType: "survival", roundLabel: getCurrentRound().label,
      timeLeft: 0,
    });
  });
}

function endRound(winner) {
  if (game.phase === "gameOver") return;
  game.phase = "gameOver";
  clearAllTimers();
  stopProgressTracking();
  stopTimeTicker();
  game.light = "red";

  io.to("tv").emit("gameOver", {
    winner: winner ? { id: winner.id, name: winner.name } : null,
    players: getPlayersArray(),
    round: game.round,
    leaderboard: getLeaderboard(),
    isFinal: isRaceRound(),
  });

  game.players.forEach(player => {
    const pos = getPlayerPosition(player.id);
    io.to(player.id).emit("playerState", {
      phase: "gameOver", light: "red",
      progress: player.progress, alive: player.alive,
      holding: false, round: game.round, position: pos,
      tournamentActive: game.tournamentActive,
      roundType: getCurrentRound().type,
      roundLabel: getCurrentRound().label, timeLeft: 0,
    });
  });
}

function clearAllTimers() {
  clearTimeout(game.lightTimer);
  clearTimeout(game.graceTimer);
  clearInterval(game.countdownTimer);
  clearTimeout(game.roundTimer);
}

function startGame() {
  const alive = getAlivePlayers();
  if (alive.length < 2) {
    if (alive.length === 1) {
      const w = alive[0];
      game.finishOrder.push({ id: w.id, name: w.name, round: game.round + 1 });
      w.finishedAt = Date.now();
      game.round++;
      endRound(w);
    }
    return;
  }

  game.tournamentActive = true;
  game.phase = "countdown";
  game.round++;
  game.light = "red";
  game.roundStartTime = null;

  const rc = getCurrentRound();

  game.players.forEach(player => {
    if (player.alive) {
      player.progress = 0;
      player.holding = false;
      player.finishedAt = null;
    }
  });

  io.to("tv").emit("roundInfo", {
    round: game.round,
    label: rc.label,
    type: rc.type,
    durationSec: rc.durationSec,
    gracePeriodMs: rc.gracePeriodMs,
  });

  broadcastAll();

  let count = 3;
  io.to("tv").emit("countdown", count);
  game.players.forEach(p => { if (p.alive) io.to(p.id).emit("countdown", count); });

  game.countdownTimer = setInterval(() => {
    count--;
    if (count > 0) {
      io.to("tv").emit("countdown", count);
      game.players.forEach(p => { if (p.alive) io.to(p.id).emit("countdown", count); });
    } else {
      clearInterval(game.countdownTimer);
      game.phase = "playing";
      game.roundStartTime = Date.now();
      startProgressTracking();
      if (rc.type === "survival") startTimeTicker();
      switchToGreen();
    }
  }, 1000);
}

function resetLobby() {
  game.phase = "lobby";
  game.light = "red";
  game.round = 0;
  game.roundStartTime = null;
  game.eliminationOrder = [];
  game.finishOrder = [];
  game.usedNames.clear();
  game.tournamentActive = false;
  clearAllTimers();
  stopProgressTracking();
  stopTimeTicker();

  game.players.forEach(player => io.to(player.id).emit("lobbyReset"));
  game.players.clear();
  broadcastAll();
}

function checkSoftlock() {
  if (game.phase !== "playing") return;
  const alive = getAlivePlayers();
  if (alive.length === 0) { endRound(null); return; }
  if (alive.length === 1 && isRaceRound()) {
    const w = alive[0];
    if (!w.finishedAt) {
      game.finishOrder.push({ id: w.id, name: w.name, round: game.round });
      w.finishedAt = Date.now();
    }
    endRound(w);
  }
  // In survival: 1 player left is fine, they just survive
}

// ─── QR Code ─────────────────────────────────────────────────
app.get("/qr", async (req, res) => {
  try {
    const protocol = req.headers["x-forwarded-proto"] || req.protocol;
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const url = `${protocol}://${host}/phone.html`;
    const qr = await QRCode.toDataURL(url, { width: 400, margin: 2, color: { dark: "#1a1a2e", light: "#ffffff" } });
    res.json({ qr, url });
  } catch (err) { res.status(500).json({ error: "QR generation failed" }); }
});

// ─── Socket.io ───────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`Connected: ${socket.id}`);

  socket.on("joinTV", () => { socket.join("tv"); broadcastGameState(); });

  socket.on("joinGame", (name) => {
    if (!name || name.trim().length === 0) { socket.emit("joinError", "Please enter a name!"); return; }
    const cleanName = name.trim().substring(0, 15);
    if (game.tournamentActive) { socket.emit("joinError", "Tournament in progress! Wait for a new game."); return; }
    if (game.phase !== "lobby") { socket.emit("joinError", "Game in progress. Wait for next game!"); return; }
    const nameLower = cleanName.toLowerCase();
    const existingNames = Array.from(game.players.values()).map(p => p.name.toLowerCase());
    if (existingNames.includes(nameLower)) { socket.emit("joinError", "Name already taken! Pick another."); return; }

    const player = createPlayer(socket.id, cleanName);
    game.players.set(socket.id, player);
    game.usedNames.add(nameLower);
    socket.emit("joined", { id: player.id, name: player.name });
    io.to("tv").emit("playerJoined", { id: player.id, name: player.name });
    broadcastGameState();
    console.log(`Player joined: ${player.name} (${socket.id})`);
  });

  socket.on("holdStart", () => {
    const player = game.players.get(socket.id);
    if (!player || !player.alive || player.eliminated || player.finishedAt || game.phase !== "playing") return;
    player.holding = true;
    if (game.light === "red" && !game.eliminationPending) {
      eliminatePlayer(player);
      io.to("tv").emit("eliminations", [{ id: player.id, name: player.name }]);
      const pos = getPlayerPosition(player.id);
      socket.emit("eliminated", { position: pos });
      broadcastAll();
      checkSoftlock();
    }
  });

  socket.on("holdEnd", () => {
    const player = game.players.get(socket.id);
    if (!player) return;
    player.holding = false;
  });

  socket.on("startGame", () => {
    if (game.phase === "lobby" || game.phase === "gameOver" || game.phase === "roundEnd") {
      startGame();
    }
  });

  socket.on("resetLobby", () => resetLobby());

  socket.on("kickPlayer", (playerId) => {
    game.players.delete(playerId);
    io.to(playerId).emit("kicked");
    broadcastGameState();
  });

  socket.on("disconnect", () => {
    const player = game.players.get(socket.id);
    if (player) {
      console.log(`Player disconnected: ${player.name}`);
      if (game.phase === "lobby" && !game.tournamentActive) {
        game.players.delete(socket.id);
        game.usedNames.delete(player.name.toLowerCase());
      } else {
        if (player.alive) {
          eliminatePlayer(player);
          io.to("tv").emit("eliminations", [{ id: player.id, name: player.name }]);
        }
        checkSoftlock();
      }
      broadcastAll();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🔴🟢 Red Light Green Light server running on port ${PORT}`);
  console.log(`   TV view:    http://localhost:${PORT}/tv.html`);
  console.log(`   Player view: http://localhost:${PORT}/phone.html`);
});
