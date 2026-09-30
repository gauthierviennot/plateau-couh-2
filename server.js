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
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const BACKGROUND_FILE = path.join(DATA_DIR, 'background.json');
const BACKGROUND_MAX_BYTES = 3 * 1024 * 1024; // image de fond de la page de connexion
const HISTORY_MAX_BATCHES = 100; // annuler / rétablir : 100 actions par joueur
const HISTORY_MAX_ENTRIES = 30000;

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
const MARKS = new Set(['square', 'triangle', 'diamond', 'cross', 'disc', 'x']);
const EDIT_ACTIONS = new Set(['terrain', 'object', 'remove', 'restore', 'mark', 'unmark']);
const ADMIN_NAME = 'mj';

// Terrains : liste fixe, seules les couleurs sont modifiables par l'admin. La plaine est le terrain par défaut.
const DEFAULT_TERRAINS = [
    { id: 'plain', color: '#8fd16b' },
    { id: 'hill', color: '#d9b44a' },
    { id: 'mountain', color: '#8a6d54' },
    { id: 'path', color: '#e2cfa3' },
    { id: 'water', color: '#4aa3df' },
    { id: 'swamp', color: '#6f9070' }
];
const TERRAIN_IDS = DEFAULT_TERRAINS.map((t) => t.id);
// Anciennes couleurs des versions précédentes, rattachées au terrain le plus proche.
const LEGACY_TERRAINS = { '#2ecc71': 'plain', '#f1c40f': 'hill', '#783f04': 'mountain', '#3498db': 'water' };

// Objets posés à la place du petit hexagone central.
// turns = nombre d'orientations : 1 = aucune, 3 = bidirectionnel (pont, muret), 6 = une seule direction.
const GROUND = ['plain', 'hill'];
const OBJECT_RULES = {
    forest: { turns: 1, on: GROUND },
    bridge: { turns: 3, on: ['water'] },
    fortress: { turns: 1, on: GROUND },
    'fortress-half': { turns: 6, on: GROUND },
    village: { turns: 1, on: GROUND },
    'village-flat': { turns: 1, on: GROUND },
    wall: { turns: 3, on: GROUND }
};
const isObjectId = (id) => typeof id === 'string' && Object.prototype.hasOwnProperty.call(OBJECT_RULES, id);
const objectAllowed = (object, terrain) => isObjectId(object) && OBJECT_RULES[object].on.includes(terrain);

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

// Terrains : liste fixe ; seules les couleurs sont conservées.
function sanitizeTerrains(list) {
    const byId = new Map();
    if (Array.isArray(list)) {
        for (const t of list) {
            if (t && typeof t.id === 'string') byId.set(t.id, t);
        }
    }
    return DEFAULT_TERRAINS.map((d) => {
        const color = byId.get(d.id)?.color;
        return { id: d.id, color: isHex(color) ? color.toLowerCase() : d.color };
    });
}

function isValidKey(key, config) {
    const match = /^(\d{1,3}),(\d{1,3})$/.exec(key);
    return Boolean(match) && Number(match[1]) < config.cols && Number(match[2]) < config.rows;
}

const hasContent = (tile) => Boolean(tile.terrain) || Boolean(tile.object) || Boolean(tile.mark);
const keepOrNull = (tile) => (hasContent(tile) ? tile : null);

// Une case absente = plaine. Sinon : { terrain?, object?, dir?, mark?, author, objectAuthor? } ou { removed: true }.
function sanitizeTile(tile) {
    if (!tile || typeof tile !== 'object') return null;
    const author = typeof tile.author === 'string' ? tile.author.slice(0, LIMITS.maxName) : '';
    if (tile.removed === true) return { removed: true, author };

    const clean = { author };
    const terrain = TERRAIN_IDS.includes(tile.terrain)
        ? tile.terrain
        : LEGACY_TERRAINS[String(tile.color ?? '').toLowerCase()];
    if (terrain) clean.terrain = terrain;

    if (objectAllowed(tile.object, clean.terrain ?? 'plain')) {
        clean.object = tile.object;
        const { turns } = OBJECT_RULES[tile.object];
        if (turns > 1) clean.dir = Number.isInteger(tile.dir) && tile.dir >= 0 && tile.dir < turns ? tile.dir : 0;
        if (typeof tile.objectAuthor === 'string') clean.objectAuthor = tile.objectAuthor.slice(0, LIMITS.maxName);
    }
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
        case 'terrain': {
            const { terrain } = options;
            if (removed) return undefined; // une case supprimée ne peut pas être coloriée
            // Poser une tuile de terrain remplace la tuile : l'objet éventuel disparaît, même si le terrain est identique.
            if ((tile?.terrain ?? 'plain') === terrain && !tile?.object) return undefined;
            const next = { ...tile, terrain, author };
            delete next.object;
            delete next.dir;
            delete next.objectAuthor;
            return next;
        }
        case 'object': {
            const { object } = options;
            if (removed || !objectAllowed(object, tile?.terrain ?? 'plain') || tile?.object === object) return undefined;
            const next = { ...tile, author: tile?.author ?? '', object, objectAuthor: author };
            if (OBJECT_RULES[object].turns > 1) next.dir = 0;
            else delete next.dir;
            return next;
        }
        case 'rotate': {
            const turns = isObjectId(tile?.object) ? OBJECT_RULES[tile.object].turns : 1;
            if (removed || turns <= 1) return undefined;
            return { ...tile, dir: ((tile.dir ?? 0) + 1) % turns };
        }
        case 'remove':
            return removed ? undefined : { removed: true, author };
        case 'restore':
            return removed ? null : undefined;
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
        terrainsList: sanitizeTerrains(raw?.terrainsList ?? raw?.terrains),
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

    async loadBackground() {
        const raw = readJson(BACKGROUND_FILE);
        if (!raw?.image) return null;
        return { buffer: Buffer.from(raw.image, 'base64'), version: raw.version || 1 };
    },
    async saveBackground(bg) {
        if (!bg) {
            try {
                fs.unlinkSync(BACKGROUND_FILE);
            } catch (err) {
                if (err.code !== 'ENOENT') throw err;
            }
            return;
        }
        writeJsonAtomic(BACKGROUND_FILE, { version: bg.version, image: bg.buffer.toString('base64') });
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

        async loadBackground() {
            const res = await db.from('app_state').select('data').eq('id', 'background').maybeSingle();
            check(res);
            const data = res.data?.data;
            if (!data?.image) return null;
            return { buffer: Buffer.from(data.image, 'base64'), version: data.version || 1 };
        },
        async saveBackground(bg) {
            if (!bg) {
                check(await db.from('app_state').delete().eq('id', 'background'));
                return;
            }
            check(await db.from('app_state').upsert({
                id: 'background',
                data: { version: bg.version, image: bg.buffer.toString('base64') },
                updated_at: new Date().toISOString()
            }));
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
let background = null; // { buffer, version } : image de fond de la page de connexion
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

// Code secret de l'administrateur (pseudo MJ) : « mj » par défaut, ou la variable ADMIN_PASSWORD si elle est définie.
function loadAdminPassword() {
    return process.env.ADMIN_PASSWORD || 'mj';
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

// Image de fond de la page de connexion ; le numéro de version dans l'adresse permet un cache durable.
app.get('/background.jpg', (req, res) => {
    if (!background) return res.status(404).end();
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' });
    return res.send(background.buffer);
});

const server = http.createServer(app);
// Délais plus larges : un téléphone en veille ne doit pas être considéré comme déconnecté trop vite.
const io = new Server(server, { pingInterval: 20000, pingTimeout: 60000, maxHttpBufferSize: 6e6 });

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

// Historique annuler / rétablir : un par joueur (en mémoire, perdu au redémarrage du serveur).
const histories = new Map(); // pseudo -> { undo: [lot], redo: [lot] } ; lot = [{ key, before, after }] (JSON)

function historyOf(name) {
    if (!histories.has(name)) histories.set(name, { undo: [], redo: [] });
    return histories.get(name);
}

function recordHistory(name, batch) {
    const history = historyOf(name);
    history.undo.push(batch);
    history.redo = [];
    let total = history.undo.reduce((sum, b) => sum + b.length, 0);
    while (history.undo.length > HISTORY_MAX_BATCHES || (total > HISTORY_MAX_ENTRIES && history.undo.length > 1)) {
        total -= history.undo.shift().length;
    }
}

// Rejoue un lot en sens inverse. Une case modifiée depuis par quelqu'un d'autre est laissée telle quelle.
function replayBatch(grid, batch) {
    const changes = {};
    const inverse = [];
    for (const { key, before, after } of batch) {
        if (JSON.stringify(grid[key] ?? null) !== after) continue;
        const tile = JSON.parse(before);
        if (tile) grid[key] = tile;
        else delete grid[key];
        changes[key] = tile;
        inverse.push({ key, before: after, after: before });
    }
    return { changes, inverse };
}

// Applique une action sur des cases, sauvegarde, diffuse uniquement ce qui a changé et l'inscrit dans l'historique.
function applyEdits(keys, action, options, author) {
    const changes = {};
    const batch = [];
    for (const key of new Set(keys)) {
        if (!isValidKey(key, state.config)) continue;
        const previous = state.gridData[key];
        const next = editTile(previous, action, options, author);
        if (next === undefined) continue;

        if (next === null) delete state.gridData[key];
        else state.gridData[key] = next;
        changes[key] = next;
        batch.push({ key, before: JSON.stringify(previous ?? null), after: JSON.stringify(next) });
    }
    if (batch.length > 0) {
        recordHistory(author, batch);
        scheduleSave();
        broadcastTiles(changes);
    }
}

function runHistory(socket, ack, from, to) {
    if (!socket.data.name) return reply(ack, { success: false, message: 'Connectez-vous d’abord.' });
    if (state.isLocked) return reply(ack, { success: false, message: 'Le plateau est verrouillé.' });

    const history = historyOf(socket.data.name);
    const batch = history[from].pop();
    if (!batch) return reply(ack, { success: false, message: from === 'undo' ? 'Rien à annuler.' : 'Rien à rétablir.' });

    const { changes, inverse } = replayBatch(state.gridData, batch);
    if (inverse.length === 0) {
        return reply(ack, { success: false, message: 'Ces cases ont été modifiées par quelqu’un d’autre : impossible.' });
    }
    history[to].push(inverse);
    scheduleSave();
    broadcastTiles(changes);
    const label = from === 'undo' ? 'Annulé' : 'Rétabli';
    return reply(ack, { success: true, message: `${label} (${inverse.length} case${inverse.length > 1 ? 's' : ''}).` });
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
        isLocked: state.isLocked,
        backgroundVersion: background?.version ?? 0
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

            wantsAdmin = name.toLowerCase() === ADMIN_NAME;
            if (wantsAdmin) {
                if (isBlocked(ip)) {
                    return reply(ack, { success: false, message: 'Trop de tentatives. Réessayez dans une minute.' });
                }
                if (!passwordMatches(payload?.password)) {
                    registerFailure(ip);
                    return reply(ack, { success: false, message: 'Mot de passe administrateur incorrect.' });
                }
                loginFailures.delete(ip);
                name = 'MJ';
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

    // Pinceau : terrain, objet, ou retrait de l'objet.
    socket.on('paint-tile', (data) => {
        if (state.isLocked || !socket.data.name) return;
        if (!isValidKey(data?.key, state.config)) return;

        const options = {};
        let action;
        if (data.kind === 'terrain' && TERRAIN_IDS.includes(data.id)) {
            action = 'terrain';
            options.terrain = data.id;
        } else if (data.kind === 'object' && isObjectId(data.id)) {
            action = 'object';
            options.object = data.id;
        } else {
            return;
        }
        applyEdits([data.key], action, options, socket.data.name);
    });

    // Double toucher : fait pivoter un objet orienté (pont, muret, forteresse à deux faces crénelées).
    socket.on('rotate-object', (data) => {
        if (state.isLocked || !socket.data.name) return;
        if (!isValidKey(data?.key, state.config)) return;
        applyEdits([data.key], 'rotate', {}, socket.data.name);
    });

    /* ---------- Actions admin ---------- */

    // Rectangle de sélection, gomme, marques : uniquement pour l'administrateur.
    socket.on('edit-tiles', (data) => {
        if (!requireAdmin(socket) || state.isLocked) return;

        const action = data?.action;
        if (!EDIT_ACTIONS.has(action)) return;

        const options = {};
        if (action === 'terrain') {
            if (!TERRAIN_IDS.includes(data.terrain)) return;
            options.terrain = data.terrain;
        }
        if (action === 'object') {
            if (!isObjectId(data.object)) return;
            options.object = data.object;
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

    // Les cases référencent leur terrain par son nom : elles suivent automatiquement la nouvelle couleur.
    socket.on('update-terrains', (list) => {
        if (!requireAdmin(socket)) return;
        state.terrainsList = sanitizeTerrains(list);
        scheduleSave();
        io.emit('update-terrains', state.terrainsList);
    });

    // La taille du plateau ne se règle qu'à la création d'une nouvelle carte.
    socket.on('new-map', guarded(async (newConfig, ack) => {
        if (!requireAdmin(socket, ack)) return;
        const config = sanitizeConfig(newConfig);
        if (!config) {
            return reply(ack, {
                success: false,
                message: `Taille invalide (entre ${LIMITS.minSize} et ${LIMITS.maxSize}).`
            });
        }

        await createAutoBackup('nouvelle carte', socket.data.name);
        state.config = config;
        state.gridData = {}; // toutes les cases redeviennent des plaines
        histories.clear();
        await saveNow();
        io.emit('update-config', { config: state.config, gridData: state.gridData });
        broadcastMaps();
        reply(ack, { success: true, message: 'Nouvelle carte créée. L’ancienne a été sauvegardée automatiquement.' });
    }));

    /* ---------- Annuler / rétablir (chacun ses propres modifications) ---------- */

    socket.on('undo', (payload, ack) => runHistory(socket, ack, 'undo', 'redo'));
    socket.on('redo', (payload, ack) => runHistory(socket, ack, 'redo', 'undo'));

    /* ---------- Image de fond de la page de connexion (MJ) ---------- */

    socket.on('set-background', guarded(async (payload, ack) => {
        if (!requireAdmin(socket, ack)) return;

        const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(payload?.dataUrl ?? ''));
        if (!match) return reply(ack, { success: false, message: 'Image invalide (JPEG attendu).' });

        const buffer = Buffer.from(match[1], 'base64');
        if (buffer.length > BACKGROUND_MAX_BYTES || buffer[0] !== 0xFF || buffer[1] !== 0xD8) {
            return reply(ack, { success: false, message: 'Image trop lourde ou illisible.' });
        }

        background = { buffer, version: Date.now() };
        await storage.saveBackground(background);
        io.emit('update-background', { version: background.version });
        reply(ack, { success: true, message: 'Image de fond enregistrée.' });
    }));

    socket.on('clear-background', guarded(async (payload, ack) => {
        if (!requireAdmin(socket, ack)) return;
        background = null;
        await storage.saveBackground(null);
        io.emit('update-background', { version: 0 });
        reply(ack, { success: true, message: 'Image de fond retirée.' });
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
        histories.clear();
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

    background = await storage.loadBackground();

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
