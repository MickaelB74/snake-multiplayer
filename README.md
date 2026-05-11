# 🐍 Snake Multijoueur

Jeu Snake multijoueur temps réel avec WebSocket. Plusieurs parties simultanées, chaque joueur joue sur sa propre carte, le dernier survivant gagne.

## ✨ Fonctionnalités

- **Multijoueur temps réel** via WebSocket natif (`ws`)
- **Plusieurs parties simultanées** : chaque salle est isolée par un code unique (ex: `A3F9K`)
- **Cartes personnelles** : chaque joueur a sa propre grille 20×20
- **Mode élimination** : à la mort, le joueur attend les autres ; le dernier en vie remporte la partie
- **Scoreboard live** mis à jour à chaque tick
- **Classement final** avec ordre d'élimination
- **Prêt pour production** : graceful shutdown, health check, reconnexion auto avec backoff

## 🚀 Lancement local

```bash
npm install
npm start
```

Puis ouvrir [http://localhost:10000](http://localhost:10000) dans plusieurs onglets pour simuler plusieurs joueurs.

## 📦 Structure du projet

```
snake-multiplayer/
├── server.js              # Serveur Express + WebSocket + logique de jeu
├── package.json
├── render.yaml            # Configuration Render (déploiement automatique)
├── public/
│   ├── index.html         # 4 écrans : menu, lobby, jeu, fin de partie
│   ├── style.css          # Styles (dark mode, responsive)
│   └── client.js          # Client WebSocket + rendu Canvas
└── README.md
```

## 🌐 Déploiement sur Render.com

### Option 1 : Déploiement via Blueprint (recommandé)

1. Pousse ce projet sur un dépôt GitHub/GitLab
2. Sur [render.com](https://render.com), clique sur **New → Blueprint**
3. Connecte ton dépôt : Render détecte automatiquement `render.yaml`
4. Clique sur **Apply** → le service se déploie

### Option 2 : Déploiement manuel

1. Sur [render.com](https://render.com), clique sur **New → Web Service**
2. Connecte ton dépôt Git
3. Configure :
   - **Runtime** : `Node`
   - **Build Command** : `npm install`
   - **Start Command** : `node server.js`
   - **Health Check Path** : `/health`
4. Clique sur **Create Web Service**

### Configuration importante

- Le serveur écoute sur `process.env.PORT` (Render fournit la variable automatiquement, par défaut 10000)
- Il bind sur `0.0.0.0` (obligatoire sur Render pour être joignable)
- Le WebSocket utilise le même port HTTP, sur le chemin `/ws` (un seul port exposé par service)
- En production, le client utilise automatiquement `wss://` (TLS terminé par Render)

### ⚠️ À propos du plan Free de Render

Le plan gratuit met le service en veille après 15 minutes d'inactivité, ce qui interrompra les WebSocket. Pour une utilisation sérieuse, passe au plan **Starter** (~7$/mois).

## 🎮 Comment jouer

1. Entre ton pseudo
2. **Créer une partie** : tu obtiens un code à 5 caractères à partager
3. **Rejoindre une partie** : entre le code reçu d'un ami
4. L'hôte clique sur **Lancer la partie** quand tout le monde est prêt
5. Contrôles : flèches directionnelles ou `Z`/`Q`/`S`/`D`
6. À ta mort, tu attends les autres joueurs
7. Le dernier survivant remporte la partie

## 🔧 Configuration

Variables ajustables dans `server.js` :

| Variable | Défaut | Description |
|----------|--------|-------------|
| `PORT` | 10000 | Port HTTP/WebSocket |
| `GRID_SIZE` | 20 | Taille de la grille de chaque joueur |
| `TICK_RATE_MS` | 120 | Vitesse du jeu (ms entre chaque tick) |
| `MAX_PLAYERS_PER_ROOM` | 8 | Nombre max de joueurs par partie |

## 🛡️ Production

Le serveur intègre :

- **Graceful shutdown** sur `SIGTERM` (Render envoie ce signal lors des déploiements) avec 25s de délai
- **Health check** sur `/health` (utilisé par Render pour vérifier la santé du service)
- **Reconnexion automatique** côté client avec backoff exponentiel
- **Validation des entrées** : pseudos sanitisés, directions vérifiées, anti-flood naturel via WebSocket
- **Échappement HTML** côté client pour éviter les XSS via les pseudos

## 📈 Pour aller plus loin

- Scaling horizontal : avec plusieurs instances, il faudrait introduire Redis Pub/Sub pour partager l'état des parties (Render's load balancer attribue les WebSockets aléatoirement entre instances)
- Persistance des scores : ajouter Postgres pour conserver un classement permanent
- Spectateurs : permettre de regarder une partie en cours sans y participer

## 📝 Licence

MIT
