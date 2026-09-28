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

// Légendes et couleurs exactes issues des captures d'écran
const DEFAULT_STATE = {
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
            const fileData = fs.readFileSync(DATA_FILE, 'utf8');
            const savedState = JSON.parse(fileData);
            
            state = {
                config: savedState.config || DEFAULT_STATE.config,
                gridData: savedState.gridData || DEFAULT_STATE.gridData,
                terrainsList: (savedState.terrainsList && savedState.terrainsList.length > 0) 
                    ? savedState.terrainsList 
                    : DEFAULT_STATE.terrainsList,
                isLocked: savedState.isLocked !== undefined ? savedState.isLocked : DEFAULT_STATE.isLocked
            };
            console.log('✅ Données chargées avec succès depuis data.json');
        } else {
            saveData();
        }
    } catch (err) {
        console.error('⚠️ Erreur chargement data.json :', err.message);
    }
}

function saveData() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), 'utf8');
    } catch (err) {
        console.error('⚠️ Erreur sauvegarde data.json :', err.message);
    }
}

loadData();

const activeUsers = {};

function broadcastUserList() {
    const rawUsers = Object.values(activeUsers).filter(u => u && u.trim() !== '');
    io.emit('update-users-list', [...new Set(rawUsers)]);
}

io.on('connection', (socket) => {
    const rawUsers = Object.values(activeUsers).filter(u => u && u.trim() !== '');
    
    socket.emit('init', { 
        config: state.config, 
        gridData: state.gridData, 
        terrains: state.terrainsList,
        users: [...new Set(rawUsers)],
        isLocked: state.isLocked
    });

    socket.on('set-username', (name, callback) => {
        const cleanName = (name || '').trim();
        const lowerName = cleanName.toLowerCase();

        if (lowerName === 'admin') {
            const alreadyAdmin = Object.values(activeUsers).some(u => u.toLowerCase() === 'admin');
            if (alreadyAdmin && socket.username?.toLowerCase() !== 'admin') {
                if (typeof callback === 'function') {
                    callback({ success: false, message: "Un administrateur est déjà connecté !" });
                }
                return;
            }
        }

        if (cleanName.length > 0) {
            socket.username = cleanName;
            activeUsers[socket.id] = cleanName;
            broadcastUserList();
            if (typeof callback === 'function') {
                callback({ success: true });
            }
        }
    });

    socket.on('get-users', () => {
        const rawUsers = Object.values(activeUsers).filter(u => u && u.trim() !== '');
        socket.emit('update-users-list', [...new Set(rawUsers)]);
    });

    socket.on('toggle-lock', (lockedState) => {
        if (socket.username && socket.username.toLowerCase() === 'admin') {
            state.isLocked = lockedState;
            saveData();
            io.emit('update-lock', state.isLocked);
        }
    });

    socket.on('paint-tile', (data) => {
        if (state.isLocked) return;
        const { key, color } = data;
        const author = socket.username || 'Anonyme';
        
        state.gridData[key] = { color, author };
        saveData();
        io.emit('update-tile', { key, color, author });
    });

    socket.on('update-terrains', (newTerrains) => {
        if (socket.username && socket.username.toLowerCase() === 'admin') {
            state.terrainsList = newTerrains;
            saveData();
            io.emit('update-terrains', state.terrainsList);
        }
    });

    socket.on('change-config', (newConfig) => {
        if (socket.username && socket.username.toLowerCase() === 'admin') {
            state.config = newConfig;
            state.gridData = {};
            saveData();
            io.emit('update-config', { config: state.config, gridData: state.gridData });
        }
    });

    // Nouvelle carte (Reset de la grille)
    socket.on('reset-map', () => {
        if (socket.username && socket.username.toLowerCase() === 'admin') {
            state.gridData = {};
            saveData();
            io.emit('update-config', { config: state.config, gridData: state.gridData });
        }
    });

    // Chargement d'un fichier .json envoyé par l'Admin
    socket.on('load-map-file', (importedData) => {
        if (socket.username && socket.username.toLowerCase() === 'admin') {
            if (importedData && importedData.config && importedData.gridData) {
                state.config = importedData.config;
                state.gridData = importedData.gridData;
                if (importedData.terrainsList) {
                    state.terrainsList = importedData.terrainsList;
                    io.emit('update-terrains', state.terrainsList);
                }
                saveData();
                io.emit('update-config', { config: state.config, gridData: state.gridData });
            }
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
http.listen(PORT, () => {
    console.log(`Serveur démarré sur le port ${PORT}`);
});
