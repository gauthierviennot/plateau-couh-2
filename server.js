const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static(__dirname));

let config = { cols: 10, rows: 8 };
// gridData stocke désormais la couleur ET l'auteur : { "x,y": { color: "#...", author: "Pseudo" } }
let gridData = {}; 

io.on('connection', (socket) => {
    // 1. Envoyer l'état actuel à la connexion
    socket.emit('init', { config, gridData });

    // 2. Gestion du changement de pseudonyme
    socket.on('set-username', (name) => {
        socket.username = name || 'Anonyme';
    });

    // 3. Application directe ou écrasement de la tuile
    socket.on('paint-tile', (data) => {
        const { key, color } = data;
        const author = socket.username || 'Anonyme';
        
        gridData[key] = { color, author };
        
        // Diffuser la mise à jour à l'ensemble des clients
        io.emit('update-tile', { key, color, author });
    });

    // 4. Redimensionnement du plateau
    socket.on('change-config', (newConfig) => {
        config = newConfig;
        gridData = {};
        io.emit('update-config', { config, gridData });
    });

    // 5. Effacement complet
    socket.on('clear-grid', () => {
        gridData = {};
        io.emit('clear-grid');
    });
});

http.listen(3000, () => {
    console.log('Serveur actif sur http://localhost:3000');
});
