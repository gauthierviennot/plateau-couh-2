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
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

// Dossier local : utilisé seulement si Supabase n'est pas configuré (et pour le mot de passe admin de secours).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MAPS_DIR = path.join(DATA_DIR, 'maps');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const LEGACY_FILE = path.join(__dirname, 'data.json');
const PASSWORD_FILE = path.join(DATA_DIR, 'admin-password.txt');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

const LIMITS = {
    minSize: 2,
    maxSize: 300,
    maxTerrains: 30,
    maxLabel: 40,
    maxName: 15,
    maxMapName: 60,
    maxAutoBackups: 5
};
const SAVE_DELAY_MS = 2000;
const SAVE_RETRY_MS = 5000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // une session reste valable 30 jours
const SESSION_TOUCH_MS = 60 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_BLOCK_MS = 60 * 1000;

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const MAP_ID = /^[a-z0-9-]{1,64}$/;
const ARROW_DIRECTIONS = 6; // une flèche = numéro de 0 à 5, soit un pas de 60°
const MARKS = new Set(['square', 'triangle', 'diamond', 'cross']);
const EDIT_ACTIONS = new Set(['paint', 'remove', 'restore', 'arrow-add', 'arrow-remove', 'mark', 'unmark']);

// La première couleur de la légende est la couleur par défaut du plateau (la « plaine »).
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

try {
    fs.mkdirSync(MAPS_DIR, { recursive: true });
} catch (err) {
    console.warn(`⚠️ Dossier local indisponible (${err.message}).`);
}

/* ------------------------------------------------------------------ */
/* Utilitaires                                                         */
/* ------------------------------------------------------------------ */

const isHex = (value) => typeof value === 'string' && HEX_COLOR.test(value);
const reply = (ack, payload) => { if (typeof ack === 'function') ack(payload); };
const cleanText = (value, max) =>
    String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
const terrainKey = (item) => `${item.color}/${item.inner ?? ''}`;
const logError = (context) => (err) => console.error(`⚠️ ${context} :`, err.message);

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        if (err.code !== 'ENOENT') console.error(`⚠️ Lecture impossible : ${file} (${err.message})`);
        return null;
    }
}

// Écriture atomique : fichier temporaire puis renommage, pour ne jamais laisser un fichier à moitié écrit.
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

// Un terrain = couleur du grand hexagone, éventuellement une couleur "inner" (petit hexagone au centre).
function sanitizeTerrains(list) {
    if (!Array.isArray(list)) return null;
    const terrains = list
        .slice(0, LIMITS.maxTerrains)
        .filter((t) => t && isHex(t.color))
        .map((t) => {
            const terrain = { color: t.color.toLowerCase(), label: cleanText(t.label, LIMITS.maxLabel) };
            if (isHex(t.inner)) terrain.inner = t.inner.toLowerCase();
            return terrain;
        });
    return terrains.length ? terrains : null;
}

function isValidKey(key, config) {
    const match = /^(\d{1,3}),(\d{1,3})$/.exec(key);
    return Boolean(match) && Number(match[1]) < config.cols && Number(match[2]) < config.rows;
}

const isValidArrow = (value) => Number.isInteger(value) && value >= 0 && value < ARROW_DIRECTIONS;
const hasContent = (tile) => Boolean(tile.color) || isValidArrow(tile.arrow) || Boolean(tile.mark);
const keepOrNull = (tile) => (hasContent(tile) ? tile : null);

// Une case absente = plaine. Sinon : { color, inner?, arrow?, mark?, author } ou { removed: true }.
function sanitizeTile(tile) {
    if (!tile || typeof tile !== 'object') return null;
    const author = typeof tile.author === 'string' ? tile.author.slice(0, LIMITS.maxName) : '';
    if (tile.removed === true) return { removed: true, author };

    const clean = { author };
    if (isHex(tile.color)) {
        clean.color = tile.color.toLowerCase();
        if (isHex(tile.inner)) clean.inner = tile.inner.toLowerCase();
    }
    if (isValidArrow(tile.arrow)) clean.arrow = tile.arrow;
    if (MARKS.has(tile.mark)) clean.mark = tile.mark;
    return keepOrNull(clean);
}

function sanitizeGrid(grid, config) {
    const clean = {};
    if (!grid || typeof grid !== 'object') return clean;
    for (const [key, tile] of Object.entries(grid)) {
        if (!isValidKey(key, config)) continue;
        const safe = sanitizeTile(tile);
        if (safe) clean[key] = safe;
    }
    return clean;
}

// Retourne la nouvelle case, null pour la ramener à l'état vierge (plaine), ou undefined si rien ne change.
function editTile(tile, action, options, author) {
    const removed = Boolean(tile?.removed);
    switch (action) {
        case 'paint': {
            const { color, inner } = options;
            if (removed) return undefined; // une case supprimée ne peut pas être coloriée
            if (tile?.color === color && (tile?.inner ?? '') === (inner ?? '')) return undefined;
            const next = { ...tile, color, author };
            if (inner) next.inner = inner;
            else delete next.inner;
            return next;
        }
        case 'remove':
            return removed ? undefined : { removed: true, author };
        case 'restore':
            return removed ? null : undefined;
        case 'arrow-add':
            if (removed || isValidArrow(tile?.arrow)) return undefined;
            return { ...tile, author: tile?.author ?? '', arrow: 0 };
        case 'arrow-remove': {
            if (removed || !isValidArrow(tile?.arrow)) return undefined;
            const { arrow, ...rest } = tile;
            return keepOrNull(rest);
        }
        case 'mark':
            if (removed || tile?.mark === options.mark) return undefined;
            return { ...tile, author: tile?.author ?? '', mark: options.mark };
        case 'unmark': {
            if (removed || !tile?.mark) return undefined;
            const { mark, ...rest } = tile;
            return keepOrNull(rest);
        }
        default:
            return undefined;
    }
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

const metaOf = (map) => ({
    id: map.id,
    name: map.name,
    auto: Boolean(map.auto),
    author: map.author || '',
    savedAt: map.savedAt || 0,
    cols: map.config.cols,
    rows: map.config.rows,
    tiles: Object.keys(map.gridData || {}).length
});

/* ------------------------------------------------------------------ */
/* Stockage : Supabase si configuré, sinon fichiers locaux             */
/* ------------------------------------------------------------------ */

const mapFile = (id) => path.join(MAPS_DIR, `${id}.json`);

const fileStorage = {
    label: 'fichiers locaux (data/) : ils sont effacés à chaque redéploiement sur Render gratuit',

    async loadState() {
        if (fs.existsSync(STATE_FILE)) {
            const raw = readJson(STATE_FILE);
            if (raw) return raw;
            const backup = `${STATE_FILE}.corrompu-${Date.now()}`;
            fs.renameSync(STATE_FILE, backup);
            console.error(`⚠️ state.json illisible, copie conservée dans ${backup}`);
        }
        if (fs.existsSync(LEGACY_FILE)) {
            const raw = readJson(LEGACY_FILE);
            if (raw) console.log('✅ Ancien data.json trouvé : il sert de point de départ.');
            return raw;
        }
        return null;
    },
    async saveState(state) {
        writeJsonAtomic(STATE_FILE, state);
    },

    async listMaps() {
        const metas = [];
        for (const file of fs.readdirSync(MAPS_DIR)) {
            if (!file.endsWith('.json')) continue;
            const id = file.slice(0, -5);
            if (!MAP_ID.test(id)) continue;
            const map = readJson(path.join(MAPS_DIR, file));
            if (map && sanitizeConfig(map.config)) metas.push(metaOf({ ...map, id }));
        }
        return metas;
    },
    async getMap(id) {
        return readJson(mapFile(id));
    },
    async putMap(map) {
        writeJsonAtomic(mapFile(map.id), map);
    },
    async renameMap(id, name) {
        const map = readJson(mapFile(id));
        if (!map) throw new Error('Carte introuvable');
        map.name = name;
        map.auto = false; // une carte renommée n'est plus supprimée automatiquement
        writeJsonAtomic(mapFile(id), map);
    },
    async deleteMap(id) {
        try {
            fs.unlinkSync(mapFile(id));
        } catch (err) {
            if (err.code !== 'ENOENT') throw err;
        }
    },

    sessionsCache: null,
    async loadSessions() {
        this.sessionsCache = readJson(SESSIONS_FILE) || {};
        return this.sessionsCache;
    },
    async saveSession(token, session) {
        this.sessionsCache = this.sessionsCache || {};
        this.sessionsCache[token] = session;
        writeJsonAtomic(SESSIONS_FILE, this.sessionsCache);
    },
    async deleteSession(token) {
        this.sessionsCache = this.sessionsCache || {};
        delete this.sessionsCache[token];
        writeJsonAtomic(SESSIONS_FILE, this.sessionsCache);
    }
};

function createSupabaseStorage() {
    const { createClient } = require('@supabase/supabase-js');
    const db = createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false }
    });
    const check = ({ error }) => {
        if (error) throw new Error(error.message);
    };

    return {
        label: 'Supabase (base de données)',

        async loadState() {
            const res = await db.from('app_state').select('data').eq('id', 'main').maybeSingle();
            check(res);
            return res.data?.data ?? null;
        },
        async saveState(state) {
            check(await db.from('app_state').upsert({ id: 'main', data: state, updated_at: new Date().toISOString() }));
        },

        async listMaps() {
            const res = await db.from('saved_maps').select('id,name,auto,author,saved_at,cols,rows,tiles');
            check(res);
            return res.data.map((row) => ({
                id: row.id,
                name: row.name,
                auto: row.auto,
                author: row.author,
                savedAt: Number(row.saved_at),
                cols: row.cols,
                rows: row.rows,
                tiles: row.tiles
            }));
        },
        async getMap(id) {
            const res = await db.from('saved_maps').select('*').eq('id', id).maybeSingle();
            check(res);
            const row = res.data;
            if (!row) return null;
            return {
                id: row.id,
                name: row.name,
                auto: row.auto,
                author: row.author,
                savedAt: Number(row.saved_at),
                config: { cols: row.cols, rows: row.rows },
                terrainsList: row.terrains,
                gridData: row.grid
            };
        },
        async putMap(map) {
            check(await db.from('saved_maps').upsert({
                id: map.id,
                name: map.name,
                auto: map.auto,
                author: map.author,
                saved_at: map.savedAt,
                cols: map.config.cols,
                rows: map.config.rows,
                tiles: Object.keys(map.gridData).length,
                terrains: map.terrainsList,
                grid: map.gridData
            }));
        },
        async renameMap(id, name) {
            check(await db.from('saved_maps').update({ name, auto: false }).eq('id', id));
        },
        async deleteMap(id) {
            check(await db.from('saved_maps').delete().eq('id', id));
        },

        async loadSessions() {
            check(await db.from('sessions').delete().lt('last_seen', Date.now() - SESSION_TTL_MS));
            const res = await db.from('sessions').select('*');
            check(res);
            return Object.fromEntries(res.data.map((row) => [row.token, {
                name: row.name,
                isAdmin: row.is_admin,
                fp: row.fp,
                lastSeen: Number(row.last_seen)
            }]));
        },
        async saveSession(token, session) {
            check(await db.from('sessions').upsert({
                token,
                name: session.name,
                is_admin: session.isAdmin,
                fp: session.fp,
                last_seen: session.lastSeen
            }));
        },
        async deleteSession(token) {
            check(await db.from('sessions').delete().eq('token', token));
        }
    };
}

const storage = SUPABASE_URL && SUPABASE_KEY ? createSupabaseStorage() : fileStorage;

/* ------------------------------------------------------------------ */
/* État courant du plateau                                             */
/* ------------------------------------------------------------------ */

let state = null; // chargé au démarrage
let saveTimer = null;
let saveChain = Promise.resolve();

// Les peintures arrivent en rafale : on regroupe les écritures et on les sérialise.
function saveNow() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    saveChain = saveChain
        .then(() => storage.saveState(state))
        .catch((err) => {
            console.error('⚠️ Sauvegarde du plateau impossible, nouvel essai bientôt :', err.message);
            scheduleSave(SAVE_RETRY_MS);
        });
    return saveChain;
}

function scheduleSave(delay = SAVE_DELAY_MS) {
    if (!saveTimer) saveTimer = setTimeout(saveNow, delay);
}

/* ------------------------------------------------------------------ */
/* Cartes enregistrées                                                 */
/* ------------------------------------------------------------------ */

const mapsIndex = new Map(); // id -> métadonnées (sans la grille, pour rester léger)

const listMaps = () => [...mapsIndex.values()].sort((a, b) => b.savedAt - a.savedAt);

async function saveMap({ id, name, auto = false }, author) {
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
    await storage.putMap(map);
    const meta = metaOf(map);
    mapsIndex.set(mapId, meta);
    return meta;
}

async function deleteMap(id) {
    await storage.deleteMap(id);
    mapsIndex.delete(id);
}

// Filet de sécurité avant toute action qui écrase le plateau.
async function createAutoBackup(reason, author) {
    if (Object.keys(state.gridData).length === 0) return;

    const stamp = new Date().toLocaleString('fr-FR');
    await saveMap({ name: `Sauvegarde auto (${reason}) ${stamp}`, auto: true }, author);

    const autos = [...mapsIndex.values()].filter((m) => m.auto).sort((a, b) => a.savedAt - b.savedAt);
    while (autos.length > LIMITS.maxAutoBackups) await deleteMap(autos.shift().id);
}

/* ------------------------------------------------------------------ */
/* Authentification admin et sessions                                  */
/* ------------------------------------------------------------------ */

function loadAdminPassword() {
    if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;

    try {
        const saved = fs.readFileSync(PASSWORD_FILE, 'utf8').trim();
        if (saved) return saved;
    } catch { /* fichier absent : on en génère un */ }

    const generated = crypto.randomBytes(9).toString('base64url');
    try {
        fs.writeFileSync(PASSWORD_FILE, `${generated}\n`, { mode: 0o600 });
    } catch { /* disque en lecture seule : le mot de passe ne survivra pas au redémarrage */ }
    console.log('🔑 Mot de passe admin généré (pseudo « admin ») :', generated);
    console.log('   Définissez la variable ADMIN_PASSWORD pour le fixer durablement.');
    return generated;
}

const ADMIN_PASSWORD = loadAdminPassword();
const ADMIN_FINGERPRINT = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest('hex').slice(0, 16);

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

const sessions = new Map(); // jeton -> { name, isAdmin, fp, lastSeen }

function createSession(name, isAdmin) {
    const token = crypto.randomBytes(24).toString('base64url');
    const session = { name, isAdmin, fp: isAdmin ? ADMIN_FINGERPRINT : '', lastSeen: Date.now() };
    sessions.set(token, session);
    storage.saveSession(token, session).catch(logError('Enregistrement de la session'));
    return token;
}

function dropSession(token) {
    if (sessions.delete(token)) storage.deleteSession(token).catch(logError('Suppression de la session'));
}

/* ------------------------------------------------------------------ */
/* Serveur HTTP + Socket.IO                                            */
/* ------------------------------------------------------------------ */

const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
// Délais plus larges : un téléphone en veille ne doit pas être considéré comme déconnecté trop vite.
const io = new Server(server, { pingInterval: 20000, pingTimeout: 60000 });

function connectedUsers() {
    const names = [];
    for (const s of io.sockets.sockets.values()) {
        if (s.data.name) names.push(s.data.name);
    }
    return [...new Set(names)];
}

const broadcastUsers = () => io.emit('update-users-list', connectedUsers());
const broadcastMaps = () => io.to('admins').emit('maps-list', listMaps());
// changes : { "col,ligne": case | null }
const broadcastTiles = (changes) => io.emit('update-tiles', { changes });

function releaseSession(s) {
    s.data.name = '';
    s.data.isAdmin = false;
    s.data.token = '';
    s.leave('admins');
}

function requireAdmin(socket, ack) {
    if (socket.data.isAdmin) return true;
    reply(ack, { success: false, message: 'Action réservée à l’administrateur.' });
    return false;
}

// Applique une action sur des cases, sauvegarde et diffuse uniquement ce qui a changé.
function applyEdits(keys, action, options, author) {
    const changes = {};
    for (const key of new Set(keys)) {
        if (!isValidKey(key, state.config)) continue;
        const next = editTile(state.gridData[key], action, options, author);
        if (next === undefined) continue;

        if (next === null) delete state.gridData[key];
        else state.gridData[key] = next;
        changes[key] = next;
    }
    if (Object.keys(changes).length > 0) {
        scheduleSave();
        broadcastTiles(changes);
    }
}

// Évite qu'une erreur de stockage ne fasse tomber le serveur : le client reçoit un message clair.
const guarded = (handler) => async (payload, ack) => {
    try {
        await handler(payload, ack);
    } catch (err) {
        console.error('⚠️ Erreur de stockage :', err.message);
        reply(ack, { success: false, message: 'Erreur du serveur (stockage). Réessayez.' });
    }
};

io.on('connection', (socket) => {
    socket.data = { name: '', clientId: '', isAdmin: false, token: '' };

    socket.emit('init', {
        config: state.config,
        gridData: state.gridData,
        terrains: state.terrainsList,
        users: connectedUsers(),
        isLocked: state.isLocked
    });

    /* ---------- Connexion ---------- */

    socket.on('set-username', (payload, ack) => {
        const ip = socket.handshake.address;
        const clientId = cleanText(payload?.clientId, 64);
        let name;
        let wantsAdmin;
        let token = '';

        if (payload?.token) {
            // Reprise de session : pas besoin de ressaisir le mot de passe admin.
            token = String(payload.token);
            const session = sessions.get(token);
            const invalid = !session
                || Date.now() - session.lastSeen > SESSION_TTL_MS
                || (session.isAdmin && session.fp !== ADMIN_FINGERPRINT);
            if (invalid) {
                dropSession(token);
                return reply(ack, { success: false, code: 'session-expired', message: 'Session expirée, reconnectez-vous.' });
            }
            name = session.name;
            wantsAdmin = session.isAdmin;
        } else {
            name = cleanText(payload?.name, LIMITS.maxName);
            if (!name) return reply(ack, { success: false, message: 'Pseudo invalide.' });

            wantsAdmin = name.toLowerCase() === 'admin';
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

        if (token) {
            const session = sessions.get(token);
            if (Date.now() - session.lastSeen > SESSION_TOUCH_MS) {
                session.lastSeen = Date.now();
                storage.saveSession(token, session).catch(logError('Mise à jour de la session'));
            }
        } else {
            token = createSession(name, wantsAdmin);
        }

        socket.data = { name, clientId, isAdmin: wantsAdmin, token };
        if (wantsAdmin) {
            socket.join('admins');
            socket.emit('maps-list', listMaps());
        }
        broadcastUsers();
        reply(ack, { success: true, name, isAdmin: wantsAdmin, token });
    });

    socket.on('logout', (payload, ack) => {
        if (socket.data.token) dropSession(socket.data.token);
        releaseSession(socket);
        broadcastUsers();
        reply(ack, { success: true });
    });

    /* ---------- Cases (tous les joueurs connectés, plateau déverrouillé) ---------- */

    socket.on('paint-tile', (data) => {
        if (state.isLocked || !socket.data.name) return;

        const color = data?.color;
        if (!isValidKey(data?.key, state.config) || !isHex(color)) return;

        const inner = isHex(data.inner) ? data.inner.toLowerCase() : '';
        applyEdits([data.key], 'paint', { color: color.toLowerCase(), inner }, socket.data.name);
    });

    // Ajout ou retrait d'une flèche : ouvert à tous les joueurs.
    socket.on('arrow-tile', (data) => {
        if (state.isLocked || !socket.data.name) return;
        if (!isValidKey(data?.key, state.config)) return;

        applyEdits([data.key], data.remove === true ? 'arrow-remove' : 'arrow-add', {}, socket.data.name);
    });

    // Double toucher sur une flèche : rotation d'un sixième de tour.
    socket.on('rotate-arrow', (data) => {
        if (state.isLocked || !socket.data.name) return;

        const key = data?.key;
        if (!isValidKey(key, state.config)) return;

        const tile = state.gridData[key];
        if (!tile || tile.removed || !isValidArrow(tile.arrow)) return;

        tile.arrow = (tile.arrow + 1) % ARROW_DIRECTIONS;
        scheduleSave();
        broadcastTiles({ [key]: tile });
    });

    /* ---------- Actions admin ---------- */

    // Rectangle de sélection, gomme, marques : uniquement pour l'administrateur.
    socket.on('edit-tiles', (data) => {
        if (!requireAdmin(socket) || state.isLocked) return;

        const action = data?.action;
        if (!EDIT_ACTIONS.has(action)) return;

        const options = {};
        if (action === 'paint') {
            if (!isHex(data.color)) return;
            options.color = data.color.toLowerCase();
            options.inner = isHex(data.inner) ? data.inner.toLowerCase() : '';
        }
        if (action === 'mark') {
            if (!MARKS.has(data.mark)) return;
            options.mark = data.mark;
        }

        const keys = Array.isArray(data.keys) ? data.keys.slice(0, LIMITS.maxSize * LIMITS.maxSize) : [];
        applyEdits(keys, action, options, socket.data.name);
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

        // Si l'admin modifie une couleur (ou l'hexagone intérieur) de la légende,
        // les cases déjà peintes avec l'ancien aspect suivent automatiquement.
        const changes = {};
        const previous = state.terrainsList;
        if (terrains.length === previous.length) {
            const remap = new Map();
            terrains.forEach((next, index) => {
                if (terrainKey(next) !== terrainKey(previous[index])) remap.set(terrainKey(previous[index]), next);
            });

            if (remap.size > 0) {
                for (const [key, tile] of Object.entries(state.gridData)) {
                    if (tile.removed || !tile.color) continue;
                    const target = remap.get(terrainKey(tile));
                    if (!target) continue;

                    tile.color = target.color;
                    if (target.inner) tile.inner = target.inner;
                    else delete tile.inner;
                    changes[key] = tile;
                }
            }
        }

        state.terrainsList = terrains;
        scheduleSave();
        io.emit('update-terrains', state.terrainsList);
        if (Object.keys(changes).length > 0) broadcastTiles(changes);
    });

    socket.on('change-config', guarded(async (newConfig, ack) => {
        if (!requireAdmin(socket, ack)) return;
        const config = sanitizeConfig(newConfig);
        if (!config) {
            return reply(ack, {
                success: false,
                message: `Taille invalide (entre ${LIMITS.minSize} et ${LIMITS.maxSize}).`
            });
        }

        await createAutoBackup('changement de taille', socket.data.name);
        state.config = config;
        state.gridData = {}; // toutes les cases redeviennent des plaines
        await saveNow();
        io.emit('update-config', { config: state.config, gridData: state.gridData });
        broadcastMaps();
        reply(ack, { success: true, message: 'Taille modifiée. Une sauvegarde automatique a été créée.' });
    }));

    /* ---------- Cartes enregistrées ---------- */

    socket.on('list-maps', () => {
        if (socket.data.isAdmin) socket.emit('maps-list', listMaps());
    });

    socket.on('save-map', guarded(async (payload, ack) => {
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

        await saveMap({ id, name }, socket.data.name);
        broadcastMaps();
        reply(ack, { success: true, message: `Carte « ${name} » enregistrée.` });
    }));

    socket.on('load-map', guarded(async (payload, ack) => {
        if (!requireAdmin(socket, ack)) return;

        const id = String(payload?.id ?? '');
        if (!MAP_ID.test(id) || !mapsIndex.has(id)) {
            return reply(ack, { success: false, message: 'Carte introuvable.' });
        }

        const map = await storage.getMap(id);
        const config = sanitizeConfig(map?.config);
        if (!config) return reply(ack, { success: false, message: 'Fichier de carte illisible.' });

        const gridData = sanitizeGrid(map.gridData, config);
        const terrains = sanitizeTerrains(map.terrainsList);

        await createAutoBackup('avant chargement', socket.data.name);

        state.config = config;
        state.gridData = gridData;
        if (terrains) state.terrainsList = terrains;
        await saveNow();

        io.emit('update-config', { config: state.config, gridData: state.gridData });
        io.emit('update-terrains', state.terrainsList);
        broadcastMaps();
        reply(ack, { success: true, message: `Carte « ${map.name} » chargée.` });
    }));

    socket.on('rename-map', guarded(async (payload, ack) => {
        if (!requireAdmin(socket, ack)) return;

        const id = String(payload?.id ?? '');
        const name = cleanText(payload?.name, LIMITS.maxMapName);
        if (!name) return reply(ack, { success: false, message: 'Le nom ne peut pas être vide.' });
        if (!MAP_ID.test(id) || !mapsIndex.has(id)) {
            return reply(ack, { success: false, message: 'Carte introuvable.' });
        }

        await storage.renameMap(id, name);
        const meta = mapsIndex.get(id);
        meta.name = name;
        meta.auto = false;
        broadcastMaps();
        reply(ack, { success: true, message: 'Carte renommée.' });
    }));

    socket.on('delete-map', guarded(async (payload, ack) => {
        if (!requireAdmin(socket, ack)) return;

        const id = String(payload?.id ?? '');
        if (!MAP_ID.test(id) || !mapsIndex.has(id)) {
            return reply(ack, { success: false, message: 'Carte introuvable.' });
        }

        await deleteMap(id);
        broadcastMaps();
        reply(ack, { success: true, message: 'Carte supprimée.' });
    }));

    /* ---------- Déconnexion ---------- */

    socket.on('disconnect', () => {
        if (socket.data.name) broadcastUsers();
    });
});

/* ------------------------------------------------------------------ */
/* Démarrage / arrêt propre                                            */
/* ------------------------------------------------------------------ */

async function start() {
    console.log(`💾 Stockage : ${storage.label}`);

    let raw = await storage.loadState();
    if (!raw && storage !== fileStorage) {
        // Première utilisation de Supabase : on récupère d'éventuelles données locales.
        raw = await fileStorage.loadState();
        if (raw) console.log('✅ Données locales trouvées : elles sont importées dans Supabase.');
    }
    if (!raw) console.log('🆕 Aucune donnée trouvée : plateau par défaut (150x100).');

    state = normalizeState(raw);
    await storage.saveState(state);

    for (const meta of await storage.listMaps()) mapsIndex.set(meta.id, meta);
    console.log(`🗺️  ${mapsIndex.size} carte(s) enregistrée(s).`);

    const now = Date.now();
    for (const [token, session] of Object.entries(await storage.loadSessions())) {
        if (session && typeof session.name === 'string' && now - session.lastSeen < SESSION_TTL_MS) {
            sessions.set(token, session);
        }
    }

    server.listen(PORT, () => {
        console.log(`Serveur prêt sur http://localhost:${PORT}`);
    });
}

async function shutdown() {
    try {
        await saveNow();
    } finally {
        process.exit(0);
    }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start().catch((err) => {
    console.error('❌ Démarrage impossible :', err.message);
    if (storage !== fileStorage) {
        console.error('   Vérifiez SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, et que supabase-schema.sql a été exécuté.');
    }
    process.exit(1);
});
