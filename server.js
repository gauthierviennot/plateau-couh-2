const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// État global du jeu
let config = { cols: 10, rows: 8 };
let gridData = {}; 
let terrainsList = null; // Stocke la palette si un admin la modifie
const activeUsers = {};  // { socketId: username }

// Fonction utilitaire pour diffuser la liste unique des pseudos uniques connectés
function broadcastUserList() {
    const usersArray = Object.values(activeUsers);
    io.emit('update-users-list', usersArray);
}

io.on('connection', (socket) => {
    // 1. Envoyer l'état actuel au nouveau joueur
    socket.emit('init', { 
        config, 
        gridData, 
        terrains: terrainsList,
        users: Object.values(activeUsers)
    });

    // 2. Enregistrement / mise à jour du pseudo
    socket.on('set-username', (name) => {
        socket.username = name || 'Anonyme';
        activeUsers[socket.id] = socket.username;
        broadcastUserList();
    });

    // 3. Demande manuelle de la liste des joueurs
    socket.on('get-users', () => {
        socket.emit('update-users-list', Object.values(activeUsers));
    });

    // 4. Coloration d'une case
    socket.on('paint-tile', (data) => {
        const { key, color } = data;
        const author = socket.username || 'Anonyme';
        
        gridData[key] = { color, author };
        io.emit('update-tile', { key, color, author });
    });

    // 5. Modification des couleurs/légendes par l'admin
    socket.on('update-terrains', (newTerrains) => {
        terrainsList = newTerrains;
        socket.broadcast.emit('update-terrains', terrainsList);
    });

    // 6. Redimensionnement du plateau
    socket.on('change-config', (newConfig) => {
        config = newConfig;
        gridData = {};
        io.emit('update-config', { config, gridData });
    });

    // 7. Effacement de la grille
    socket.on('clear-grid', () => {
        gridData = {};
        io.emit('clear-grid');
    });

    // 8. Gestion de la déconnexion
    socket.on('disconnect', () => {
        if (activeUsers[socket.id]) {
            delete activeUsers[socket.id];
            broadcastUserList();
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Serveur prêt sur http://localhost:${PORT}`);
});
