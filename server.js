'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MAPS_DIR = path.join(DATA_DIR, 'maps');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const LEGACY_FILE = path.join(__dirname, 'data.json'); // ancien format, migré automatiquement
const PASSWORD_FILE = path.join(DATA_DIR, 'admin-password.txt');

const LIMITS = {
    minSize: 2,
    maxSize: 300,
    maxTerrains: 30,
    maxLabel: 40,
    maxName: 15,
    maxMapName: 60,
    maxAutoBackups: 5
};
const SAVE_DELAY_MS = 500;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_BLOCK_MS = 60 * 1000;

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const MAP_ID = /^[a-z0-9-]{1,64}$/;

const DEFAULT_TERRAINS = [
    { color: '#2ecc71', label: 'Plaine' },
    { color: '#38761d', label: 'Forêt' },
    { color: '#3498db', label: 'Eau' },
    { color: '#f1c40f', label: 'Colline' },
    { color: '#783f04', label: 'Montagne' },
    { color: '#999999', label: 'Village' },
    { color: '#000000', label: 'Forteresse' },
    { color: '#8e44ad', label: 'Forêt sur colline' },
    { color: '#e67e22', label: 'Village sur colline' },
    { color: '#ff0000', label: 'Pont, muet,' },
    { color: '#ffffff', label: 'Hors plateau' }
];

fs.mkdirSync(MAPS_DIR, { recursive: true });

/* ------------------------------------------------------------------ */
/* Utilitaires                                                         */
/* ------------------------------------------------------------------ */

const isHex = (value) => typeof value === 'string' && HEX_COLOR.test(value);
const reply = (ack, payload) => { if (typeof ack === 'function') ack(payload); };
const cleanText = (value, max) =>
    String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        if (err.code !== 'ENOENT') console.error(`⚠️ Lecture impossible : ${file} (${err.message})`);
        return null;
    }
}

// Écriture atomique : on écrit dans un fichier temporaire puis on renomme,
// pour ne jamais laisser un fichier à moitié écrit en cas de coupure.
function writeJsonAtomic(file, data) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, file);
}

/* ------------------------------------------------------------------ */
/* Validation / nettoyage des données                                  */
/* ------------------------------------------------------------------ */

function sanitizeConfig(config) {
    const cols = Number.parseInt(config?.cols, 10);
    const rows = Number.parseInt(config?.rows, 10);
    const valid = (n) => Number.isInteger(n) && n >= LIMITS.minSize && n <= LIMITS.maxSize;
    return valid(cols) && valid(rows) ? { cols, rows } : null;
}

function sanitizeTerrains(list) {
    if (!Array.isArray(list)) return null;
    const terrains = list
        .slice(0, LIMITS.maxTerrains)
        .filter((t) => t && isHex(t.color))
        .map((t) => ({ color: t.color.toLowerCase(), label: cleanText(t.label, LIMITS.maxLabel) }));
    return terrains.length ? terrains : null;
}

function isValidKey(key, config) {
    const match = /^(\d{1,3}),(\d{1,3})$/.exec(key);
    return Boolean(match) && Number(match[1]) < config.cols && Number(match[2]) < config.rows;
}

function sanitizeGrid(grid, config) {
    const clean = {};
    if (!grid || typeof grid !== 'object') return clean;
    for (const [key, tile] of Object.entries(grid)) {
        if (!isValidKey(key, config) || !tile || !isHex(tile.color)) continue;
        clean[key] = {
            color: tile.color.toLowerCase(),
            author: typeof tile.author === 'string' ? tile.author.slice(0, LIMITS.maxName) : ''
        };
    }
    return clean;
}

function normalizeState(raw) {
    const config = sanitizeConfig(raw?.config) || { cols: 150, rows: 100 };
    return {
        config,
        gridData: sanitizeGrid(raw?.gridData, config),
        terrainsList: sanitizeTerrains(raw?.terrainsList ?? raw?.terrains)
            || DEFAULT_TERRAINS.map((t) => ({ ...t })),
        isLocked: Boolean(raw?.isLocked)
    };
}

/* ------------------------------------------------------------------ */
/* État courant du plateau (persisté dans data/state.json)             */
/* ------------------------------------------------------------------ */

function loadState() {
    let raw = null;

    if (fs.existsSync(STATE_FILE)) {
        raw = readJson(STATE_FILE);
        if (!raw) {
            const backup = `${STATE_FILE}.corrompu-${Date.now()}`;
            fs.renameSync(STATE_FILE, backup);
            console.error(`⚠️ state.json illisible, copie conservée dans ${backup}`);
        } else {
            console.log('✅ Plateau, légende et couleurs rechargés depuis data/state.json');
        }
    } else if (fs.existsSync(LEGACY_FILE)) {
        raw = readJson(LEGACY_FILE);
        if (raw) console.log('✅ Ancien data.json migré vers data/state.json (le fichier d’origine est conservé)');
    } else {
        console.log('🆕 Aucune donnée trouvée : plateau par défaut (150x100).');
    }

    return normalizeState(raw);
}

let state = loadState();
let saveTimer = null;

function flushSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    try {
        writeJsonAtomic(STATE_FILE, state);
    } catch (err) {
        console.error('⚠️ Sauvegarde de state.json impossible :', err.message);
    }
}

// Les peintures arrivent en rafale : on regroupe les écritures disque.
function scheduleSave() {
    if (!saveTimer) saveTimer = setTimeout(flushSave, SAVE_DELAY_MS);
}

flushSave();

/* ------------------------------------------------------------------ */
/* Cartes enregistrées (data/maps/<id>.json)                           */
/* ------------------------------------------------------------------ */

const mapsIndex = new Map(); // id -> métadonnées (sans la grille, pour rester léger)

const mapFile = (id) => path.join(MAPS_DIR, `${id}.json`);

function metaOf(map) {
    return {
        id: map.id,
        name: map.name,
        auto: Boolean(map.auto),
        author: map.author || '',
        savedAt: map.savedAt || 0,
        cols: map.config.cols,
        rows: map.config.rows,
        tiles: Object.keys(map.gridData || {}).length
    };
}

function loadMapsIndex() {
    for (const file of fs.readdirSync(MAPS_DIR)) {
        if (!file.endsWith('.json')) continue;
        const id = file.slice(0, -5);
        if (!MAP_ID.test(id)) continue;
        const map = readJson(path.join(MAPS_DIR, file));
        if (map && sanitizeConfig(map.config)) mapsIndex.set(id, metaOf({ ...map, id }));
    }
    console.log(`🗺️  ${mapsIndex.size} carte(s) enregistrée(s).`);
}

const listMaps = () => [...mapsIndex.values()].sort((a, b) => b.savedAt - a.savedAt);

function saveMapToDisk({ id, name, auto = false }, author) {
    const mapId = id && mapsIndex.has(id) ? id : crypto.randomUUID();
    const map = {
        id: mapId,
        name,
        auto,
        author,
        savedAt: Date.now(),
        config: { ...state.config },
        terrainsList: state.terrainsList.map((t) => ({ ...t })),
        gridData: state.gridData
    };
    writeJsonAtomic(mapFile(mapId), map);
    const meta = metaOf(map);
    mapsIndex.set(mapId, meta);
    return meta;
}

function deleteMapFromDisk(id) {
    try {
        fs.unlinkSync(mapFile(id));
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
    }
    mapsIndex.delete(id);
}

// Filet de sécurité avant toute action qui écrase le plateau.
function createAutoBackup(reason, author) {
    if (Object.keys(state.gridData).length === 0) return;

    const stamp = new Date().toLocaleString('fr-FR');
    saveMapToDisk({ name: `Sauvegarde auto (${reason}) ${stamp}`, auto: true }, author);

    const autos = [...mapsIndex.values()].filter((m) => m.auto).sort((a, b) => a.savedAt - b.savedAt);
    while (autos.length > LIMITS.maxAutoBackups) deleteMapFromDisk(autos.shift().id);
}

loadMapsIndex();

/* ------------------------------------------------------------------ */
/* Authentification admin                                              */
/* ------------------------------------------------------------------ */

function loadAdminPassword() {
    if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;

    try {
        const saved = fs.readFileSync(PASSWORD_FILE, 'utf8').trim();
        if (saved) return saved;
    } catch { /* fichier absent : on en génère un */ }

    const generated = crypto.randomBytes(9).toString('base64url');
    fs.writeFileSync(PASSWORD_FILE, `${generated}\n`, { mode: 0o600 });
    console.log('🔑 Mot de passe admin généré (pseudo « admin ») :', generated);
    console.log(`   Il est enregistré dans ${PASSWORD_FILE}. Vous pouvez aussi définir ADMIN_PASSWORD.`);
    return generated;
}

const ADMIN_PASSWORD = loadAdminPassword();

function passwordMatches(input) {
    const hash = (value) => crypto.createHash('sha256').update(String(value ?? '')).digest();
    return crypto.timingSafeEqual(hash(input), hash(ADMIN_PASSWORD));
}

const loginFailures = new Map(); // ip -> { count, blockedUntil }

function isBlocked(ip) {
    const entry = loginFailures.get(ip);
    return Boolean(entry && entry.blockedUntil > Date.now());
}

function registerFailure(ip) {
    const entry = loginFailures.get(ip) || { count: 0, blockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= LOGIN_MAX_FAILURES) {
        entry.count = 0;
        entry.blockedUntil = Date.now() + LOGIN_BLOCK_MS;
    }
    loginFailures.set(ip, entry);
}

/* ------------------------------------------------------------------ */
/* Serveur HTTP + Socket.IO                                            */
/* ------------------------------------------------------------------ */

const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server);

function connectedUsers() {
    const names = [];
    for (const s of io.sockets.sockets.values()) {
        if (s.data.name) names.push(s.data.name);
    }
    return [...new Set(names)];
}

const broadcastUsers = () => io.emit('update-users-list', connectedUsers());
const broadcastMaps = () => io.to('admins').emit('maps-list', listMaps());

function releaseSession(s) {
    s.data.name = '';
    s.data.isAdmin = false;
    s.leave('admins');
}

function requireAdmin(socket, ack) {
    if (socket.data.isAdmin) return true;
    reply(ack, { success: false, message: 'Action réservée à l’administrateur.' });
    return false;
}

io.on('connection', (socket) => {
    socket.data = { name: '', clientId: '', isAdmin: false };

    socket.emit('init', {
        config: state.config,
        gridData: state.gridData,
        terrains: state.terrainsList,
        users: connectedUsers(),
        isLocked: state.isLocked
    });

    /* ---------- Connexion ---------- */

    socket.on('set-username', (payload, ack) => {
        const name = cleanText(payload?.name, LIMITS.maxName);
        const clientId = cleanText(payload?.clientId, 64);
        if (!name) return reply(ack, { success: false, message: 'Pseudo invalide.' });

        const wantsAdmin = name.toLowerCase() === 'admin';
        const ip = socket.handshake.address;

        if (wantsAdmin) {
            if (isBlocked(ip)) {
                return reply(ack, { success: false, message: 'Trop de tentatives. Réessayez dans une minute.' });
            }
            if (!passwordMatches(payload?.password)) {
                registerFailure(ip);
                return reply(ack, { success: false, message: 'Mot de passe administrateur incorrect.' });
            }
            loginFailures.delete(ip);
        }

        releaseSession(socket);

        for (const other of io.sockets.sockets.values()) {
            if (other.id === socket.id || !other.data.name) continue;
            if (other.data.name.toLowerCase() !== name.toLowerCase()) continue;

            const sameClient = clientId && other.data.clientId === clientId;
            if (wantsAdmin || sameClient) {
                // Reconnexion ou reprise de session : l'ancienne connexion est remplacée.
                releaseSession(other);
                other.emit('kicked', 'Cette session a été ouverte depuis un autre appareil ou onglet.');
            } else {
                return reply(ack, { success: false, message: 'Ce pseudo est déjà utilisé.' });
            }
        }

        socket.data = { name, clientId, isAdmin: wantsAdmin };
        if (wantsAdmin) {
            socket.join('admins');
            socket.emit('maps-list', listMaps());
        }
        broadcastUsers();
        reply(ack, { success: true, name, isAdmin: wantsAdmin });
    });

    /* ---------- Plateau ---------- */

    socket.on('paint-tile', (data) => {
        if (state.isLocked || !socket.data.name) return;

        const key = data?.key;
        const color = data?.color;
        if (!isValidKey(key, state.config) || !isHex(color)) return;

        const lower = color.toLowerCase();
        const author = socket.data.name;
        if (state.gridData[key]?.color === lower) return;

        state.gridData[key] = { color: lower, author };
        scheduleSave();
        io.emit('update-tile', { key, color: lower, author });
    });

    socket.on('toggle-lock', (locked) => {
        if (!requireAdmin(socket)) return;
        state.isLocked = Boolean(locked);
        scheduleSave();
        io.emit('update-lock', state.isLocked);
    });

    socket.on('update-terrains', (list) => {
        if (!requireAdmin(socket)) return;
        const terrains = sanitizeTerrains(list);
        if (!terrains) return;
        state.terrainsList = terrains;
        scheduleSave();
        io.emit('update-terrains', state.terrainsList);
    });

    socket.on('change-config', (newConfig, ack) => {
        if (!requireAdmin(socket, ack)) return;
        const config = sanitizeConfig(newConfig);
        if (!config) {
            return reply(ack, {
                success: false,
                message: `Taille invalide (entre ${LIMITS.minSize} et ${LIMITS.maxSize}).`
            });
        }

        createAutoBackup('changement de taille', socket.data.name);
        state.config = config;
        state.gridData = {};
        flushSave();
        io.emit('update-config', { config: state.config, gridData: state.gridData });
        broadcastMaps();
        reply(ack, { success: true, message: 'Taille modifiée. Une sauvegarde automatique a été créée.' });
    });

    /* ---------- Cartes enregistrées ---------- */

    socket.on('list-maps', () => {
        if (socket.data.isAdmin) socket.emit('maps-list', listMaps());
    });

    socket.on('save-map', (payload, ack) => {
        if (!requireAdmin(socket, ack)) return;

        const name = cleanText(payload?.name, LIMITS.maxMapName);
        if (!name) return reply(ack, { success: false, message: 'Donnez un nom à la carte.' });

        let id = null;
        if (payload?.id !== undefined) {
            id = String(payload.id);
            if (!mapsIndex.has(id)) return reply(ack, { success: false, message: 'Carte introuvable.' });
        } else {
            const existing = [...mapsIndex.values()]
                .find((m) => !m.auto && m.name.toLowerCase() === name.toLowerCase());
            if (existing) return reply(ack, { success: false, code: 'exists', id: existing.id });
        }

        try {
            saveMapToDisk({ id, name }, socket.data.name);
        } catch (err) {
            console.error('⚠️ Enregistrement de la carte impossible :', err.message);
            return reply(ack, { success: false, message: 'Erreur du serveur lors de l’enregistrement.' });
        }
        broadcastMaps();
        reply(ack, { success: true, message: `Carte « ${name} » enregistrée.` });
    });

    socket.on('load-map', (payload, ack) => {
        if (!requireAdmin(socket, ack)) return;

        const id = String(payload?.id ?? '');
        if (!MAP_ID.test(id) || !mapsIndex.has(id)) {
            return reply(ack, { success: false, message: 'Carte introuvable.' });
        }

        const map = readJson(mapFile(id));
        const config = sanitizeConfig(map?.config);
        if (!config) return reply(ack, { success: false, message: 'Fichier de carte illisible.' });

        const gridData = sanitizeGrid(map.gridData, config);
        const terrains = sanitizeTerrains(map.terrainsList);

        createAutoBackup('avant chargement', socket.data.name);

        state.config = config;
        state.gridData = gridData;
        if (terrains) state.terrainsList = terrains;
        flushSave();

        io.emit('update-config', { config: state.config, gridData: state.gridData });
        io.emit('update-terrains', state.terrainsList);
        broadcastMaps();
        reply(ack, { success: true, message: `Carte « ${map.name} » chargée.` });
    });

    socket.on('rename-map', (payload, ack) => {
        if (!requireAdmin(socket, ack)) return;

        const id = String(payload?.id ?? '');
        const name = cleanText(payload?.name, LIMITS.maxMapName);
        if (!name) return reply(ack, { success: false, message: 'Le nom ne peut pas être vide.' });
        if (!MAP_ID.test(id) || !mapsIndex.has(id)) {
            return reply(ack, { success: false, message: 'Carte introuvable.' });
        }

        const map = readJson(mapFile(id));
        if (!map) return reply(ack, { success: false, message: 'Fichier de carte illisible.' });

        map.id = id;
        map.name = name;
        map.auto = false; // une carte renommée n'est plus supprimée automatiquement
        writeJsonAtomic(mapFile(id), map);
        mapsIndex.set(id, metaOf(map));
        broadcastMaps();
        reply(ack, { success: true, message: 'Carte renommée.' });
    });

    socket.on('delete-map', (payload, ack) => {
        if (!requireAdmin(socket, ack)) return;

        const id = String(payload?.id ?? '');
        if (!MAP_ID.test(id) || !mapsIndex.has(id)) {
            return reply(ack, { success: false, message: 'Carte introuvable.' });
        }

        try {
            deleteMapFromDisk(id);
        } catch (err) {
            console.error('⚠️ Suppression impossible :', err.message);
            return reply(ack, { success: false, message: 'Erreur du serveur lors de la suppression.' });
        }
        broadcastMaps();
        reply(ack, { success: true, message: 'Carte supprimée.' });
    });

    /* ---------- Déconnexion ---------- */

    socket.on('disconnect', () => {
        if (socket.data.name) broadcastUsers();
    });
});

/* ------------------------------------------------------------------ */
/* Démarrage / arrêt propre                                            */
/* ------------------------------------------------------------------ */

function shutdown() {
    flushSave();
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => {
    console.log(`Serveur prêt sur http://localhost:${PORT}`);
});
