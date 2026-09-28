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

let saveTimer = null;


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
            saveData();
        }
    } catch (err) {
        console.error('⚠️ Erreur lors de la lecture de data.json, utilisation des secours :', err.message);
    }
}

function saveData() {
 
try {
 
if (fs.existsSync(DATA_FILE)) {
 
fs.copyFileSync(
DATA_FILE,
DATA_FILE + '.backup'
);
 
}
 
fs.writeFileSync(
DATA_FILE,
JSON.stringify(state, null, 2),
'utf8'
);
 
}
catch (err) {
 
console.error(
'⚠️ Erreur lors de la sauvegarde :',
err.message
);
 
}
 
}
 
function saveDataDebounced() {
 
if (saveTimer) {
clearTimeout(saveTimer);
}
 
saveTimer = setTimeout(() => {
saveData();
}, 1500);
 
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

    socket.on('set-username', (name, callback) => {
        const cleanName = (name || '').trim();
        const lowerName = cleanName.toLowerCase();

        // Un seul Admin à la fois
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


socket.on('export-data', () => {
 
socket.emit(
'export-result',
state
);
 
});

socket.on('import-state', (newState) => {
 
if (
socket.username &&
socket.username.toLowerCase() === 'admin'
) {
 
if (
!newState ||
!newState.config ||
!newState.gridData ||
!newState.terrainsList
) {
return;
}
 
state = {
config: newState.config,
gridData: newState.gridData,
terrainsList: newState.terrainsList,
isLocked: !!newState.isLocked
};
 
saveData();
 
io.emit('init', {
config: state.config,
gridData: state.gridData,
terrains: state.terrainsList,
users: Object.values(activeUsers),
isLocked: state.isLocked
});
 
}
 
});




    socket.on('paint-tile', (data) => {
        if (state.isLocked) return;

        const { key, color } = data;
        const author = socket.username || 'Anonyme';
        
state.gridData[key] = {
color,
author,
timestamp: Date.now()
};
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
 
console.log(
`Serveur prêt sur http://localhost:${PORT}`
);
 
});
