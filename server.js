/**
 * Serveur principal du jeu Snake Multijoueur
 * - Express sert les fichiers statiques (frontend)
 * - WebSocket (ws) gère la communication temps réel
 * - Chaque "Room" héberge une partie indépendante avec plusieurs joueurs
 * - Chaque joueur joue sur sa propre grille personnelle, en concurrence
 */

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const crypto = require('crypto');

// ===== Configuration =====
const PORT = process.env.PORT || 10000; // Render attend par défaut le port 10000
const GRID_SIZE = 20;            // Grille 20x20 pour chaque joueur
const TICK_RATE_MS = 120;        // Vitesse du jeu (ms entre chaque tick)
const MAX_PLAYERS_PER_ROOM = 8;  // Limite raisonnable par partie
const ROOM_CODE_LENGTH = 5;      // Longueur du code de partie

// ===== Initialisation Express =====
const app = express();
const server = http.createServer(app);

// Sert les fichiers statiques du frontend
app.use(express.static(path.join(__dirname, 'public')));

// Endpoint de health check requis par Render pour vérifier que le service est vivant
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', rooms: rooms.size });
});

// ===== Initialisation WebSocket =====
// On attache le serveur WebSocket au même serveur HTTP : un seul port,
// ce qui est requis par Render (un seul port exposé par web service)
const wss = new WebSocketServer({ server, path: '/ws' });

// ===== État global : toutes les parties actives =====
const rooms = new Map(); // roomCode -> Room

// ===== Utilitaires =====

/** Génère un code de partie court et lisible (ex: "A3F9K") */
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans caractères ambigus
  let code;
  do {
    code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      code += chars[crypto.randomInt(0, chars.length)];
    }
  } while (rooms.has(code));
  return code;
}

/** Envoie un message JSON sur une socket si elle est ouverte */
function sendTo(ws, data) {
  if (ws.readyState === 1 /* OPEN */) {
    ws.send(JSON.stringify(data));
  }
}

/** Diffuse un message à tous les joueurs d'une partie */
function broadcast(room, data) {
  const payload = JSON.stringify(data);
  for (const player of room.players.values()) {
    if (player.ws && player.ws.readyState === 1) {
      player.ws.send(payload);
    }
  }
}

/** Position aléatoire sur la grille */
function randomCell() {
  return {
    x: crypto.randomInt(0, GRID_SIZE),
    y: crypto.randomInt(0, GRID_SIZE),
  };
}

/** Génère une nouvelle position de nourriture qui ne chevauche pas le serpent */
function spawnFood(snake) {
  // On essaie au maximum 100 fois, sinon on accepte la collision (cas extrême)
  for (let i = 0; i < 100; i++) {
    const food = randomCell();
    if (!snake.some(seg => seg.x === food.x && seg.y === food.y)) {
      return food;
    }
  }
  return randomCell();
}

/** Couleurs distinctes assignées aux joueurs dans l'ordre de connexion */
const PLAYER_COLORS = [
  '#10b981', '#ef4444', '#3b82f6', '#f59e0b',
  '#a855f7', '#ec4899', '#14b8a6', '#f97316',
];

// ===== Classe Room : une partie =====

class Room {
  constructor(code, hostId) {
    this.code = code;
    this.hostId = hostId;          // ID du créateur (peut lancer la partie)
    this.players = new Map();      // playerId -> Player
    this.status = 'waiting';       // 'waiting' | 'playing' | 'finished'
    this.tickInterval = null;
    this.winner = null;
    this.createdAt = Date.now();
  }

  addPlayer(player) {
    if (this.players.size >= MAX_PLAYERS_PER_ROOM) return false;
    if (this.status !== 'waiting') return false;  // Pas de rejoinder en cours de partie
    // Couleur basée sur l'ordre d'arrivée
    player.color = PLAYER_COLORS[this.players.size % PLAYER_COLORS.length];
    this.players.set(player.id, player);
    return true;
  }

  removePlayer(playerId) {
    const player = this.players.get(playerId);
    if (!player) return;
    this.players.delete(playerId);
    // Si l'hôte part avant le lancement, on transfère à un autre joueur
    if (this.hostId === playerId && this.players.size > 0) {
      this.hostId = this.players.keys().next().value;
    }
  }

  /** Initialise l'état de jeu de tous les joueurs et démarre la boucle */
  start() {
    if (this.status !== 'waiting') return;
    if (this.players.size < 1) return;

    this.status = 'playing';
    this.winner = null;

    // Initialiser chaque serpent au centre de sa propre grille
    for (const player of this.players.values()) {
      const startX = Math.floor(GRID_SIZE / 2);
      const startY = Math.floor(GRID_SIZE / 2);
      player.snake = [
        { x: startX, y: startY },
        { x: startX - 1, y: startY },
        { x: startX - 2, y: startY },
      ];
      player.direction = 'right';
      player.nextDirection = 'right'; // Tampon pour éviter le demi-tour instantané
      player.food = spawnFood(player.snake);
      player.alive = true;
      player.score = 0;
      player.deathOrder = null; // Sera défini à la mort (pour le classement)
    }

    // Boucle de jeu : un tick toutes les TICK_RATE_MS millisecondes
    this.tickInterval = setInterval(() => this.tick(), TICK_RATE_MS);

    broadcast(this, {
      type: 'game_started',
      gridSize: GRID_SIZE,
      players: this.serializePlayers(),
    });
  }

  /** Un tick = chaque joueur vivant avance d'une case */
  tick() {
    let deathsThisTick = 0;

    for (const player of this.players.values()) {
      if (!player.alive) continue;

      // Application de la direction tamponnée (évite les demi-tours sur 1 tick)
      player.direction = player.nextDirection;

      // Calcul de la nouvelle tête
      const head = player.snake[0];
      const newHead = { x: head.x, y: head.y };
      switch (player.direction) {
        case 'up':    newHead.y -= 1; break;
        case 'down':  newHead.y += 1; break;
        case 'left':  newHead.x -= 1; break;
        case 'right': newHead.x += 1; break;
      }

      // Collision avec les murs (chaque joueur a sa carte personnelle)
      if (newHead.x < 0 || newHead.x >= GRID_SIZE ||
          newHead.y < 0 || newHead.y >= GRID_SIZE) {
        this.killPlayer(player);
        deathsThisTick++;
        continue;
      }

      // Collision avec son propre corps
      if (player.snake.some(seg => seg.x === newHead.x && seg.y === newHead.y)) {
        this.killPlayer(player);
        deathsThisTick++;
        continue;
      }

      // Avancer le serpent
      player.snake.unshift(newHead);

      // Manger de la nourriture ?
      if (newHead.x === player.food.x && newHead.y === player.food.y) {
        player.score += 10;
        player.food = spawnFood(player.snake);
        // On ne retire pas la queue : le serpent grandit
      } else {
        player.snake.pop(); // Avance normale : on retire la queue
      }
    }

    // Diffuser l'état complet à tous les joueurs
    broadcast(this, {
      type: 'state',
      players: this.serializePlayers(),
    });

    // Vérifier la condition de fin : 0 ou 1 joueur vivant
    const aliveCount = [...this.players.values()].filter(p => p.alive).length;
    if (aliveCount <= 1 && this.players.size > 1) {
      this.finish();
    } else if (aliveCount === 0 && this.players.size === 1) {
      // Cas solo : on termine quand le seul joueur meurt
      this.finish();
    }
  }

  /** Marque un joueur comme mort et lui assigne son rang de fin */
  killPlayer(player) {
    player.alive = false;
    // L'ordre de mort sert au classement : le dernier mort = meilleur classement
    const deathCount = [...this.players.values()].filter(p => p.deathOrder !== null).length;
    player.deathOrder = deathCount + 1;
    sendTo(player.ws, { type: 'you_died', score: player.score });
  }

  /** Termine la partie et envoie le scoreboard final */
  finish() {
    if (this.status !== 'playing') return;
    this.status = 'finished';
    clearInterval(this.tickInterval);
    this.tickInterval = null;

    // Le gagnant est soit le dernier vivant, soit le dernier mort (meilleur score / dernier)
    const alive = [...this.players.values()].filter(p => p.alive);
    if (alive.length === 1) {
      this.winner = alive[0].id;
      alive[0].deathOrder = this.players.size; // Marqué dernier (= 1er au classement)
    } else if (alive.length === 0) {
      // Tous morts : le gagnant est celui mort en dernier (deathOrder le plus haut)
      const sorted = [...this.players.values()].sort(
        (a, b) => (b.deathOrder || 0) - (a.deathOrder || 0)
      );
      this.winner = sorted[0]?.id || null;
    }

    // Classement : tri par deathOrder décroissant (mort plus tard = mieux classé),
    // puis par score décroissant à égalité
    const ranking = [...this.players.values()]
      .map(p => ({
        id: p.id,
        name: p.name,
        color: p.color,
        score: p.score,
        deathOrder: p.deathOrder || 0,
        alive: p.alive,
      }))
      .sort((a, b) => {
        if (b.deathOrder !== a.deathOrder) return b.deathOrder - a.deathOrder;
        return b.score - a.score;
      });

    broadcast(this, {
      type: 'game_over',
      winnerId: this.winner,
      ranking,
    });

    // Permettre de relancer une nouvelle partie depuis la même room
    this.status = 'waiting';
    for (const player of this.players.values()) {
      player.alive = false; // Pas en jeu tant que la prochaine partie n'a pas démarré
    }
  }

  /** Sérialise les joueurs pour envoi au client */
  serializePlayers() {
    return [...this.players.values()].map(p => ({
      id: p.id,
      name: p.name,
      color: p.color,
      snake: p.snake || [],
      food: p.food || null,
      score: p.score || 0,
      alive: p.alive,
    }));
  }

  /** État de la salle d'attente (avant lancement) */
  lobbyState() {
    return {
      type: 'lobby',
      code: this.code,
      hostId: this.hostId,
      status: this.status,
      players: [...this.players.values()].map(p => ({
        id: p.id, name: p.name, color: p.color,
      })),
    };
  }

  /** Nettoie la boucle si la salle est détruite */
  destroy() {
    if (this.tickInterval) clearInterval(this.tickInterval);
  }
}

// ===== Gestion des connexions WebSocket =====

wss.on('connection', (ws) => {
  // Chaque connexion = un joueur potentiel. ID généré côté serveur.
  const playerId = crypto.randomUUID();
  const player = {
    id: playerId,
    ws,
    name: 'Joueur',
    roomCode: null,
    color: '#10b981',
    snake: [],
    direction: 'right',
    nextDirection: 'right',
    food: null,
    score: 0,
    alive: false,
    deathOrder: null,
  };

  // On envoie au client son ID dès la connexion
  sendTo(ws, { type: 'connected', playerId });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      return; // Ignore les messages malformés
    }

    handleMessage(player, msg);
  });

  ws.on('close', () => {
    // Retirer le joueur de sa salle, et nettoyer la salle si vide
    if (player.roomCode) {
      const room = rooms.get(player.roomCode);
      if (room) {
        room.removePlayer(playerId);

        if (room.players.size === 0) {
          // Salle vide : on la supprime
          room.destroy();
          rooms.delete(room.code);
        } else {
          // Informer les autres joueurs de la déconnexion
          if (room.status === 'waiting') {
            broadcast(room, room.lobbyState());
          } else if (room.status === 'playing') {
            // Le joueur déconnecté est considéré mort
            broadcast(room, {
              type: 'player_left',
              playerId,
              name: player.name,
            });
            // Vérifier si la partie doit se terminer (1 ou 0 joueurs restants)
            const aliveCount = [...room.players.values()].filter(p => p.alive).length;
            if (aliveCount <= 1 && room.players.size > 0) {
              room.finish();
            }
          }
        }
      }
    }
  });

  // Le serveur répond automatiquement aux ping WebSocket (keepalive)
  // grâce à la bibliothèque ws — pas besoin de logique custom ici.
});

// ===== Routage des messages WebSocket =====

function handleMessage(player, msg) {
  switch (msg.type) {
    case 'create_room':
      handleCreateRoom(player, msg);
      break;
    case 'join_room':
      handleJoinRoom(player, msg);
      break;
    case 'start_game':
      handleStartGame(player);
      break;
    case 'direction':
      handleDirection(player, msg);
      break;
    case 'leave_room':
      handleLeaveRoom(player);
      break;
    default:
      // Type inconnu : ignoré silencieusement
      break;
  }
}

function handleCreateRoom(player, msg) {
  if (player.roomCode) return; // Déjà dans une salle
  player.name = sanitizeName(msg.name);

  const code = generateRoomCode();
  const room = new Room(code, player.id);
  room.addPlayer(player);
  player.roomCode = code;
  rooms.set(code, room);

  sendTo(player.ws, { type: 'room_created', code, playerId: player.id });
  broadcast(room, room.lobbyState());
}

function handleJoinRoom(player, msg) {
  if (player.roomCode) return;
  const code = (msg.code || '').toUpperCase().trim();
  const room = rooms.get(code);

  if (!room) {
    sendTo(player.ws, { type: 'error', message: 'Partie introuvable' });
    return;
  }
  if (room.status === 'playing') {
    sendTo(player.ws, { type: 'error', message: 'Partie déjà en cours' });
    return;
  }
  if (room.players.size >= MAX_PLAYERS_PER_ROOM) {
    sendTo(player.ws, { type: 'error', message: 'Partie complète' });
    return;
  }

  player.name = sanitizeName(msg.name);
  if (!room.addPlayer(player)) {
    sendTo(player.ws, { type: 'error', message: 'Impossible de rejoindre' });
    return;
  }
  player.roomCode = code;

  sendTo(player.ws, { type: 'room_joined', code, playerId: player.id });
  broadcast(room, room.lobbyState());
}

function handleStartGame(player) {
  if (!player.roomCode) return;
  const room = rooms.get(player.roomCode);
  if (!room) return;
  // Seul l'hôte peut lancer la partie
  if (room.hostId !== player.id) {
    sendTo(player.ws, { type: 'error', message: 'Seul l\'hôte peut lancer' });
    return;
  }
  room.start();
}

function handleDirection(player, msg) {
  if (!player.roomCode) return;
  const room = rooms.get(player.roomCode);
  if (!room || room.status !== 'playing') return;
  if (!player.alive) return;

  const dir = msg.direction;
  const valid = ['up', 'down', 'left', 'right'];
  if (!valid.includes(dir)) return;

  // Interdit le demi-tour instantané (qui causerait la mort immédiate)
  const opposite = { up: 'down', down: 'up', left: 'right', right: 'left' };
  if (opposite[dir] === player.direction) return;

  player.nextDirection = dir;
}

function handleLeaveRoom(player) {
  if (!player.roomCode) return;
  const room = rooms.get(player.roomCode);
  if (!room) return;

  room.removePlayer(player.id);
  player.roomCode = null;

  if (room.players.size === 0) {
    room.destroy();
    rooms.delete(room.code);
  } else {
    broadcast(room, room.lobbyState());
  }
  sendTo(player.ws, { type: 'left_room' });
}

/** Nettoie le nom du joueur (sécurité de base contre les abus) */
function sanitizeName(name) {
  if (typeof name !== 'string') return 'Joueur';
  const cleaned = name.trim().slice(0, 16);
  return cleaned.length > 0 ? cleaned : 'Joueur';
}

// ===== Démarrage du serveur =====
// IMPORTANT: bind sur 0.0.0.0 requis par Render
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Snake Multijoueur démarré sur le port ${PORT}`);
  console.log(`HTTP : http://0.0.0.0:${PORT}`);
  console.log(`WS   : ws://0.0.0.0:${PORT}/ws`);
});

// ===== Graceful shutdown (Render envoie SIGTERM lors des déploiements) =====
// On ferme proprement les connexions WebSocket pour éviter de corrompre les parties
function gracefulShutdown(signal) {
  console.log(`Signal ${signal} reçu, arrêt en cours...`);

  // 1. Notifier tous les clients que le serveur s'arrête
  for (const room of rooms.values()) {
    broadcast(room, { type: 'server_shutdown', message: 'Le serveur redémarre' });
    room.destroy();
  }

  // 2. Fermer le serveur WebSocket
  wss.close(() => {
    console.log('WebSocket fermé');
  });

  // 3. Fermer le serveur HTTP (arrête d'accepter de nouvelles connexions)
  server.close(() => {
    console.log('Serveur HTTP fermé proprement');
    process.exit(0);
  });

  // 4. Forcer l'arrêt après 25s si le close traîne (Render donne 30s)
  setTimeout(() => {
    console.log('Arrêt forcé après timeout');
    process.exit(1);
  }, 25000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
