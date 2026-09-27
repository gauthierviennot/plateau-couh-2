const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

let config = { cols: 10, rows: 8 };
let gridData = {}; 

io.on('connection', (socket) => {
    socket.emit('init', { config, gridData });

    socket.on('set-username', (name) => {
        socket.username = name || 'Anonyme';
    });

    socket.on('paint-tile', (data) => {
        const { key, color } = data;
        const author = socket.username || 'Anonyme';
        
        gridData[key] = { color, author };
        io.emit('update-tile', { key, color, author });
    });

    socket.on('change-config', (newConfig) => {
        config = newConfig;
        gridData = {};
        io.emit('update-config', { config, gridData });
    });

    socket.on('clear-grid', () => {
        gridData = {};
        io.emit('clear-grid');
    });
});

const PORT = 3000;
http.listen(PORT, () => {
    console.log(`Serveur prêt sur http://localhost:${PORT}`);
});
