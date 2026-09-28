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
const ADMIN_PASSWORD = "";

// Configuration et légende par défaut (utilisées UNIQUEMENT si data.json n'existe pas)
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

// Fonction de chargement sécurisé : Conserve TOUTES vos données existantes
function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const fileData = fs.readFileSync(DATA_FILE, 'utf8');
            const savedState = JSON.parse(fileData);
            
            // Fusion sécurisée : On privilégie les cartes/couleurs enregistrées dans data.json
            state = {
                config: savedState.config || DEFAULT_STATE.config,
                gridData: savedState.gridData || DEFAULT_STATE.gridData,
                terrainsList: (savedState.terrainsList && savedState.terrainsList.length > 0) 
                    ? savedState.terrainsList 
                    : DEFAULT_STATE.terrainsList,
                isLocked: savedState.isLocked !== undefined ? savedState.isLocked : DEFAULT_STATE.isLocked
            };

            console.log('✅ Cartes, légendes et couleurs existantes conservées depuis data.json !');
        } else {
            console.log('🆕 Aucun data.json trouvé. Création avec les paramètres par défaut (150x100).');
            saveDataDebounced();
        }
    } catch (err) {
        console.error('⚠️ Erreur lors de la lecture de data.json, utilisation des secours :', err.message);
    }
}

function saveData() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), 'utf8');
    } catch (err) {
        console.error('⚠️ Erreur lors de la sauvegarde de data.json :', err.message);
    }
}

// Initialisation au démarrage du serveur
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

socket.on('set-username', (data, callback) => {

    const cleanName = (data.username || '').trim();
    const adminPassword = (data.password || '').trim();

    if (cleanName.length < 1 || cleanName.length > 20) {
        return callback?.({
            success: false,
            message: "Pseudo invalide"
        });
    }

    const lowerName = cleanName.toLowerCase();

    if (lowerName === 'admin') {

        if (adminPassword !== ADMIN_PASSWORD) {
            return callback?.({
                success: false,
                message: "Mot de passe administrateur incorrect"
            });
        }

        const alreadyAdmin = Object.values(activeUsers)
            .some(u => u.toLowerCase() === 'admin');

        if (alreadyAdmin &&
            socket.username?.toLowerCase() !== 'admin') {

            return callback?.({
                success: false,
                message: "Un administrateur est déjà connecté"
            });
        }
    }

    socket.username = cleanName;
    activeUsers[socket.id] = cleanName;

    broadcastUserList();

    callback?.({
        success: true,
        isAdmin: lowerName === 'admin'
    });

});

    socket.on('get-users', () => {
        const rawUsers = Object.values(activeUsers).filter(u => u && u.trim() !== '');
        socket.emit('update-users-list', [...new Set(rawUsers)]);
    });

    socket.on('toggle-lock', (lockedState) => {
        if (socket.username && socket.username.toLowerCase() === 'admin') {
            state.isLocked = lockedState;
            saveDataDebounced();
            io.emit('update-lock', state.isLocked);
        }
    });

    socket.on('paint-tile', (data) => {
        if (state.isLocked) return;

        const { key, color } = data || {};

if (!key || typeof key !== 'string') {
    return;
}

if (!/^#[0-9A-F]{6}$/i.test(color)) {
    return;
}


const parts = key.split(',');
 
if (parts.length !== 2) {
return;
}
 
const col = parseInt(parts[0]);
const row = parseInt(parts[1]);
 
if (
isNaN(col) ||
isNaN(row) ||
col < 0 ||
row < 0 ||
col >= state.config.cols ||
row >= state.config.rows
) {
return;
}



        const author = socket.username || 'Anonyme';
        
        state.gridData[key] = { color, author };
        saveDataDebounced();
        io.emit('update-tile', { key, color, author });
    });

    socket.on('update-terrains', (newTerrains) => {
        if (socket.username && socket.username.toLowerCase() === 'admin') {
            if (!Array.isArray(newTerrains)) {
return;
}
 
if (newTerrains.length > 50) {
return;
}
 
const validTerrains = newTerrains.filter(t =>
t &&
typeof t.label === 'string' &&
t.label.length < 50 &&
/^#[0-9A-F]{6}$/i.test(t.color)
);
 
state.terrainsList = validTerrains;
            saveDataDebounced();
            io.emit('update-terrains', state.terrainsList);
        }
    });

    socket.on('change-config', (newConfig) => {
        if (socket.username && socket.username.toLowerCase() === 'admin') {
            state.config = newConfig;
            state.gridData = {};
            saveDataDebounced();
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



let saveTimer = null;
function saveDataDebounced() {
 
if (saveTimer) {
clearTimeout(saveTimer);
}
 
saveTimer = setTimeout(() => {
saveDataDebounced();
}, 1500);
 
}
``
