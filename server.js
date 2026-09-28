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

// ⚠️ CHANGEZ CE MOT DE PASSE (Ne le laissez pas vide en production !)
const ADMIN_PASSWORD = "MonMotDePasseSecurise123!"; 

// Configuration et légende par défaut
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

// Fonction de chargement sécurisé
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
            fs.copyFileSync(DATA_FILE, DATA_FILE + '.backup');
        }
        fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), 'utf8');
    } catch (err) {
        console.error('⚠️ Erreur lors de la sauvegarde :', err.message);
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

// Initialisation au démarrage
loadData();

const activeUsers = {};

function broadcastUserList() {
    const rawUsers = Object.values(activeUsers).filter(u => u && u.trim() !== '');
    const uniqueUsers = [...new Set(rawUsers)];
    io.emit('update-users-list', uniqueUsers);
}

// Middleware interne pour valider les droits d'administration
function isAdmin(socket) {
    return socket.username && socket.username.toLowerCase() === 'admin' && socket.isAdminAuthenticated === true;
}

io.on('connection', (socket) => {
    // Initialisation du flag de sécurité
    socket.isAdminAuthenticated = false;

    const rawUsers = Object.values(activeUsers).filter(u => u && u.trim() !== '');
    
    socket.emit('init', { 
        config: state.config, 
        gridData: state.gridData, 
        terrains: state.terrainsList,
        users: [...new Set(rawUsers)],
        isLocked: state.isLocked
    });

    // CORRECTION : Ajout d'un paramètre password optionnel
    socket.on('set-username', (data, callback) => {
        // Gestion de la rétrocompatibilité ou du format de données (string vs objet)
        const inputName = typeof data === 'object' ? data.name : data;
        const inputPassword = typeof data === 'object' ? data.password : null;

        const cleanName = (inputName || '').trim();
        const lowerName = cleanName.toLowerCase();

        if (cleanName.length === 0) {
            if (typeof callback === 'function') callback({ success: false, message: "Le pseudo ne peut pas être vide." });
            return;
        }

        if (lowerName === 'admin') {
            // 1. Vérification du mot de passe requis pour l'admin
            if (!inputPassword || inputPassword !== ADMIN_PASSWORD) {
                if (typeof callback === 'function') {
                    callback({ success: false, message: "Mot de passe administrateur incorrect !" });
                }
                return;
            }

            // 2. Vérification si un admin est déjà connecté
            const alreadyAdmin = Object.entries(activeUsers).some(([id, u]) => u.toLowerCase() === 'admin' && id !== socket.id);
            if (alreadyAdmin) {
                if (typeof callback === 'function') {
                    callback({ success: false, message: "Un administrateur est déjà connecté !" });
                }
                return;
            }

            // Validation des privilèges
            socket.isAdminAuthenticated = true;
        } else {
            // Empêche un utilisateur classique d'utiliser un pseudo contenant 'admin' de manière détournée si besoin
            if (lowerName.includes('admin')) {
                if (typeof callback === 'function') callback({ success: false, message: "Ce pseudo contient un mot interdit." });
                return;
            }
            socket.isAdminAuthenticated = false;
        }

        socket.username = cleanName;
        activeUsers[socket.id] = cleanName;
        broadcastUserList();

        if (typeof callback === 'function') {
            callback({ success: true, isAdmin: socket.isAdminAuthenticated });
        }
    });

    socket.on('get-users', () => {
        const rawUsers = Object.values(activeUsers).filter(u => u && u.trim() !== '');
        socket.emit('update-users-list', [...new Set(rawUsers)]);
    });

    // CORRECTION : Vérification stricte via la fonction isAdmin
    socket.on('toggle-lock', (lockedState) => {
        if (isAdmin(socket)) {
            state.isLocked = lockedState;
            saveData(); 
            io.emit('update-lock', state.isLocked);
        }
    });

    socket.on('export-data', () => {
        socket.emit('export-result', state);
    });

    // CORRECTION : Vérification stricte via la fonction isAdmin
    socket.on('import-state', (newState) => {
        if (isAdmin(socket)) {
            if (!newState || !newState.config || !newState.gridData || !newState.terrainsList) {
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
        // CORRECTION : Sécurité anti-triche : un admin authentifié ou un utilisateur ayant un pseudo enregistré
        if (!socket.username) return; 

        const { key, color } = data;
        const author = socket.username;
        
        state.gridData[key] = {
            color,
            author,
            timestamp: Date.now()
        };

        saveDataDebounced();
        io.emit('update-tile', { key, color, author });
    });

    // CORRECTION : Vérification stricte via la fonction isAdmin
    socket.on('update-terrains', (newTerrains) => {
        if (isAdmin(socket)) {
            state.terrainsList = newTerrains;
            saveData();
            io.emit('update-terrains', state.terrainsList);
        }
    });

    // CORRECTION : Vérification stricte via la fonction isAdmin
    socket.on('change-config', (newConfig) => {
        if (isAdmin(socket)) {
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
