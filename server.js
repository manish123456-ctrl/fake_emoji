
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

const PORT = process.env.PORT || 3000;
const rooms = new Map();

const TIMERS = {
  picking: 60,
  voting: 90,
  guessing: 30,
  results: 10
};

const RECONNECT_GRACE_PERIOD = 30 * 1000;
const SEAT_RETENTION_PERIOD = 5 * 60 * 1000;

const BOARDS = {
  Food: [
    "Pizza", "Dosa", "Burger", "Biryani",
    "Ice Cream", "Samosa", "Pasta", "Idli",
    "Mango", "Chocolate", "Pani Puri", "Noodles",
    "Sandwich", "Jalebi", "Popcorn", "Pav Bhaji"
  ],

  Animals: [
    "Lion", "Tiger", "Elephant", "Monkey",
    "Dog", "Cat", "Giraffe", "Penguin",
    "Dolphin", "Snake", "Rabbit", "Kangaroo",
    "Crocodile", "Peacock", "Panda", "Horse"
  ],

  "Desi Life": [
    "Auto Rickshaw", "Cricket", "Chai", "Bollywood",
    "Wedding", "Monsoon", "Traffic Jam", "Street Food",
    "Train Journey", "Diwali", "Mango", "School",
    "Family Function", "Shopping", "Power Cut", "Chappal"
  ],

  Movies: [
    "Horror", "Comedy", "Romance", "Action",
    "Superhero", "Detective", "Adventure", "Animation",
    "Thriller", "Musical", "Fantasy", "Sci-Fi",
    "Drama", "Documentary", "Western", "Mystery"
  ],

  Places: [
    "Beach", "Airport", "Hospital", "School",
    "Restaurant", "Mountain", "Forest", "Museum",
    "Cinema", "Temple", "Library", "Stadium",
    "Mall", "Railway Station", "Park", "Hotel"
  ]
};

const EMOJI_CATEGORIES = {
  Faces: [
    "😀","😃","😄","😁","😆","😅","😂","🤣",
    "😊","😇","🙂","🙃","😉","😍","🥰","😘",
    "😋","😎","🤔","🤫","🤭","😭","😡","🤯",
    "🥳","😴","🤗","😱","🤤","😏","🤩","😬"
  ],

  Food: [
    "🍎","🍊","🍋","🍉","🍇","🍓","🍒","🍍",
    "🥭","🍌","🍑","🥥","🍅","🥑","🥕","🌽",
    "🍕","🍔","🍟","🌭","🍿","🍩","🍪","🎂",
    "🍰","🍫","🍬","🍭","🍜","🍣","🍚","☕"
  ],

  Animals: [
    "🐶","🐱","🐭","🐹","🐰","🦊","🐻","🐼",
    "🐨","🐯","🦁","🐮","🐷","🐸","🐵","🐔",
    "🐧","🐦","🦆","🦅","🦉","🦋","🐢","🐍",
    "🐬","🐳","🦈","🐘","🦒","🦓","🐎","🐄"
  ],

  Nature: [
    "🌞","🌝","🌙","⭐","🌈","☁️","🌧️","⛈️",
    "❄️","🔥","💧","🌊","🌸","🌹","🌻","🌳",
    "🌴","🍀","🌵","🍁","🌺","🌼","🌍","🌋"
  ],

  Activities: [
    "⚽","🏀","🏈","⚾","🎾","🏏","🏆","🎯",
    "🎮","🎲","🎸","🎹","🎤","🎧","🎬","🎨",
    "🚴","🏊","🏃","🧘","💃","🕺","🎭","🎪"
  ],

  Objects: [
    "🚗","🚕","🚌","🚂","✈️","🚀","🚲","🏍️",
    "🏠","🏰","🏫","🏥","📱","💻","⌚","📷",
    "💡","🔑","💎","🎁","💰","📚","✏️","🛏️",
    "🪑","🧸","🔔","🧲","🛠️","🧹","🧳","🕯️"
  ],

  Symbols: [
    "❤️","💔","💖","💯","💥","💫","✨","⚡",
    "☀️","❄️","🎵","🎶","🔒","🔓","✅","❌",
    "❓","❗","♻️","🚫","💤","🆘","🔴","🟢"
  ]
};

const ALLOWED_EMOJIS = new Set(
  Object.values(EMOJI_CATEGORIES).flat()
);

// --------------------------------------------------
// BASIC UTILITIES
// --------------------------------------------------

function randomToken() {
  return crypto.randomBytes(24).toString("hex");
}

function randomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let code;

  do {
    code = Array.from(
      { length: 4 },
      () => chars[Math.floor(Math.random() * chars.length)]
    ).join("");
  } while (rooms.has(code));

  return code;
}

function shuffle(array) {
  const result = [...array];

  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
}

function connectedPlayers(room) {
  return room.players.filter(p => p.connected);
}

function getPlayer(room, token) {
  return room.players.find(p => p.token === token);
}

function getHost(room) {
  return room.players.find(p => p.id === room.hostId);
}

// --------------------------------------------------
// PRIVATE GAME STATE
// --------------------------------------------------

function emitRoom(room) {
  room.players.forEach(player => {
    if (!player.socketId || !player.connected) return;

    const isPlaying = room.roundPlayers.includes(player.id);
    const isFaker = room.fakerId === player.id;

    const revealed = [
      "voting",
      "guessing",
      "results",
      "finished"
    ].includes(room.phase);

    const view = {
      code: room.code,
      phase: room.phase,

      players: room.players.map(p => ({
        id: p.id,
        name: p.name,
        connected: p.connected,
        late: p.late,
        isHost: p.id === room.hostId
      })),

      hostId: room.hostId,
      isHost: player.id === room.hostId,
      myId: player.id,

      myRole: isPlaying
        ? (isFaker ? "faker" : "player")
        : "waiting",

      category: room.category,
      board: room.board,
      rounds: room.rounds,
      currentRound: room.currentRound,
      phase: room.phase,
      deadline: room.deadline,
      serverTime: Date.now(),
      timerLengths: TIMERS,

      myEmojis: room.emojis[player.id] || [],
      myVote: room.votes[player.id] || null,

      emojis: revealed
        ? Object.fromEntries(
            room.roundPlayers.map(id => [
              id,
              room.emojis[id] || []
            ])
          )
        : null,

      lockedCount: room.roundPlayers.filter(
        id => room.emojis[id] !== undefined
      ).length,

      voteCount: Object.keys(room.votes).length,
      roundPlayerCount: room.roundPlayers.length,

      // CRITICAL SECURITY:
      // The Faker never receives the secret word.
      secretWord:
        isPlaying && !isFaker
          ? room.secretWord
          : null,

      guessOptions:
        isFaker && room.phase === "guessing"
          ? room.board
          : [],

      guessResult: room.guessResult,
      results: room.results,
      lastRound: room.lastRound,

      scoreboard: room.players.map(p => ({
        id: p.id,
        name: p.name,
        score: p.score,
        fakerTurns: p.fakerTurns,
        correctVotes: p.correctVotes
      })),

      awards: room.awards
    };

    io.to(player.socketId).emit("gameState", view);
  });
}

// --------------------------------------------------
// TIMERS
// --------------------------------------------------

function clearTimer(room) {
  if (room.timer) {
    clearTimeout(room.timer);
  }

  room.timer = null;
}

function startTimer(room, seconds, callback) {
  clearTimer(room);

  room.deadline = Date.now() + seconds * 1000;

  room.timer = setTimeout(() => {
    if (!rooms.has(room.code)) return;
    callback();
  }, seconds * 1000);
}

function startPhase(room, phase, seconds, callback) {
  room.phase = phase;

  startTimer(room, seconds, callback);

  emitRoom(room);
}

// --------------------------------------------------
// ROUND MANAGEMENT
// --------------------------------------------------

function chooseBoard(room) {
  const words = BOARDS[room.category] || BOARDS.Food;

  room.board = [...words];

  room.secretWord = room.board[
    Math.floor(Math.random() * room.board.length)
  ];
}

function selectFaker(room) {
  const eligible = room.roundPlayers.filter(id =>
    room.players.some(p => p.id === id && p.connected)
  );

  if (!eligible.length) return null;

  if (
    !room.fakerQueue.length ||
    room.fakerQueue.every(id => !eligible.includes(id))
  ) {
    room.fakerQueue = shuffle(eligible);
  }

  let faker = room.fakerQueue.shift();

  while (faker && !eligible.includes(faker)) {
    faker = room.fakerQueue.shift();
  }

  return faker || eligible[0];
}

function startRound(room) {
  clearTimer(room);

  const active = connectedPlayers(room);

  if (active.length < 3) {
    room.phase = "lobby";
    room.message = "At least 3 connected players are required.";

    emitRoom(room);
    return;
  }

  if (room.currentRound >= room.rounds) {
    finishGame(room);
    return;
  }

  room.currentRound++;

  room.roundPlayers = active.map(p => p.id);

  room.roundPlayers.forEach(id => {
    const p = room.players.find(player => player.id === id);
    if (p) p.late = false;
  });

  room.emojis = {};
  room.votes = {};
  room.guessResult = null;
  room.results = null;
  room.lastRound = null;
  room.message = "";

  chooseBoard(room);

  room.fakerId = selectFaker(room);

  if (!room.fakerId) {
    room.phase = "lobby";
    emitRoom(room);
    return;
  }

  const faker = room.players.find(
    p => p.id === room.fakerId
  );

  if (faker) faker.fakerTurns++;

  startPhase(room, "picking", TIMERS.picking, () => {
    endPicking(room);
  });
}

function endPicking(room) {
  if (room.phase !== "picking") return;

  room.roundPlayers.forEach(id => {
    if (!room.emojis[id]) {
      room.emojis[id] = [];
    }
  });

  startPhase(room, "voting", TIMERS.voting, () => {
    endVoting(room);
  });
}

function endVoting(room) {
  if (room.phase !== "voting") return;

  const counts = {};

  room.roundPlayers.forEach(id => {
    const vote = room.votes[id];

    if (
      vote &&
      room.roundPlayers.includes(vote) &&
      vote !== id
    ) {
      counts[vote] = (counts[vote] || 0) + 1;
    }
  });

  const maxVotes = Math.max(
    0,
    ...Object.values(counts)
  );

  const leaders = Object.keys(counts).filter(
    id => counts[id] === maxVotes
  );

  const fakerCaught =
    maxVotes > 0 &&
    leaders.length === 1 &&
    leaders[0] === room.fakerId;

  const roundPoints = {};

  room.roundPlayers.forEach(id => {
    roundPoints[id] = 0;

    if (room.votes[id] === room.fakerId) {
      const player = room.players.find(p => p.id === id);

      if (player) {
        player.score += 1;
        player.correctVotes++;
        roundPoints[id] += 1;
      }
    }
  });

  room.fakerCaught = fakerCaught;
  room.voteCounts = counts;
  room.roundPoints = roundPoints;

  if (!fakerCaught) {
    const faker = room.players.find(
      p => p.id === room.fakerId
    );

    if (faker) {
      faker.score += 3;
      roundPoints[room.fakerId] += 3;
    }

    finishRound(room, "escaped");
    return;
  }

  startPhase(room, "guessing", TIMERS.guessing, () => {
    resolveGuess(room, null);
  });
}

function resolveGuess(room, guess) {
  if (room.phase !== "guessing") return;

  const correct = guess === room.secretWord;

  room.guessResult = {
    guess: guess || "No guess",
    correct
  };

  if (correct) {
    const faker = room.players.find(
      p => p.id === room.fakerId
    );

    if (faker) {
      faker.score += 2;
      room.roundPoints[room.fakerId] += 2;
    }
  } else {
    room.roundPlayers.forEach(id => {
      if (id === room.fakerId) return;

      const player = room.players.find(p => p.id === id);

      if (player) {
        player.score += 1;
        room.roundPoints[id] += 1;
      }
    });
  }

  finishRound(room, correct ? "guessed" : "wrong");
}

function finishRound(room, outcome) {
  clearTimer(room);

  const faker = room.players.find(
    p => p.id === room.fakerId
  );

  const voteDetails = room.roundPlayers.map(id => {
    const voter = room.players.find(p => p.id === id);
    const voted = room.players.find(
      p => p.id === room.votes[id]
    );

    return {
      voter: voter ? voter.name : "Unknown",
      voterId: id,
      votedFor: voted ? voted.name : "No vote",
      votedForId: room.votes[id] || null
    };
  });

  room.lastRound = {
    round: room.currentRound,
    faker: faker ? faker.name : "Unknown",
    fakerId: room.fakerId,
    secretWord: room.secretWord,
    category: room.category,
    outcome,
    votes: voteDetails,
    voteCounts: room.voteCounts || {},

    points: room.roundPlayers.map(id => {
      const p = room.players.find(player => player.id === id);

      return {
        id,
        name: p ? p.name : "Unknown",
        earned: room.roundPoints[id] || 0,
        total: p ? p.score : 0
      };
    }),

    emojis: Object.fromEntries(
      room.roundPlayers.map(id => [
        id,
        room.emojis[id] || []
      ])
    ),

    guessResult: room.guessResult
  };

  startPhase(room, "results", TIMERS.results, () => {
    if (room.currentRound >= room.rounds) {
      finishGame(room);
    } else {
      startRound(room);
    }
  });
}

// --------------------------------------------------
// FINAL SCOREBOARD
// --------------------------------------------------

function finishGame(room) {
  clearTimer(room);

  room.phase = "finished";
  room.deadline = null;

  const sorted = [...room.players].sort(
    (a, b) => b.score - a.score
  );

  room.awards = [];

  if (sorted[0]) {
    room.awards.push({
      title: "Champion",
      name: sorted[0].name,
      description: "The highest-scoring player!"
    });
  }

  const detective = [...room.players].sort(
    (a, b) => b.correctVotes - a.correctVotes
  )[0];

  if (detective && detective.correctVotes > 0) {
    room.awards.push({
      title: "Sherlock",
      name: detective.name,
      description: "Spotted the Faker most often."
    });
  }

  const bluffer = [...room.players].sort(
    (a, b) => b.fakerTurns - a.fakerTurns
  )[0];

  if (bluffer && bluffer.fakerTurns > 0) {
    room.awards.push({
      title: "Master Bluffer",
      name: bluffer.name,
      description: "Played the Faker role most often."
    });
  }

  room.awards.push({
    title: "Emoji Genius",
    name: "Fakemoji",
    description: "Three emojis. Endless possibilities."
  });

  room.scoreboard = sorted.map(p => ({
    id: p.id,
    name: p.name,
    score: p.score
  }));

  emitRoom(room);
}

// --------------------------------------------------
// HOST MANAGEMENT
// --------------------------------------------------

function promoteHost(room) {
  const next = room.players.find(p => p.connected);

  room.hostId = next ? next.id : null;

  if (!next) {
    clearTimer(room);
    rooms.delete(room.code);
  }
}

// --------------------------------------------------
// ROUND CANCELLATION
// --------------------------------------------------

function cancelRound(room, reason) {
  clearTimer(room);

  room.phase = "lobby";
  room.message = reason;

  room.fakerId = null;
  room.secretWord = null;
  room.roundPlayers = [];
  room.emojis = {};
  room.votes = {};
  room.deadline = null;

  emitRoom(room);
}

// --------------------------------------------------
// SOCKET REGISTRATION AND RECONNECTION
// --------------------------------------------------

function registerPlayer(socket, room, player, token) {
  // Assign the new socket before any old socket
  // disconnect event can process.
  player.socketId = socket.id;
  player.connected = true;
  player.disconnectedAt = null;

  socket.data.roomCode = room.code;
  socket.data.token = token;

  socket.join(room.code);

  emitRoom(room);
}

// --------------------------------------------------
// SOCKET EVENTS
// --------------------------------------------------

io.on("connection", socket => {

  socket.on("createRoom", ({ name, token, rounds, category }) => {

    if (typeof name !== "string" || !name.trim()) {
      return socket.emit("errorMessage", "Enter a nickname.");
    }

    if (typeof token !== "string" || token.length < 16) {
      return socket.emit("errorMessage", "Invalid session token.");
    }

    const code = randomCode();

    const room = {
      code,
      players: [],
      hostId: null,
      phase: "lobby",

      rounds: [3, 5, 8].includes(Number(rounds))
        ? Number(rounds)
        : 3,

      currentRound: 0,
      category: BOARDS[category] ? category : "Food",

      board: [],
      secretWord: null,
      fakerId: null,
      fakerQueue: [],

      roundPlayers: [],
      emojis: {},
      votes: {},
      roundPoints: {},

      results: null,
      lastRound: null,
      awards: [],

      deadline: null,
      timer: null,
      message: ""
    };

    const player = {
      id: randomToken(),
      token,
      name: name.trim().slice(0, 20),
      socketId: socket.id,
      connected: true,
      disconnectedAt: null,
      score: 0,
      fakerTurns: 0,
      correctVotes: 0,
      late: false
    };

    room.hostId = player.id;
    room.players.push(player);

    rooms.set(code, room);

    registerPlayer(socket, room, player, token);

    socket.emit("joined", {
      code,
      token,
      invite: `/?room=${code}`
    });
  });

  socket.on("joinRoom", ({ code, name, token }) => {

    code = String(code || "").toUpperCase();

    const room = rooms.get(code);

    if (!room) {
      return socket.emit("errorMessage", "Room not found.");
    }

    if (typeof name !== "string" || !name.trim()) {
      return socket.emit("errorMessage", "Enter a nickname.");
    }

    if (typeof token !== "string" || token.length < 16) {
      return socket.emit("errorMessage", "Invalid session token.");
    }

    let player = getPlayer(room, token);

    if (!player) {

      if (room.players.length >= 8) {
        return socket.emit("errorMessage", "Room is full.");
      }

      player = {
        id: randomToken(),
        token,
        name: name.trim().slice(0, 20),
        socketId: socket.id,
        connected: true,
        disconnectedAt: null,
        score: 0,
        fakerTurns: 0,
        correctVotes: 0,
        late: room.phase !== "lobby"
      };

      room.players.push(player);

    } else {

      // Reclaim the existing seat.
      // This also invalidates the old socket.
      player.name = name.trim().slice(0, 20);

    }

    registerPlayer(socket, room, player, token);

    socket.emit("joined", {
      code,
      token,
      invite: `/?room=${code}`
    });
  });

  // ------------------------------------------------
  // START GAME
  // ------------------------------------------------

  socket.on("startGame", () => {

    const room = rooms.get(socket.data.roomCode);
    if (!room) return;

    const player = getPlayer(room, socket.data.token);

    if (!player || player.id !== room.hostId) {
      return socket.emit(
        "errorMessage",
        "Only the host can start."
      );
    }

    if (room.phase !== "lobby") return;

    if (connectedPlayers(room).length < 3) {
      return socket.emit(
        "errorMessage",
        "At least 3 players are needed to start."
      );
    }

    room.players.forEach(p => {
      p.score = 0;
      p.fakerTurns = 0;
      p.correctVotes = 0;
    });

    room.currentRound = 0;
    room.fakerQueue = [];
    room.awards = [];

    startRound(room);
  });

  // ------------------------------------------------
  // HOST SETTINGS
  // ------------------------------------------------

  socket.on("updateSettings", ({ rounds, category }) => {

    const room = rooms.get(socket.data.roomCode);

    if (!room || room.phase !== "lobby") return;

    const player = getPlayer(room, socket.data.token);

    if (!player || player.id !== room.hostId) return;

    if ([3, 5, 8].includes(Number(rounds))) {
      room.rounds = Number(rounds);
    }

    if (BOARDS[category]) {
      room.category = category;
    }

    emitRoom(room);
  });

  // ------------------------------------------------
  // EMOJI SUBMISSION
  // ------------------------------------------------

  socket.on("submitEmojis", emojis => {

    const room = rooms.get(socket.data.roomCode);

    if (!room || room.phase !== "picking") return;

    const player = getPlayer(room, socket.data.token);

    if (!player || !room.roundPlayers.includes(player.id)) {
      return;
    }

    if (room.emojis[player.id] !== undefined) return;

    if (
      !Array.isArray(emojis) ||
      emojis.length !== 3 ||
      new Set(emojis).size !== 3 ||
      !emojis.every(e => ALLOWED_EMOJIS.has(e))
    ) {
      return socket.emit(
        "errorMessage",
        "Choose exactly 3 different emojis from the picker."
      );
    }

    room.emojis[player.id] = emojis;

    if (
      room.roundPlayers.every(id =>
        room.emojis[id] !== undefined
      )
    ) {
      endPicking(room);
    } else {
      emitRoom(room);
    }
  });

  // ------------------------------------------------
  // VOTING
  // ------------------------------------------------

  socket.on("submitVote", targetId => {

    const room = rooms.get(socket.data.roomCode);

    if (!room || room.phase !== "voting") return;

    const player = getPlayer(room, socket.data.token);

    if (
      !player ||
      !room.roundPlayers.includes(player.id) ||
      targetId === player.id ||
      !room.roundPlayers.includes(targetId)
    ) {
      return socket.emit("errorMessage", "Invalid vote.");
    }

    // Players may change their vote until the timer ends.
    room.votes[player.id] = targetId;

    if (
      room.roundPlayers.every(id =>
        room.votes[id] !== undefined
      )
    ) {
      endVoting(room);
    } else {
      emitRoom(room);
    }
  });

  // ------------------------------------------------
  // FAKER GUESS
  // ------------------------------------------------

  socket.on("submitGuess", word => {

    const room = rooms.get(socket.data.roomCode);

    if (!room || room.phase !== "guessing") return;

    const player = getPlayer(room, socket.data.token);

    if (!player || player.id !== room.fakerId) {
      return socket.emit(
        "errorMessage",
        "Only the Faker can guess."
      );
    }

    if (!room.board.includes(word)) {
      return socket.emit(
        "errorMessage",
        "Choose a word from the board."
      );
    }

    resolveGuess(room, word);
  });

  // ------------------------------------------------
  // PLAY AGAIN
  // ------------------------------------------------

  socket.on("playAgain", () => {

    const room = rooms.get(socket.data.roomCode);

    if (!room || room.phase !== "finished") return;

    const player = getPlayer(room, socket.data.token);

    if (!player || player.id !== room.hostId) return;

    room.currentRound = 0;
    room.fakerQueue = [];

    room.players.forEach(p => {
      p.score = 0;
      p.fakerTurns = 0;
      p.correctVotes = 0;
    });

    startRound(room);
  });

  // ------------------------------------------------
  // VOLUNTARY LEAVE
  // ------------------------------------------------

  socket.on("leaveRoom", () => {
    disconnectPlayer(socket, true);
  });

  // ------------------------------------------------
  // UNEXPECTED DISCONNECT
  // ------------------------------------------------

  socket.on("disconnect", () => {
    disconnectPlayer(socket, false);
  });

});

// --------------------------------------------------
// FIXED DISCONNECT HANDLER
// --------------------------------------------------

function disconnectPlayer(socket, voluntary) {

  const code = socket.data.roomCode;
  const token = socket.data.token;

  if (!code || !token) return;

  const room = rooms.get(code);
  if (!room) return;

  const player = getPlayer(room, token);

  if (!player) return;

  // FIX 1:
  // Ignore disconnect events from old sockets.
  // If the player has already reconnected, their
  // current socket ID will be different.
  if (!voluntary && player.socketId !== socket.id) {
    return;
  }

  // ------------------------------------------------
  // VOLUNTARY LEAVE: IMMEDIATE ACTION
  // ------------------------------------------------

  if (voluntary) {

    const wasHost = player.id === room.hostId;
    const wasFaker = player.id === room.fakerId;

    player.connected = false;
    player.socketId = null;

    // Remove the player immediately.
    room.players = room.players.filter(
      p => p.id !== player.id
    );

    if (wasFaker && room.phase !== "lobby") {
      cancelRound(
        room,
        "The Faker left. This round was cancelled."
      );
    }

    if (wasHost) {
      promoteHost(room);
    }

    if (room.players.length === 0) {
      clearTimer(room);
      rooms.delete(code);
      return;
    }

    emitRoom(room);
    return;
  }

  // ------------------------------------------------
  // UNEXPECTED DISCONNECT: START GRACE PERIOD
  // ------------------------------------------------

  player.connected = false;
  player.socketId = null;
  player.disconnectedAt = Date.now();

  const disconnectTimestamp = player.disconnectedAt;
  const playerId = player.id;

  // Keep the room and round running during the
  // 30-second reconnection grace period.
  emitRoom(room);

  // FIX 2:
  // Only handle the disconnect after 30 seconds,
  // and only if this player has not reconnected.
  setTimeout(() => {

    // The room may have been deleted meanwhile.
    if (rooms.get(code) !== room) return;

    const currentPlayer = room.players.find(
      p => p.id === playerId
    );

    if (!currentPlayer) return;

    // Player successfully reconnected.
    if (currentPlayer.connected) return;

    // A newer disconnect event replaced this one.
    if (
      currentPlayer.disconnectedAt !== disconnectTimestamp
    ) {
      return;
    }

    // Confirm that the player is still disconnected.
    if (currentPlayer.socketId !== null) return;

    const wasHost = currentPlayer.id === room.hostId;
    const wasFaker = currentPlayer.id === room.fakerId;

    // If the disconnected player was the Faker,
    // cancel the round after the grace period.
    if (wasFaker && room.phase !== "lobby") {
      cancelRound(
        room,
        "The Faker disconnected and did not reconnect within 30 seconds. This round was cancelled."
      );
    }

    // If the disconnected player was the host,
    // transfer host privileges after the grace period.
    if (wasHost) {
      promoteHost(room);
    }

    emitRoom(room);

  }, RECONNECT_GRACE_PERIOD);
}

// --------------------------------------------------
// DISCONNECTED SEAT CLEANUP
// --------------------------------------------------

setInterval(() => {

  for (const [code, room] of rooms) {

    const cutoff = Date.now() - SEAT_RETENTION_PERIOD;

    const expired = room.players.filter(p =>
      !p.connected &&
      p.disconnectedAt &&
      p.disconnectedAt < cutoff
    );

    expired.forEach(p => {

      // Do not remove a player who has reconnected.
      if (p.connected) return;

      room.players = room.players.filter(
        x => x.id !== p.id
      );

      // If a disconnected Faker's seat expires,
      // cancel the active round.
      if (
        p.id === room.fakerId &&
        room.phase !== "lobby"
      ) {
        cancelRound(
          room,
          "The Faker's seat expired. This round was cancelled."
        );
      }

      if (p.id === room.hostId) {
        promoteHost(room);
      }

    });

    if (!room.players.length) {
      clearTimer(room);
      rooms.delete(code);
    } else if (expired.length) {
      emitRoom(room);
    }
  }

}, 30000);

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Fakemoji running on port ${PORT}`);
});
