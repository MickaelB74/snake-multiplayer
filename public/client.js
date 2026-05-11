/**
 * Client Snake Multijoueur
 * - Gère la connexion WebSocket et les messages échangés avec le serveur
 * - Affiche les différents écrans (menu, lobby, jeu, fin de partie)
 * - Dessine les grilles de tous les joueurs en temps réel sur des canvas
 */

// ===== État global du client =====
const state = {
  ws: null,             // Instance WebSocket
  playerId: null,       // ID assigné par le serveur à cette connexion
  roomCode: null,       // Code de la salle actuelle
  isHost: false,        // Suis-je l'hôte de la salle ?
  players: [],          // Liste des joueurs (mise à jour à chaque tick)
  gridSize: 20,         // Taille de la grille de jeu
  inGame: false,        // Suis-je dans une partie en cours ?
  reconnectAttempts: 0, // Compteur pour la reconnexion exponentielle
};

// Mapping playerId -> élément <canvas> pour ne pas recréer le DOM à chaque tick
// (conservé pour rétro-compatibilité ; en mode solo non utilisé activement)
const canvasMap = new Map();

// Dernière direction envoyée (anti-spam : évite d'envoyer plusieurs fois la même)
let lastDirection = null;

// ===== Sélecteurs DOM (récupérés une fois) =====
const $ = (id) => document.getElementById(id);

const screens = {
  menu: $('screen-menu'),
  lobby: $('screen-lobby'),
  game: $('screen-game'),
  gameover: $('screen-gameover'),
};

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
}

// ===== Connexion WebSocket =====
// On utilise wss:// en production (HTTPS), ws:// en local (HTTP)
// Le path /ws correspond à celui défini côté serveur
function connect() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${window.location.host}/ws`;

  $('connection-status').textContent = 'Connexion au serveur...';
  $('connection-status').className = 'status';

  state.ws = new WebSocket(url);

  state.ws.addEventListener('open', () => {
    state.reconnectAttempts = 0;
    $('connection-status').textContent = '✓ Connecté';
    $('connection-status').className = 'status connected';
  });

  state.ws.addEventListener('message', (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch (e) { return; }
    handleServerMessage(msg);
  });

  state.ws.addEventListener('close', () => {
    $('connection-status').textContent = '✗ Déconnecté - reconnexion...';
    $('connection-status').className = 'status disconnected';
    scheduleReconnect();
  });

  state.ws.addEventListener('error', () => {
    // L'événement close suivra et déclenchera la reconnexion
  });
}

/** Reconnexion avec backoff exponentiel (recommandé par la doc Render) */
function scheduleReconnect() {
  state.reconnectAttempts++;
  const delay = Math.min(1000 * Math.pow(2, state.reconnectAttempts - 1), 10000);
  setTimeout(connect, delay);
}

/** Envoie un message au serveur (uniquement si la socket est ouverte) */
function send(data) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(data));
  }
}

// ===== Routage des messages reçus du serveur =====
function handleServerMessage(msg) {
  switch (msg.type) {
    case 'connected':
      state.playerId = msg.playerId;
      break;

    case 'room_created':
    case 'room_joined':
      state.roomCode = msg.code;
      $('room-code').textContent = msg.code;
      showScreen('lobby');
      break;

    case 'lobby':
      updateLobby(msg);
      break;

    case 'error':
      showError(msg.message);
      break;

    case 'game_started':
      state.gridSize = msg.gridSize;
      state.players = msg.players;
      state.inGame = true;
      lastDirection = null;  // Reset pour permettre tous les premiers inputs
      buildGameUI();
      showScreen('game');
      $('waiting-overlay').classList.add('hidden');
      break;

    case 'state':
      // Mise à jour de l'état du jeu : on redessine les grilles
      state.players = msg.players;
      renderGameState();
      break;

    case 'you_died':
      // Le serveur nous informe qu'on est mort : on affiche l'overlay
      $('final-score').textContent = msg.score;
      $('waiting-overlay').classList.remove('hidden');
      break;

    case 'game_over':
      state.inGame = false;
      showGameOver(msg);
      break;

    case 'player_left':
      // On peut afficher une notification ; pour rester simple, on l'ignore visuellement.
      // Le prochain message 'state' reflètera la disparition du joueur.
      break;

    case 'left_room':
      // Le serveur a confirmé que nous avons quitté la salle
      state.roomCode = null;
      state.isHost = false;
      showScreen('menu');
      break;

    case 'server_shutdown':
      showError('Le serveur redémarre, reconnecte-toi dans quelques secondes');
      break;
  }
}

// ===== ÉCRAN MENU =====

$('btn-create').addEventListener('click', () => {
  const name = $('input-name').value.trim() || 'Joueur';
  send({ type: 'create_room', name });
  state.isHost = true;
});

$('btn-join').addEventListener('click', () => {
  const name = $('input-name').value.trim() || 'Joueur';
  const code = $('input-code').value.trim().toUpperCase();
  if (!code) {
    showError('Entre un code de partie');
    return;
  }
  send({ type: 'join_room', name, code });
  state.isHost = false;
});

// Auto-uppercase du code de partie
$('input-code').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase();
});

function showError(message) {
  const el = $('menu-error');
  el.textContent = message;
  setTimeout(() => { if (el.textContent === message) el.textContent = ''; }, 4000);
}

// ===== ÉCRAN LOBBY =====

function updateLobby(msg) {
  state.isHost = (msg.hostId === state.playerId);

  const list = $('player-list');
  list.innerHTML = '';

  for (const player of msg.players) {
    const li = document.createElement('li');
    const isYou = player.id === state.playerId;
    const isHost = player.id === msg.hostId;

    li.innerHTML = `
      <span class="color-dot" style="background:${player.color}"></span>
      <span>${escapeHtml(player.name)}</span>
      ${isYou ? '<span class="you-badge">VOUS</span>' : ''}
      ${isHost ? '<span class="host-badge">HÔTE</span>' : ''}
    `;
    list.appendChild(li);
  }

  $('player-count').textContent = msg.players.length;

  // Le bouton "Lancer" n'est actif que pour l'hôte, et seulement s'il y a >= 1 joueur
  const btnStart = $('btn-start');
  btnStart.disabled = !state.isHost || msg.players.length < 1;

  // Message d'info contextuel
  const info = $('lobby-info');
  if (!state.isHost) {
    info.textContent = "En attente que l'hôte lance la partie...";
  } else if (msg.players.length < 2) {
    info.textContent = 'Partage le code avec tes amis pour jouer à plusieurs !';
  } else {
    info.textContent = '';
  }
}

$('btn-start').addEventListener('click', () => {
  send({ type: 'start_game' });
});

$('btn-leave').addEventListener('click', () => {
  send({ type: 'leave_room' });
});

$('btn-copy-code').addEventListener('click', async () => {
  const code = $('room-code').textContent;
  try {
    await navigator.clipboard.writeText(code);
    $('btn-copy-code').textContent = '✓ Copié !';
    setTimeout(() => { $('btn-copy-code').textContent = '📋 Copier'; }, 2000);
  } catch (e) {
    // Si clipboard API indisponible (HTTP non-sécurisé), on ne fait rien de plus
  }
});

// ===== ÉCRAN JEU : construction de l'UI =====

/** Initialise l'écran de jeu : un seul canvas pour le joueur courant */
function buildGameUI() {
  const me = state.players.find(p => p.id === state.playerId);
  if (!me) return;

  // Affiche le nom et la couleur du joueur dans le header
  $('my-name').textContent = me.name + (me.id === state.playerId ? ' (vous)' : '');
  $('my-color-dot').style.background = me.color;
  $('my-score').textContent = '0';

  // Ferme le scoreboard s'il était ouvert
  $('scoreboard-panel').classList.remove('open');
}

/** Redessine la grille du joueur et met à jour le scoreboard */
function renderGameState() {
  if (!state.inGame) return;

  // Trouver MON joueur dans la liste reçue
  const me = state.players.find(p => p.id === state.playerId);
  if (me) {
    drawPlayerGrid($('my-canvas'), me);
    $('my-score').textContent = me.score || 0;
  }

  updateScoreboard();
  updateOverlayStatus();
}

/** Met à jour la liste de statut des autres joueurs dans l'overlay "tu es mort" */
function updateOverlayStatus() {
  const overlay = $('waiting-overlay');
  if (overlay.classList.contains('hidden')) return;

  const list = $('overlay-status');
  list.innerHTML = '';

  // Affiche tous les joueurs sauf moi, en indiquant qui est encore en vie
  const others = state.players.filter(p => p.id !== state.playerId);
  for (const p of others) {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="color-dot" style="background:${p.color}"></span>
      <span>${escapeHtml(p.name)}</span>
      <span class="${p.alive ? 'status-alive' : 'status-dead'}">
        ${p.alive ? '🐍 en vie' : '💀 mort'}
      </span>
    `;
    list.appendChild(li);
  }
}

/** Dessine la grille du joueur sur son canvas (taille dynamique) */
function drawPlayerGrid(canvas, player) {
  // Resize logique du canvas pour suivre la taille réelle (devicePixelRatio pour netteté)
  // On le fait à chaque frame pour gérer les rotations / resize d'écran sans handler dédié
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const cssSize = Math.floor(rect.width);
  const pixelSize = Math.floor(cssSize * dpr);
  if (canvas.width !== pixelSize) {
    canvas.width = pixelSize;
    canvas.height = pixelSize;
  }

  const ctx = canvas.getContext('2d');
  const size = canvas.width;
  const cellSize = size / state.gridSize;

  // Fond
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, size, size);

  // Quadrillage léger (purement esthétique)
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  for (let i = 1; i < state.gridSize; i++) {
    ctx.beginPath();
    ctx.moveTo(i * cellSize, 0);
    ctx.lineTo(i * cellSize, size);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i * cellSize);
    ctx.lineTo(size, i * cellSize);
    ctx.stroke();
  }

  // Nourriture (cercle rouge)
  if (player.food && player.alive) {
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    const cx = player.food.x * cellSize + cellSize / 2;
    const cy = player.food.y * cellSize + cellSize / 2;
    ctx.arc(cx, cy, cellSize * 0.4, 0, Math.PI * 2);
    ctx.fill();
  }

  // Serpent : la tête est plus claire, le corps est de la couleur du joueur
  if (player.snake && player.snake.length > 0) {
    for (let i = 0; i < player.snake.length; i++) {
      const seg = player.snake[i];
      ctx.fillStyle = i === 0
        ? lightenColor(player.color, 40)  // Tête plus claire
        : player.color;
      // Padding proportionnel pour visualiser les segments distincts
      const pad = Math.max(1, cellSize * 0.08);
      ctx.fillRect(
        seg.x * cellSize + pad,
        seg.y * cellSize + pad,
        cellSize - pad * 2,
        cellSize - pad * 2
      );
    }
  }

  // Si le joueur est mort, on grise la grille avec un overlay sombre
  if (!player.alive) {
    ctx.fillStyle = 'rgba(15, 23, 42, 0.7)';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#ef4444';
    ctx.font = `bold ${Math.floor(size / 6)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('💀', size / 2, size / 2);
  }
}

/** Éclaircit une couleur hex pour la tête du serpent */
function lightenColor(hex, percent) {
  const num = parseInt(hex.replace('#', ''), 16);
  const r = Math.min(255, ((num >> 16) & 0xff) + percent);
  const g = Math.min(255, ((num >> 8) & 0xff) + percent);
  const b = Math.min(255, (num & 0xff) + percent);
  return `rgb(${r},${g},${b})`;
}

/** Met à jour la sidebar de scores (triée : vivants > morts, score décroissant) */
function updateScoreboard() {
  const list = $('scoreboard');
  list.innerHTML = '';

  const sorted = [...state.players].sort((a, b) => {
    // Vivants d'abord
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    // Puis par score décroissant
    return b.score - a.score;
  });

  sorted.forEach((p, idx) => {
    const li = document.createElement('li');
    if (!p.alive) li.classList.add('dead');
    if (p.id === state.playerId) li.classList.add('me');
    li.innerHTML = `
      <span class="rank">${idx + 1}</span>
      <span class="color-dot" style="background:${p.color}"></span>
      <span class="name">${escapeHtml(p.name)}${p.id === state.playerId ? ' (vous)' : ''}${!p.alive ? ' 💀' : ''}</span>
      <span class="score">${p.score}</span>
    `;
    list.appendChild(li);
  });
}

// ===== Contrôles =====

/** Envoie une direction au serveur (factorisé entre clavier et tactile) */
function sendDirection(dir) {
  if (!state.inGame) return;
  if (dir === lastDirection) return;
  lastDirection = dir;
  send({ type: 'direction', direction: dir });
}

// --- Clavier (desktop) ---
document.addEventListener('keydown', (e) => {
  if (!state.inGame) return;

  let dir = null;
  switch (e.key) {
    case 'ArrowUp': case 'z': case 'Z': case 'w': case 'W': dir = 'up'; break;
    case 'ArrowDown': case 's': case 'S': dir = 'down'; break;
    case 'ArrowLeft': case 'q': case 'Q': case 'a': case 'A': dir = 'left'; break;
    case 'ArrowRight': case 'd': case 'D': dir = 'right'; break;
  }

  if (dir) {
    sendDirection(dir);
    e.preventDefault();
  }
});

// --- Boutons tactiles (mobile) ---
// On utilise pointerdown qui couvre touch + souris, plus réactif que click
document.querySelectorAll('.touch-btn').forEach(btn => {
  const handler = (e) => {
    e.preventDefault();
    const dir = btn.dataset.dir;
    if (dir) sendDirection(dir);
  };
  // pointerdown = réactif dès le toucher (pas d'attente du tap "click")
  btn.addEventListener('pointerdown', handler);
});

// --- Swipe tactile sur le canvas (alternative aux boutons) ---
// Permet de jouer en glissant le doigt sur la grille, plus intuitif
let touchStart = null;
const canvas = $('my-canvas');
canvas.addEventListener('touchstart', (e) => {
  if (e.touches.length !== 1) return;
  touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
}, { passive: true });

canvas.addEventListener('touchmove', (e) => {
  if (!touchStart || e.touches.length !== 1) return;
  const dx = e.touches[0].clientX - touchStart.x;
  const dy = e.touches[0].clientY - touchStart.y;
  const threshold = 25; // pixels avant de déclencher un swipe
  if (Math.abs(dx) < threshold && Math.abs(dy) < threshold) return;

  // Direction dominante
  if (Math.abs(dx) > Math.abs(dy)) {
    sendDirection(dx > 0 ? 'right' : 'left');
  } else {
    sendDirection(dy > 0 ? 'down' : 'up');
  }
  // Réinitialise pour permettre des swipes consécutifs
  touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
}, { passive: true });

canvas.addEventListener('touchend', () => { touchStart = null; }, { passive: true });

// --- Toggle scoreboard latéral (mobile) ---
$('btn-toggle-scoreboard').addEventListener('click', () => {
  $('scoreboard-panel').classList.add('open');
});
$('btn-close-scoreboard').addEventListener('click', () => {
  $('scoreboard-panel').classList.remove('open');
});

// ===== ÉCRAN FIN DE PARTIE =====

function showGameOver(msg) {
  showScreen('gameover');

  const winner = msg.ranking.find(p => p.id === msg.winnerId);
  if (winner) {
    if (winner.id === state.playerId) {
      $('gameover-title').textContent = '🏆 Victoire !';
      $('gameover-winner').textContent = `Tu as gagné avec ${winner.score} points !`;
    } else {
      $('gameover-title').textContent = '🏁 Partie terminée';
      $('gameover-winner').textContent = `${winner.name} remporte la partie !`;
    }
  } else {
    $('gameover-title').textContent = 'Partie terminée';
    $('gameover-winner').textContent = '';
  }

  // Classement final
  const list = $('final-ranking');
  list.innerHTML = '';
  for (const p of msg.ranking) {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="color-dot" style="background:${p.color}"></span>
      <span class="name">${escapeHtml(p.name)}${p.id === state.playerId ? ' (vous)' : ''}</span>
      <span class="score">${p.score} pts</span>
    `;
    list.appendChild(li);
  }
}

$('btn-replay').addEventListener('click', () => {
  // Retour au lobby : la room existe toujours côté serveur (statut waiting)
  showScreen('lobby');
});

$('btn-quit').addEventListener('click', () => {
  send({ type: 'leave_room' });
  // Le serveur répondra 'left_room' qui nous ramènera au menu
});

// ===== Utilitaire : échappement HTML (sécurité XSS basique sur les pseudos) =====
function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ===== Démarrage =====
connect();
