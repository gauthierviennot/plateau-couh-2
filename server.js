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

// Structure par défaut si data.json n'existe pas encore
let state = {
    config: { cols: 10, rows: 8 },
    gridData: {},
    terrainsList: [
        { color: '#2ecc71', label: 'Plaine' },
        { color: '#27ae60', label: 'Forêt' },
        { color: '#3498db', label: 'Eau' },
        { color: '#f1c40f', label: 'Désert' },
        { color: '#95a5a6', label: 'Montagne' },
        { color: '#ffffff', label: 'Gomme' },
        { color: '#e74c3c', label: 'Lave' },
        { color: '#8e44ad', label: 'Marais' },
        { color: '#e67e22', label: 'Canyon' },
        { color: '#16a085', label: 'Jungle' },
        { color: '#34495e', label: 'Rocher' },
        { color: '#d35400', label: 'Terre' }
    ],
    isLocked: false
};

// Charge le fichier existant pour conserver la carte, légendes et couleurs
function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const fileData = fs.readFileSync(DATA_FILE, 'utf8');
            state = JSON.parse(fileData);
            console.log('📂 Données conservées et chargées depuis data.json');
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

const activeUsers = {}; // { socketId: username }

function broadcastUserList() {
    const rawUsers = Object.values(activeUsers).filter(u => u && u.trim() !== '');
    const uniqueUsers = [...new Set(rawUsers)];
    io.emit('update-users-list', uniqueUsers);
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

        // Sécurité : Un seul Admin connecté à la fois
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
