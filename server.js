const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

let gridData = {};
let gridConfig = { cols: 10, rows: 8, hexRadius: 35 };

// Servir les fichiers statiques du dossier public
app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
    socket.emit('init', { gridData, config: gridConfig });

    socket.on('paint-tile', (data) => {
        gridData[data.key] = data.color;
        socket.broadcast.emit('update-tile', data);
    });

    socket.on('change-config', (config) => {
        gridConfig.cols = config.cols;
        gridConfig.rows = config.rows;
        gridData = {};
        io.emit('update-config', { config: gridConfig, gridData });
    });

    socket.on('clear-grid', () => {
        gridData = {};
        io.emit('clear-grid');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveur prêt sur le port ${PORT}`));
