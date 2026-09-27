const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

let config = { cols: 10, rows: 8 };
let gridData = {}; 
let terrainsList = null;
let isLocked = false;
const activeUsers = {}; // { socketId: username }

// Diffusion de la liste nettoyée et sans doublons
function broadcastUserList() {
    const rawUsers = Object.values(activeUsers).filter(u => u && u.trim() !== '');
    const uniqueUsers = [...new Set(rawUsers)];
    io.emit('update-users-list', uniqueUsers);
}

io.on('connection', (socket) => {
    // 1. Envoi de l'état initial
    const rawUsers = Object.values(activeUsers).filter(u => u && u.trim() !== '');
    socket.emit('init', { 
        config, 
        gridData, 
        terrains: terrainsList,
        users: [...new Set(rawUsers)],
        isLocked
    });

    // 2. Enregistrement / ré-enregistrement du pseudo
    socket.on('set-username', (name) => {
        const cleanName = (name || '').trim();
        if (cleanName.length > 0) {
            socket.username = cleanName;
            activeUsers[socket.id] = cleanName;
            broadcastUserList();
        }
    });

    socket.on('get-users', () => {
        const rawUsers = Object.values(activeUsers).filter(u => u && u.trim() !== '');
        socket.emit('update-users-list', [...new Set(rawUsers)]);
    });

    socket.on('toggle-lock', (lockedState) => {
        if (socket.username && socket.username.toLowerCase() === 'admin') {
            isLocked = lockedState;
            io.emit('update-lock', isLocked);
        }
    });

    socket.on('paint-tile', (data) => {
        if (isLocked && (!socket.username || socket.username.toLowerCase() !== 'admin')) {
            return;
        }

        const { key, color } = data;
        const author = socket.username || 'Anonyme';
        
        gridData[key] = { color, author };
        io.emit('update-tile', { key, color, author });
    });

    socket.on('update-terrains', (newTerrains) => {
        terrainsList = newTerrains;
        socket.broadcast.emit('update-terrains', terrainsList);
    });

    socket.on('change-config', (newConfig) => {
        config = newConfig;
        gridData = {};
        io.emit('update-config', { config, gridData });
    });

    socket.on('clear-grid', () => {
        gridData = {};
        io.emit('clear-grid');
    });

    // Nettoyage précis à la déconnexion
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
