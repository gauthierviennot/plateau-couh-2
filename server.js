const express = require('express'); 
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const fs = require('fs');

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const DATA_FILE = path.join(__dirname, 'data.json');

const DEFAULT_STATE = {
    mapName: "Carte Principale",
    config: { cols: 150, rows: 100 },
    gridData: {},
    terrainsList: [
        { color: '#2ecc71', label: 'Plaine' },
        { color: '#38761d', label: 'Forêt' },
        { color: '#3498db', label: 'Eau' },
        { color: '#f1c40f', label: 'colline' },
        { color: '#783f04', label: 'Montagne' },
        { color: '#999999', label: 'village' },
        { color: '#000000', label: 'forteresse' },
        { color: '#8e44ad', label: 'foret sur colline' },
        { color: '#e67e22', label: 'village sur colline' },
        { color: '#ff0000', label: 'pont, muet,' },
        { color: '#ffffff', label: 'hors plateau' }
    ],
    isLocked: false
};

let state = { ...DEFAULT_STATE };

function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const savedState = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            state = {
                mapName: savedState.mapName || DEFAULT_STATE.mapName,
                config: savedState.config || DEFAULT_STATE.config,
                gridData: savedState.gridData || DEFAULT_STATE.gridData,
                terrainsList: (savedState.terrainsList && savedState.terrainsList.length > 0) ? savedState.terrainsList : DEFAULT_STATE.terrainsList,
                isLocked: savedState.isLocked !== undefined ? savedState.isLocked : DEFAULT_STATE.isLocked
            };
        } else {
            saveData();
        }
    } catch (err) {
        console.error('Erreur chargement data.json :', err.message);
    }
}

function saveData() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), 'utf8');
    } catch (err) {
        console.error('Erreur sauvegarde data.json :', err.message);
    }
}

loadData();

const activeUsers = {};

function broadcastUserList() {
    const uniqueUsers = [...new Set(Object.values(activeUsers).filter(u => u && u.trim() !== ''))];
    io.emit('update-users-list', uniqueUsers);
}

io.on('connection', (socket) => {
    socket.emit('init', { 
        mapName: state.mapName,
        config: state.config, 
        gridData: state.gridData, 
        terrains: state.terrainsList,
        users: [...new Set(Object.values(activeUsers).filter(u => u && u.trim() !== ''))],
        isLocked: state.isLocked
    });

    socket.on('set-username', (name, callback) => {
        const cleanName = (name || '').trim();
        const lowerName = cleanName.toLowerCase();

        if (lowerName === 'admin') {
            const alreadyAdmin = Object.values(activeUsers).some(u => u.toLowerCase() === 'admin');
            if (alreadyAdmin && socket.username?.toLowerCase() !== 'admin') {
                if (typeof callback === 'function') callback({ success: false, message: "Un administrateur est déjà connecté !" });
                return;
            }
        }

        if (cleanName.length > 0) {
            socket.username = cleanName;
            activeUsers[socket.id] = cleanName;
            broadcastUserList();
            if (typeof callback === 'function') callback({ success: true });
        }
    });

    socket.on('paint-tile', (data) => {
        if (state.isLocked) return;
        state.gridData[data.key] = { color: data.color, author: socket.username || 'Anonyme' };
        saveData();
        io.emit('update-tile', { key: data.key, color: data.color, author: socket.username });
    });

    socket.on('update-terrains', (newTerrains) => {
        if (socket.username?.toLowerCase() === 'admin') {
            state.terrainsList = newTerrains;
            saveData();
            io.emit('update-terrains', state.terrainsList);
        }
    });

    // Nouvelle carte avec Nom, Lignes et Colonnes réglables
    socket.on('create-new-map', ({ name, cols, rows }) => {
        if (socket.username?.toLowerCase() === 'admin') {
            state.mapName = name || "Nouvelle Carte";
            state.config = { cols: parseInt(cols) || 150, rows: parseInt(rows) || 100 };
            state.gridData = {};
            saveData();
            io.emit('map-reloaded', state);
        }
    });

    socket.on('load-map-file', (importedData) => {
        if (socket.username?.toLowerCase() === 'admin' && importedData) {
            state.mapName = importedData.mapName || "Carte Importée";
            state.config = importedData.config || state.config;
            state.gridData = importedData.gridData || {};
            if (importedData.terrainsList) state.terrainsList = importedData.terrainsList;
            saveData();
            io.emit('map-reloaded', state);
        }
    });

    socket.on('disconnect', () => {
        if (activeUsers[socket.id]) {
            delete activeUsers[socket.id];
            broadcastUserList();
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Serveur prêt sur le port ${PORT}`));
