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

// Fiches d'armée : données d'origine dans fiches-seed.json ; les modifications du MJ sont enregistrées dans le stockage.
const FICHES_SEED_FILE = path.join(__dirname, 'fiches-seed.json');
const DOCS_DIR = path.join(DATA_DIR, 'docs');
const FICHES_MAX_BYTES = 800 * 1024;
const FICHES_MAX_UNITS = 600;
const DOC_ID = /^[a-z0-9_]{1,64}$/;
const LEG_ID = /^[A-Za-z0-9_-]{1,12}$/;
const FAM_ID = /^[a-z0-9_]{1,24}$/;
const FAM_COLS = new Set(['S', 'F', 'J', 'L', 'M', 'Q', 'R', 'W', 'X', 'val']);

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
    // Dates des dernières modifications : elles servent à la protection des tuiles (voir « libérer mes modifications »).
    if (Number.isFinite(tile.at)) clean.at = tile.at;
    if (clean.object && Number.isFinite(tile.oat)) clean.oat = tile.oat;
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
            const next = { ...tile, terrain, author, at: Date.now() };
            delete next.object;
            delete next.dir;
            delete next.objectAuthor;
            delete next.oat;
            return next;
        }
        case 'object': {
            const { object } = options;
            if (removed || !objectAllowed(object, tile?.terrain ?? 'plain') || tile?.object === object) return undefined;
            const next = { ...tile, author: tile?.author ?? '', object, objectAuthor: author, oat: Date.now() };
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

// Protection : par joueur, « on » (les autres confirment avant de modifier ses tuiles) et « clearedAt »
// (les modifications antérieures à cette date sont définitivement libérées).
function sanitizeProtection(raw) {
    const clean = Object.create(null);
    if (!raw || typeof raw !== 'object') return clean;
    for (const [name, rule] of Object.entries(raw).slice(0, 500)) {
        if (name.length > LIMITS.maxName || !rule || typeof rule !== 'object') continue;
        clean[name] = { on: rule.on !== false, clearedAt: Number.isFinite(rule.clearedAt) ? rule.clearedAt : 0 };
    }
    return clean;
}

// Équipes gérées par le MJ : noms, appartenance de chaque pseudo, liste des pseudos connus.
function sanitizeTeams(raw) {
    const out = { names: { t1: 'Équipe 1', t2: 'Équipe 2' }, members: Object.create(null), roster: [] };
    if (!raw || typeof raw !== 'object') return out;
    for (const key of ['t1', 't2']) {
        const label = raw.names?.[key];
        if (typeof label === 'string' && label.trim()) out.names[key] = label.trim().slice(0, 30);
    }
    if (raw.members && typeof raw.members === 'object') {
        for (const [name, team] of Object.entries(raw.members).slice(0, 500)) {
            if (name.length <= LIMITS.maxName && (team === 't1' || team === 't2')) out.members[name] = team;
        }
    }
    if (Array.isArray(raw.roster)) {
        for (const name of raw.roster.slice(0, 300)) {
            if (typeof name === 'string' && name && name.length <= LIMITS.maxName && !out.roster.includes(name)) out.roster.push(name);
        }
    }
    return out;
}

// Légion choisie par chaque joueur : pseudo -> { army, legion }.
function sanitizePicks(raw) {
    const clean = Object.create(null);
    if (!raw || typeof raw !== 'object') return clean;
    for (const [name, pick] of Object.entries(raw).slice(0, 500)) {
        if (name.length > LIMITS.maxName || !pick || typeof pick !== 'object') continue;
        if (typeof pick.army !== 'string' || !DOC_ID.test(pick.army)) continue;
        if (typeof pick.legion !== 'string' || !LEG_ID.test(pick.legion)) continue;
        clean[name] = { army: pick.army, legion: pick.legion };
    }
    return clean;
}

function normalizeState(raw) {
    const config = sanitizeConfig(raw?.config) || { cols: 150, rows: 100 };
    return {
        config,
        gridData: sanitizeGrid(raw?.gridData, config),
        terrainsList: sanitizeTerrains(raw?.terrainsList ?? raw?.terrains),
        isLocked: Boolean(raw?.isLocked),
        protection: sanitizeProtection(raw?.protection),
        fichesAccess: raw?.fichesAccess !== false, // les joueurs peuvent consulter toutes les fiches d'armée (le MJ peut le refuser)
        fichesFrozen: raw?.fichesFrozen === true, // légions choisies figées : les joueurs ne peuvent plus en changer
        fichesPicks: sanitizePicks(raw?.fichesPicks),
        fichesTeams: sanitizeTeams(raw?.fichesTeams)
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

    async loadDoc(id) {
        if (!DOC_ID.test(id)) throw new Error('Identifiant de document invalide');
        return readJson(path.join(DOCS_DIR, `${id}.json`));
    },
    async saveDoc(id, data) {
        if (!DOC_ID.test(id)) throw new Error('Identifiant de document invalide');
        fs.mkdirSync(DOCS_DIR, { recursive: true });
        writeJsonAtomic(path.join(DOCS_DIR, `${id}.json`), data);
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

        // Documents divers (fiches d'armée) : même table app_state, un identifiant par document.
        async loadDoc(id) {
            if (!DOC_ID.test(id)) throw new Error('Identifiant de document invalide');
            const res = await db.from('app_state').select('data').eq('id', id).maybeSingle();
            check(res);
            return res.data?.data ?? null;
        },
        async saveDoc(id, data) {
            if (!DOC_ID.test(id)) throw new Error('Identifiant de document invalide');
            check(await db.from('app_state').upsert({ id, data, updated_at: new Date().toISOString() }));
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
/* Fiches d'armée                                                      */
/* ------------------------------------------------------------------ */

const fiches = {
    ready: false,
    version: '',
    families: [], // formules d'origine
    seedArmies: new Map(), // id -> armée d'origine
    armies: new Map(), // id -> armée modifiée par le MJ
    famTexts: {}, // id d'une formule d'origine -> texte modifié par le MJ
    famCustom: {} // id -> { col, text } : formules créées par le MJ
};

function loadFichesSeed() {
    const raw = readJson(FICHES_SEED_FILE);
    if (!raw || !Array.isArray(raw.armies)) {
        console.warn('⚠️ fiches-seed.json introuvable : les fiches d’armée sont désactivées.');
        return;
    }
    fiches.version = String(raw.version || 'v1').slice(0, 40);
    fiches.families = Array.isArray(raw.families) ? raw.families : [];
    for (const army of raw.armies) {
        if (army && DOC_ID.test(army.id)) fiches.seedArmies.set(army.id, army);
    }
    fiches.ready = fiches.seedArmies.size > 0;
    console.log(`📜 Fiches d'armée : ${fiches.seedArmies.size} armées (version ${fiches.version}).`);
}

// Les modifications du MJ ne s'appliquent que si elles correspondent à la version du fichier d'origine.
async function loadFichesOverrides() {
    if (!fiches.ready) return;
    for (const id of fiches.seedArmies.keys()) {
        const doc = await storage.loadDoc(`fiches_a_${id}`);
        if (doc?.version === fiches.version && doc.army?.id === id && Array.isArray(doc.army.units)) fiches.armies.set(id, doc.army);
    }
    const famDoc = await storage.loadDoc('fiches_fams');
    if (famDoc?.version === fiches.version) {
        if (famDoc.texts && typeof famDoc.texts === 'object') fiches.famTexts = famDoc.texts;
        if (famDoc.custom && typeof famDoc.custom === 'object') fiches.famCustom = famDoc.custom;
    }
    console.log(`📜 ${fiches.armies.size} armée(s) modifiée(s) par le MJ, ${Object.keys(fiches.famCustom).length} formule(s) créée(s).`);
}

const fichesArmy = (id) => fiches.armies.get(id) || fiches.seedArmies.get(id);

// Formules envoyées au client : celles d'origine puis celles créées par le MJ.
function fichesFamilies() {
    const list = fiches.families.map((f) => ({ id: f.id, col: f.col, rel: f.rel }));
    for (const [id, f] of Object.entries(fiches.famCustom)) list.push({ id, col: f.col, rel: f.text, custom: true });
    return list;
}

function legionFigs(army, lid) {
    let total = 0;
    for (const unit of army.units || []) {
        const q = unit.q?.[lid];
        if (Array.isArray(q) && Number.isFinite(q[0])) total += q[0];
    }
    return total;
}

function legionLabel(army, legion) {
    if (legion?.name) return String(legion.name);
    const id = legion?.id ?? '';
    if (id === 'renfort') return 'Renfort';
    return `Légion ${id}`;
}

const validPick = (armyId, lid) => {
    const army = typeof armyId === 'string' ? fichesArmy(armyId) : null;
    return Boolean(army) && typeof lid === 'string' && lid !== 'ni'
        && (army.legions || []).some((l) => l.id === lid) && legionFigs(army, lid) > 0;
};

// Joueur qui a déjà choisi cette légion (hors lui-même), sinon null.
function pickTakenBy(armyId, lid, exceptName) {
    for (const [name, pick] of Object.entries(state.fichesPicks)) {
        if (name !== exceptName && pick.army === armyId && pick.legion === lid) return name;
    }
    return null;
}

// Supprime les choix qui ne correspondent plus à une légion existante. Renvoie true si quelque chose a changé.
function pruneFichesPicks() {
    let changed = false;
    for (const [name, pick] of Object.entries(state.fichesPicks)) {
        if (!validPick(pick.army, pick.legion)) { delete state.fichesPicks[name]; changed = true; }
    }
    return changed;
}

// Pseudos connus : liste du MJ, choix de légion, équipes et joueurs connectés (hors MJ).
function onlineNames() {
    const names = [];
    for (const sock of io.sockets.sockets.values()) {
        if (sock.data?.name && !sock.data.isAdmin && !names.includes(sock.data.name)) names.push(sock.data.name);
    }
    return names;
}
function knownNames() {
    const set = new Set(state.fichesTeams.roster);
    for (const n of Object.keys(state.fichesPicks)) set.add(n);
    for (const n of Object.keys(state.fichesTeams.members)) set.add(n);
    for (const n of onlineNames()) set.add(n);
    return [...set];
}
// Orthographe officielle d'un pseudo (sans tenir compte des majuscules), ou null s'il est inconnu.
function findName(name) {
    const low = String(name || '').toLowerCase();
    return knownNames().find((n) => n.toLowerCase() === low) || null;
}
const teamLabelOf = (name) => {
    const team = state.fichesTeams.members[name];
    return team ? state.fichesTeams.names[team] : null;
};
function renamePseudo(from, to) {
    const t = state.fichesTeams;
    t.roster = t.roster.map((n) => (n === from ? to : n));
    if (!t.roster.includes(to)) t.roster.push(to);
    if (t.members[from]) { t.members[to] = t.members[from]; delete t.members[from]; }
    if (state.fichesPicks[from]) { state.fichesPicks[to] = state.fichesPicks[from]; delete state.fichesPicks[from]; }
}

// Nom de la légion choisie par chaque joueur : public, c'est ce que voient les joueurs en survolant un pseudo.
function fichesPickLabels() {
    const labels = {};
    for (const [name, pick] of Object.entries(state.fichesPicks)) {
        const army = fichesArmy(pick.army);
        const legion = army?.legions?.find((l) => l.id === pick.legion);
        if (army && legion) {
            const team = teamLabelOf(name);
            labels[name] = { army: pick.army, legion: pick.legion, team, text: `${army.name} · ${legionLabel(army, legion)}${team ? ` · ${team}` : ''}` };
        }
    }
    // Joueurs d'une équipe sans légion choisie : l'info-bulle indique seulement l'équipe.
    for (const name of Object.keys(state.fichesTeams.members)) {
        const team = teamLabelOf(name);
        if (team && !labels[name]) labels[name] = { army: null, legion: null, team, text: team };
    }
    return labels;
}

// Catalogue sommaire (sans unités) pour choisir une légion quand les fiches sont fermées.
function fichesCatalog() {
    return [...fiches.seedArmies.keys()].map((id) => {
        const army = fichesArmy(id);
        const legions = (army.legions || [])
            .filter((l) => l.id !== 'ni')
            .map((l) => ({ id: l.id, name: l.name || null, figs: legionFigs(army, l.id), comp: l.comp || null, takenBy: pickTakenBy(id, l.id, null) }))
            .filter((l) => l.figs > 0);
        return { id, name: army.name, legions };
    });
}

// Armées réduites aux seules légions choisies par les joueurs : tout ce que reçoit un joueur quand l'accès est fermé.
function fichesPickedArmies() {
    const byArmy = new Map();
    for (const pick of Object.values(state.fichesPicks)) {
        if (!validPick(pick.army, pick.legion)) continue;
        if (!byArmy.has(pick.army)) byArmy.set(pick.army, new Set());
        byArmy.get(pick.army).add(pick.legion);
    }
    return [...byArmy.entries()].map(([armyId, lids]) => {
        const army = fichesArmy(armyId);
        const units = (army.units || [])
            .filter((u) => Object.keys(u.q || {}).some((k) => lids.has(k)))
            .map((u) => ({ ...u, q: Object.fromEntries(Object.entries(u.q).filter(([k]) => lids.has(k))) }));
        return { ...army, legions: army.legions.filter((l) => lids.has(l.id)), units };
    });
}

// Vérifie une fiche envoyée par le MJ avant de l'enregistrer.
function checkFichesArmy(id, army) {
    if (!fiches.seedArmies.has(id) || !army || army.id !== id) return 'armée inconnue';
    if (!Array.isArray(army.units) || army.units.length > FICHES_MAX_UNITS) return 'liste d’unités invalide';
    if (!Array.isArray(army.legions) || army.legions.length > 60) return 'liste de légions invalide';
    const ids = new Set();
    for (const l of army.legions) {
        if (!l || typeof l.id !== 'string' || !(LEG_ID.test(l.id)) || ids.has(l.id)) return 'identifiant de légion invalide';
        ids.add(l.id);
        if (l.name != null && (typeof l.name !== 'string' || l.name.length > 40)) return 'nom de légion invalide';
        if (l.comp != null && (typeof l.comp !== 'string' || l.comp.length > 200)) return 'composition invalide';
        if (l.sup != null && !Number.isFinite(l.sup)) return 'supplément invalide';
    }
    for (const u of army.units) {
        if (!u || typeof u !== 'object' || typeof u.in_ !== 'object' || typeof u.q !== 'object') return 'unité invalide';
        for (const k of Object.keys(u.q)) if (!ids.has(k)) return `l’unité référence une légion inexistante (${k.slice(0, 12)})`;
    }
    if (army.bonuses != null && (!Array.isArray(army.bonuses) || army.bonuses.length > 30
        || army.bonuses.some((b) => !b || typeof b.key !== 'string' || !/^[A-Z]{1,2}\d{0,2}$/.test(b.key)
            || typeof b.label !== 'string' || b.label.length > 40))) return 'bonus invalides';
    if (army.params != null && (typeof army.params !== 'object' || Array.isArray(army.params)
        || Object.entries(army.params).some(([k, v]) => !/^[A-Z]{1,2}\d{0,2}$/.test(k)
            || !(v == null || typeof v === 'number' || (typeof v === 'string' && v.length <= 20))))) return 'paramètres de bonus invalides';
    if (army.sections != null && (!Array.isArray(army.sections) || army.sections.length > 60
        || army.sections.some((x) => typeof x !== 'string' || x.length > 80))) return 'sections invalides';
    if (JSON.stringify(army).length > FICHES_MAX_BYTES) return 'fiche trop volumineuse';
    return null;
}


/* ---- Sauvegardes nommées des fiches d'armée (analogue aux cartes) ---- */

const SNAP_ID = /^s[a-z0-9]{3,40}$/;
const SNAPS_INDEX = 'fiches_snaps';
const MAX_SNAPS = 30;
const MAX_AUTO_SNAPS = 5;

async function loadSnapIndex() {
    const doc = await storage.loadDoc(SNAPS_INDEX);
    return Array.isArray(doc?.list) ? doc.list.filter((m) => m && SNAP_ID.test(m.id)) : [];
}
async function saveSnapIndex(list) {
    await storage.saveDoc(SNAPS_INDEX, { list });
}

// État actuel des fiches : uniquement ce que le MJ a modifié (le reste vient de fiches-seed.json).
function currentFichesFile(name) {
    const armies = {};
    for (const [id, army] of fiches.armies) armies[id] = army;
    return {
        kind: 'fiches-armees',
        format: 1,
        version: fiches.version,
        name,
        savedAt: Date.now(),
        armies,
        fams: { texts: fiches.famTexts, custom: fiches.famCustom }
    };
}

// Vérifie un fichier de fiches (sauvegarde ou fichier importé) ; renvoie un message d'erreur ou null.
function checkFichesFile(file) {
    if (!file || typeof file !== 'object' || file.kind !== 'fiches-armees') return 'ce fichier n’est pas une sauvegarde de fiches d’armée';
    if (file.version !== fiches.version) return `version incompatible (fichier ${String(file.version).slice(0, 20)}, serveur ${fiches.version})`;
    if (!file.armies || typeof file.armies !== 'object') return 'armées manquantes';
    const entries = Object.entries(file.armies);
    if (entries.length > 40) return 'trop d’armées';
    for (const [id, army] of entries) {
        const problem = checkFichesArmy(id, army);
        if (problem) return `armée ${String(id).slice(0, 20)} : ${problem}`;
    }
    const f = file.fams;
    if (f != null) {
        if (typeof f !== 'object') return 'formules invalides';
        const seed = new Map(fiches.families.map((x) => [x.id, x]));
        for (const [id, text] of Object.entries(f.texts || {})) if (!seed.has(id) || typeof text !== 'string' || text.length > 2000) return 'formule invalide';
        for (const [id, c] of Object.entries(f.custom || {})) {
            if (!FAM_ID.test(id) || !c || typeof c.text !== 'string' || c.text.length > 2000 || !FAM_COLS.has(c.col)) return 'formule créée invalide';
        }
    }
    return null;
}

async function putSnapshot(id, file, author, auto = false) {
    await storage.saveDoc(`fiches_snap_${id}`, file);
    const list = await loadSnapIndex();
    const meta = { id, name: file.name, savedAt: file.savedAt || Date.now(), author, auto, armies: Object.keys(file.armies).length, customFams: Object.keys(file.fams?.custom || {}).length };
    const i = list.findIndex((m) => m.id === id);
    if (i >= 0) list[i] = meta; else list.push(meta);
    const autos = list.filter((m) => m.auto).sort((a, b) => a.savedAt - b.savedAt);
    while (autos.length > MAX_AUTO_SNAPS) { const old = autos.shift(); list.splice(list.findIndex((m) => m.id === old.id), 1); }
    await saveSnapIndex(list);
    return meta;
}

// Remplace l'état courant des fiches par celui d'un fichier déjà vérifié.
async function applyFichesFile(file) {
    for (const id of fiches.seedArmies.keys()) {
        const army = file.armies[id];
        if (army) {
            await storage.saveDoc(`fiches_a_${id}`, { version: fiches.version, army });
            fiches.armies.set(id, army);
        } else if (fiches.armies.has(id)) {
            await storage.saveDoc(`fiches_a_${id}`, { version: fiches.version, army: null }); // retour à la version d'origine
            fiches.armies.delete(id);
        }
    }
    fiches.famTexts = { ...(file.fams?.texts || {}) };
    fiches.famCustom = { ...(file.fams?.custom || {}) };
    await storage.saveDoc('fiches_fams', { version: fiches.version, texts: fiches.famTexts, custom: fiches.famCustom });
    pruneFichesPicks();
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

// Pseudos ayant modifié la carte en cours (affichés hors ligne sur la page de connexion).
const contributors = new Set();

function rebuildContributors() {
    contributors.clear();
    for (const tile of Object.values(state.gridData)) {
        if (tile.author) contributors.add(tile.author);
        if (tile.objectAuthor) contributors.add(tile.objectAuthor);
    }
}

function presence() {
    const online = connectedUsers();
    const onlineLower = new Set(online.map((name) => name.toLowerCase()));
    const offline = [...contributors]
        .filter((name) => !onlineLower.has(name.toLowerCase()))
        .sort((a, b) => a.localeCompare(b, 'fr'));
    return { online, offline };
}

const broadcastUsers = () => io.emit('update-users-list', presence());
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
        if (author && !contributors.has(author)) {
            contributors.add(author);
            broadcastUsers();
        }
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
        presence: presence(),
        protection: state.protection,
        isLocked: state.isLocked,
        fichesAccess: state.fichesAccess,
        fichesFrozen: state.fichesFrozen,
        fichesPickLabels: fichesPickLabels(),
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
        rebuildContributors();
        broadcastUsers();
        await saveNow();
        io.emit('update-config', { config: state.config, gridData: state.gridData });
        broadcastMaps();
        reply(ack, { success: true, message: 'Nouvelle carte créée. L’ancienne a été sauvegardée automatiquement.' });
    }));

    /* ---------- Fiches d'armée ---------- */

    const broadcastPicks = () => {
        io.emit('fiches-picks', fichesPickLabels());
        io.emit('fiches-changed', { picks: true });
    };

    // Chargement : le serveur décide de ce que le joueur a le droit de voir.
    socket.on('fiches-load', (payload, ack) => {
        if (!fiches.ready) {
            return reply(ack, { success: false, message: 'Fiches d’armée indisponibles (fichier fiches-seed.json absent du serveur).' });
        }
        const name = socket.data.name;
        if (!name) return reply(ack, { success: false, message: 'Connectez-vous d’abord.' });

        const base = {
            success: true,
            access: state.fichesAccess,
            frozen: state.fichesFrozen,
            version: fiches.version,
            families: fichesFamilies(),
            famTexts: fiches.famTexts,
            picks: { ...state.fichesPicks },
            teams: { names: { ...state.fichesTeams.names }, members: { ...state.fichesTeams.members } }
        };
        if (socket.data.isAdmin) { base.roster = [...state.fichesTeams.roster]; base.online = onlineNames(); }
        if (socket.data.isAdmin || state.fichesAccess) {
            return reply(ack, { ...base, mode: 'full', armies: [...fiches.seedArmies.keys()].map(fichesArmy) });
        }
        // Accès refusé : les légions choisies par les joueurs (la sienne comprise) restent consultables, rien d'autre.
        return reply(ack, { ...base, mode: 'own', armies: fichesPickedArmies(), pick: state.fichesPicks[findName(name) || name] || null, catalog: fichesCatalog() });
    });

    // Un joueur (ou le MJ) choisit une légion. Une légion ne peut être choisie que par un seul joueur.
    // Le MJ peut aussi choisir ou retirer la légion d'un autre pseudo (payload.name).
    socket.on('fiches-pick', (payload, ack) => {
        const name = socket.data.name;
        if (!name) return reply(ack, { success: false, message: 'Connectez-vous d’abord.' });
        const admin = socket.data.isAdmin;
        const me = findName(name) || name;
        let target = me;
        if (admin && payload?.name) {
            target = findName(cleanText(payload.name, LIMITS.maxName));
            if (!target) return reply(ack, { success: false, message: 'Pseudo inconnu : ajoutez-le d’abord.' });
        }

        if (payload?.clear) {
            if (!state.fichesPicks[target]) return reply(ack, { success: false, message: 'Aucun choix à retirer.' });
            if (!admin && state.fichesFrozen) return reply(ack, { success: false, message: 'Le MJ a verrouillé les légions : seul lui peut les modifier.' });
            delete state.fichesPicks[target];
        } else {
            if (!validPick(payload?.army, payload?.legion)) return reply(ack, { success: false, message: 'Légion invalide ou vide.' });
            if (!admin && state.fichesFrozen && state.fichesPicks[target]) {
                return reply(ack, { success: false, message: 'Le MJ a verrouillé les légions : votre choix ne peut plus changer.' });
            }
            const owner = pickTakenBy(payload.army, payload.legion, target);
            if (owner) return reply(ack, { success: false, message: `Cette légion est déjà choisie par ${owner}.` });
            state.fichesPicks[target] = { army: payload.army, legion: payload.legion };
        }
        scheduleSave();
        broadcastPicks();
        return reply(ack, { success: true });
    });

    // Le MJ gère les pseudos et les équipes : ajouter, supprimer, renommer, affecter, nommer une équipe.
    socket.on('fiches-team', (payload, ack) => {
        if (!requireAdmin(socket, ack)) return;
        const t = state.fichesTeams;
        const op = payload?.op;
        const clean = (v) => cleanText(v, LIMITS.maxName);

        if (op === 'add') {
            const name = clean(payload.name);
            if (!name) return reply(ack, { success: false, message: 'Pseudo vide.' });
            if (findName(name)) return reply(ack, { success: false, message: 'Ce pseudo existe déjà.' });
            if (t.roster.length >= 300) return reply(ack, { success: false, message: 'Liste pleine.' });
            t.roster.push(name);
        } else if (op === 'remove') {
            const name = findName(clean(payload.name));
            if (!name) return reply(ack, { success: false, message: 'Pseudo inconnu.' });
            t.roster = t.roster.filter((n) => n !== name);
            delete t.members[name];
            delete state.fichesPicks[name];
        } else if (op === 'rename') {
            const from = findName(clean(payload.name));
            const to = clean(payload.to);
            if (!from || !to) return reply(ack, { success: false, message: 'Pseudo invalide.' });
            const clash = findName(to);
            if (clash && clash !== from) return reply(ack, { success: false, message: 'Ce pseudo existe déjà.' });
            renamePseudo(from, to);
        } else if (op === 'assign') {
            const name = findName(clean(payload.name));
            if (!name) return reply(ack, { success: false, message: 'Pseudo inconnu.' });
            if (payload.team === 't1' || payload.team === 't2') t.members[name] = payload.team;
            else delete t.members[name];
            if (!t.roster.includes(name)) t.roster.push(name);
        } else if (op === 'teamname') {
            if (payload.team !== 't1' && payload.team !== 't2') return reply(ack, { success: false, message: 'Équipe invalide.' });
            t.names[payload.team] = cleanText(payload.label, 30) || (payload.team === 't1' ? 'Équipe 1' : 'Équipe 2');
        } else {
            return reply(ack, { success: false, message: 'Action inconnue.' });
        }
        pruneFichesPicks();
        scheduleSave();
        broadcastPicks();
        return reply(ack, { success: true });
    });

    // Le MJ autorise ou refuse l'accès à toutes les fiches (les légions choisies restent consultables).
    socket.on('fiches-access', (payload, ack) => {
        if (!requireAdmin(socket, ack)) return;
        state.fichesAccess = Boolean(payload?.allow);
        scheduleSave();
        io.emit('fiches-access', state.fichesAccess);
        io.emit('fiches-changed', { access: true });
        reply(ack, { success: true, allow: state.fichesAccess });
    });

    // Le MJ fige les légions choisies, ou laisse les joueurs en changer.
    socket.on('fiches-freeze', (payload, ack) => {
        if (!requireAdmin(socket, ack)) return;
        state.fichesFrozen = Boolean(payload?.freeze);
        scheduleSave();
        io.emit('fiches-freeze', state.fichesFrozen);
        reply(ack, { success: true, freeze: state.fichesFrozen });
    });

    // Le MJ modifie des armées (unités, légions, sections) et/ou des formules : enregistré pour tout le monde.
    socket.on('fiches-save', guarded(async (payload, ack) => {
        if (!requireAdmin(socket, ack)) return;
        if (!fiches.ready) return reply(ack, { success: false, message: 'Fiches d’armée indisponibles.' });

        const armies = payload?.armies && typeof payload.armies === 'object' ? Object.entries(payload.armies).slice(0, 40) : [];
        for (const [id, army] of armies) {
            const problem = checkFichesArmy(id, army);
            if (problem) return reply(ack, { success: false, message: `Fiche refusée (${String(id).slice(0, 30)}) : ${problem}.` });
        }

        let famDoc = null;
        if (payload?.fams && typeof payload.fams === 'object') {
            const seedCol = new Map(fiches.families.map((f) => [f.id, f]));
            const texts = {};
            const custom = {};
            for (const [id, f] of Object.entries(payload.fams).slice(0, 200)) {
                if (!f || typeof f.text !== 'string' || f.text.length > 2000 || !FAM_COLS.has(f.col)) continue;
                const seed = seedCol.get(id);
                if (seed) { if (seed.col === f.col && f.text !== String(seed.rel).replace(/\[\+0\]/g, '')) texts[id] = f.text; }
                else if (FAM_ID.test(id) && Object.keys(custom).length < 100) custom[id] = { col: f.col, text: f.text };
            }
            famDoc = { texts, custom };
        }

        for (const [id, army] of armies) {
            await storage.saveDoc(`fiches_a_${id}`, { version: fiches.version, army });
            fiches.armies.set(id, army);
        }
        if (famDoc) {
            await storage.saveDoc('fiches_fams', { version: fiches.version, ...famDoc });
            fiches.famTexts = famDoc.texts;
            fiches.famCustom = famDoc.custom;
        }
        const pruned = pruneFichesPicks();
        if (pruned) scheduleSave();
        socket.broadcast.emit('fiches-changed', { armies: armies.map(([id]) => id), fams: Boolean(famDoc) });
        if (pruned) broadcastPicks();
        reply(ack, { success: true, picksChanged: pruned });
    }));

    // Test du stockage : écrit puis relit un document, et liste ce qui est enregistré pour les fiches.
    socket.on('fiches-diag', guarded(async (payload, ack) => {
        if (!requireAdmin(socket, ack)) return;
        const started = Date.now();
        const stamp = `${started}-${Math.random().toString(36).slice(2, 8)}`;
        let writeRead = false;
        let detail = '';
        try {
            await storage.saveDoc('diag_ping', { stamp });
            const back = await storage.loadDoc('diag_ping');
            writeRead = back?.stamp === stamp;
            if (!writeRead) detail = 'Le document relu ne correspond pas à celui écrit.';
        } catch (err) {
            detail = String(err?.message || err).slice(0, 200);
        }
        const saved = [];
        for (const id of fiches.seedArmies.keys()) {
            try {
                const doc = await storage.loadDoc(`fiches_a_${id}`);
                if (doc?.army) saved.push(id);
            } catch { /* ignoré : simple information */ }
        }
        let famSaved = false;
        try { famSaved = Boolean(await storage.loadDoc('fiches_fams')); } catch { /* ignoré */ }
        reply(ack, {
            success: true,
            storage: storage.label || (process.env.SUPABASE_URL ? 'Supabase' : 'fichiers locaux'),
            writeRead,
            detail,
            ms: Date.now() - started,
            version: fiches.version,
            armiesSaved: saved,
            famSaved,
            customFams: Object.keys(fiches.famCustom).length,
            picks: Object.keys(state.fichesPicks).length
        });
    }));

    /* ---------- Sauvegardes, exports et imports des fiches (MJ) ---------- */

    socket.on('fiches-snaps', guarded(async (payload, ack) => {
        if (!requireAdmin(socket, ack)) return;
        const list = (await loadSnapIndex()).sort((a, b) => b.savedAt - a.savedAt);
        reply(ack, { success: true, list, current: { armies: fiches.armies.size, customFams: Object.keys(fiches.famCustom).length } });
    }));

    socket.on('fiches-snap-save', guarded(async (payload, ack) => {
        if (!requireAdmin(socket, ack)) return;
        const name = cleanText(payload?.name, LIMITS.maxMapName);
        if (!name) return reply(ack, { success: false, message: 'Donnez un nom à la sauvegarde.' });
        const list = await loadSnapIndex();
        let id = null;
        const same = list.find((m) => !m.auto && m.name.toLowerCase() === name.toLowerCase());
        if (payload?.id) {
            id = String(payload.id);
            if (!list.some((m) => m.id === id)) return reply(ack, { success: false, message: 'Sauvegarde introuvable.' });
        } else if (same) {
            return reply(ack, { success: false, code: 'exists', id: same.id });
        }
        if (!id && list.filter((m) => !m.auto).length >= MAX_SNAPS) return reply(ack, { success: false, message: `Limite de ${MAX_SNAPS} sauvegardes atteinte : supprimez-en une.` });
        id = id || `s${crypto.randomBytes(8).toString('hex')}`;
        await putSnapshot(id, currentFichesFile(name), socket.data.name);
        reply(ack, { success: true, message: `Sauvegarde « ${name} » enregistrée.` });
    }));

    socket.on('fiches-snap-load', guarded(async (payload, ack) => {
        if (!requireAdmin(socket, ack)) return;
        const id = String(payload?.id ?? '');
        if (!SNAP_ID.test(id)) return reply(ack, { success: false, message: 'Sauvegarde introuvable.' });
        const file = await storage.loadDoc(`fiches_snap_${id}`);
        const problem = checkFichesFile(file);
        if (problem) return reply(ack, { success: false, message: `Sauvegarde illisible : ${problem}.` });
        await putSnapshot(`s${crypto.randomBytes(8).toString('hex')}`, currentFichesFile(`Sauvegarde auto (avant chargement) ${new Date().toLocaleString('fr-FR')}`), socket.data.name, true);
        await applyFichesFile(file);
        io.emit('fiches-changed', { armies: [...fiches.seedArmies.keys()], fams: true });
        broadcastPicks();
        reply(ack, { success: true, message: `Fiches « ${file.name} » chargées pour tous les joueurs.` });
    }));

    socket.on('fiches-snap-rename', guarded(async (payload, ack) => {
        if (!requireAdmin(socket, ack)) return;
        const id = String(payload?.id ?? '');
        const name = cleanText(payload?.name, LIMITS.maxMapName);
        if (!SNAP_ID.test(id) || !name) return reply(ack, { success: false, message: 'Nom ou sauvegarde invalide.' });
        const file = await storage.loadDoc(`fiches_snap_${id}`);
        if (!file) return reply(ack, { success: false, message: 'Sauvegarde introuvable.' });
        await putSnapshot(id, { ...file, name }, socket.data.name);
        reply(ack, { success: true, message: 'Sauvegarde renommée.' });
    }));

    socket.on('fiches-snap-delete', guarded(async (payload, ack) => {
        if (!requireAdmin(socket, ack)) return;
        const id = String(payload?.id ?? '');
        if (!SNAP_ID.test(id)) return reply(ack, { success: false, message: 'Sauvegarde introuvable.' });
        const list = (await loadSnapIndex()).filter((m) => m.id !== id);
        await saveSnapIndex(list);
        await storage.saveDoc(`fiches_snap_${id}`, { kind: 'supprimee' }); // le contenu n'est plus lisible
        reply(ack, { success: true, message: 'Sauvegarde supprimée.' });
    }));

    // Export : l'état actuel des fiches, ou une sauvegarde, sous forme de fichier à télécharger.
    socket.on('fiches-export', guarded(async (payload, ack) => {
        if (!requireAdmin(socket, ack)) return;
        let file;
        if (payload?.id) {
            const id = String(payload.id);
            if (!SNAP_ID.test(id)) return reply(ack, { success: false, message: 'Sauvegarde introuvable.' });
            file = await storage.loadDoc(`fiches_snap_${id}`);
            if (checkFichesFile(file)) return reply(ack, { success: false, message: 'Sauvegarde illisible.' });
        } else {
            file = currentFichesFile('Fiches d’armée (état actuel)');
        }
        reply(ack, { success: true, file });
    }));

    // Import : un fichier exporté devient une sauvegarde de la liste (il n'écrase rien tant qu'on ne le charge pas).
    socket.on('fiches-import', guarded(async (payload, ack) => {
        if (!requireAdmin(socket, ack)) return;
        const file = payload?.file;
        const problem = checkFichesFile(file);
        if (problem) return reply(ack, { success: false, message: `Fichier refusé : ${problem}.` });
        const list = await loadSnapIndex();
        if (list.filter((m) => !m.auto).length >= MAX_SNAPS) return reply(ack, { success: false, message: `Limite de ${MAX_SNAPS} sauvegardes atteinte : supprimez-en une.` });
        const name = cleanText(file.name, LIMITS.maxMapName) || 'Fiches importées';
        const clean = { kind: file.kind, format: 1, version: file.version, name: `${name} (importé)`.slice(0, LIMITS.maxMapName), savedAt: Date.now(), armies: file.armies, fams: file.fams || { texts: {}, custom: {} } };
        await putSnapshot(`s${crypto.randomBytes(8).toString('hex')}`, clean, socket.data.name);
        reply(ack, { success: true, message: 'Fichier importé : retrouvez-le dans la liste des sauvegardes.' });
    }));

    /* ---------- Protection de ses propres modifications ---------- */

    // Activer / désactiver : les autres joueurs doivent-ils confirmer avant de modifier mes tuiles ?
    socket.on('set-protection', (payload) => {
        const name = socket.data.name;
        if (!name) return;
        const rule = state.protection[name] ?? { on: true, clearedAt: 0 };
        state.protection[name] = { on: payload?.on !== false, clearedAt: rule.clearedAt };
        scheduleSave();
        io.emit('update-protection', state.protection);
    });

    // Libérer définitivement les modifications faites jusqu'ici (l'historique annuler / rétablir est conservé).
    socket.on('clear-protection', () => {
        const name = socket.data.name;
        if (!name) return;
        const rule = state.protection[name] ?? { on: true, clearedAt: 0 };
        state.protection[name] = { on: rule.on, clearedAt: Date.now() };
        scheduleSave();
        io.emit('update-protection', state.protection);
    });

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
        rebuildContributors();
        broadcastUsers();
        if (terrains) state.terrainsList = terrains;
        await saveNow();

        io.emit('update-config', { config: state.config, gridData: state.gridData });
        io.emit('update-terrains', state.terrainsList);
        broadcastMaps();
        reply(ack, { success: true, message: `Carte « ${map.name} » chargée.` });
    }));

    // Export d'une carte (ou de la carte en cours) vers un fichier local.
    socket.on('export-map', guarded(async (payload, ack) => {
        if (!requireAdmin(socket, ack)) return;
        let map;
        if (payload?.id) {
            const id = String(payload.id);
            if (!MAP_ID.test(id) || !mapsIndex.has(id)) return reply(ack, { success: false, message: 'Carte introuvable.' });
            map = await storage.getMap(id);
        } else {
            map = { name: 'Carte en cours', config: state.config, terrainsList: state.terrainsList, gridData: state.gridData };
        }
        if (!map) return reply(ack, { success: false, message: 'Carte introuvable.' });
        reply(ack, { success: true, file: { kind: 'carte', format: 1, name: map.name, savedAt: Date.now(), config: map.config, terrainsList: map.terrainsList, gridData: map.gridData } });
    }));

    // Import d'une carte depuis un fichier local : elle s'ajoute à la liste, sans toucher au plateau en cours.
    socket.on('import-map', guarded(async (payload, ack) => {
        if (!requireAdmin(socket, ack)) return;
        const file = payload?.file;
        if (!file || file.kind !== 'carte') return reply(ack, { success: false, message: 'Ce fichier n’est pas une carte exportée.' });
        const config = sanitizeConfig(file.config);
        if (!config) return reply(ack, { success: false, message: 'Carte illisible (dimensions invalides).' });
        const gridData = sanitizeGrid(file.gridData, config);
        const terrains = sanitizeTerrains(file.terrainsList) || state.terrainsList;
        const manual = [...mapsIndex.values()].filter((m) => !m.auto).length;
        if (manual >= 200) return reply(ack, { success: false, message: 'Trop de cartes enregistrées : supprimez-en.' });
        const name = cleanText(file.name, LIMITS.maxMapName - 10) || 'Carte importée';
        const map = {
            id: crypto.randomUUID(),
            name: `${name} (importée)`,
            auto: false,
            author: socket.data.name,
            savedAt: Date.now(),
            config,
            terrainsList: terrains.map((t) => ({ ...t })),
            gridData
        };
        await storage.putMap(map);
        mapsIndex.set(map.id, metaOf(map));
        broadcastMaps();
        reply(ack, { success: true, message: `Carte « ${map.name} » importée.` });
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
    rebuildContributors();
    await storage.saveState(state);

    background = await storage.loadBackground();

    try {
        loadFichesSeed();
        await loadFichesOverrides();
    } catch (err) {
        console.error('⚠️ Fiches d’armée : modifications du MJ illisibles, version d’origine utilisée :', err.message);
    }

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
