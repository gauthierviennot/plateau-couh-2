const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

let gridData = {};
let gridConfig = { cols: 10, rows: 8, hexRadius: 35 };

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Plateau Hexagonal Collaboratif</title>
    <script src="/socket.io/socket.io.js"></script>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Segoe UI', sans-serif; touch-action: none; user-select: none; }
        body { display: flex; height: 100vh; background-color: #f0f2f5; color: #333; overflow: hidden; }
        #sidebar { width: 280px; background: #ffffff; padding: 15px; box-shadow: 2px 0 10px rgba(0,0,0,0.1); display: flex; flex-direction: column; gap: 12px; overflow-y: auto; z-index: 10; }
        h1 { font-size: 1.1rem; color: #2c3e50; border-bottom: 2px solid #3498db; padding-bottom: 5px; }
        .status { font-size: 0.8rem; padding: 6px; border-radius: 4px; text-align: center; font-weight: bold; background: #e8f8f5; color: #27ae60; }
        .control-group { display: flex; flex-direction: column; gap: 5px; }
        label { font-weight: 600; font-size: 0.8rem; color: #555; }
        input[type="number"], input[type="color"] { padding: 6px; border: 1px solid #ccc; border-radius: 4px; width: 100%; }
        input[type="color"] { height: 35px; cursor: pointer; }
        .terrain-palette { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; }
        .terrain-btn { padding: 6px; border: 1px solid #ddd; border-radius: 4px; cursor: pointer; font-size: 0.75rem; display: flex; align-items: center; gap: 6px; background: #fff; }
        .color-sample { width: 14px; height: 14px; border-radius: 3px; border: 1px solid rgba(0,0,0,0.2); }
        .btn { padding: 8px; border: none; border-radius: 4px; background-color: #3498db; color: white; font-weight: bold; font-size: 0.85rem; cursor: pointer; }
        .btn-danger { background-color: #e74c3c; }
        .btn-fullscreen { background-color: #9b59b6; }
        #main { flex: 1; position: relative; background-color: #e5e9f0; overflow: hidden; display: flex; justify-content: center; align-items: center; }
        
        .mode-toggle-container { position: absolute; top: 15px; right: 15px; z-index: 20; }
        .btn-mode { padding: 10px 16px; border: none; border-radius: 20px; font-weight: bold; font-size: 0.9rem; cursor: pointer; box-shadow: 0 4px 10px rgba(0,0,0,0.2); transition: background-color 0.2s, transform 0.1s; }
        .btn-mode.paint { background-color: #2ecc71; color: white; }
        .btn-mode.move { background-color: #3498db; color: white; }
        .btn-mode:active { transform: scale(0.95); }

        canvas { background-color: #ffffff; box-shadow: 0 4px 15px rgba(0,0,0,0.15); border-radius: 8px; }
    </style>
</head>
<body>
    <div id="sidebar">
        <h1>Plateau Collaboratif</h1>
        <div id="status" class="status">En ligne</div>

        <div class="control-group">
            <label>Dimensions</label>
            <div style="display: flex; gap: 8px;">
                <div><label>Cols</label><input type="number" id="cols" value="10" min="2" max="50"></div>
                <div><label>Lignes</label><input type="number" id="rows" value="8" min="2" max="50"></div>
            </div>
        </div>

        <div class="control-group">
            <label>Couleur</label>
            <input type="color" id="tileColor" value="#2ecc71">
        </div>

        <div class="control-group">
            <label>Terrains</label>
            <div class="terrain-palette">
                <button class="terrain-btn" onclick="setColor('#2ecc71')"><span class="color-sample" style="background: #2ecc71;"></span> Plaine</button>
                <button class="terrain-btn" onclick="setColor('#27ae60')"><span class="color-sample" style="background: #27ae60;"></span> Forêt</button>
                <button class="terrain-btn" onclick="setColor('#3498db')"><span class="color-sample" style="background: #3498db;"></span> Eau</button>
                <button class="terrain-btn" onclick="setColor('#f1c40f')"><span class="color-sample" style="background: #f1c40f;"></span> Désert</button>
                <button class="terrain-btn" onclick="setColor('#95a5a6')"><span class="color-sample" style="background: #95a5a6;"></span> Montagne</button>
                <button class="terrain-btn" onclick="setColor('#ffffff')"><span class="color-sample" style="background: #ffffff;"></span> Gomme</button>
            </div>
        </div>

        <button class="btn btn-fullscreen" id="btnFullscreen">⛶ Plein Écran</button>
        <button class="btn btn-danger" id="btnClear">Effacer Tout</button>
    </div>

    <div id="main">
        <div class="mode-toggle-container">
            <button id="btnModeToggle" class="btn-mode paint">Mode : Peindre 🎨</button>
        </div>
        <canvas id="hexCanvas"></canvas>
    </div>

    <script>
        const socket = io();
        const canvas = document.getElementById('hexCanvas');
        const ctx = canvas.getContext('2d');

        let scale = 1.0, panX = 0, panY = 0;
        let cols = 10, rows = 8, hexRadius = 35;
        let gridData = {};

        let isPaintMode = true;
        let isMouseDown = false;
        let startX = 0, startY = 0;
        let initialPinchDistance = null;

        const inputCols = document.getElementById('cols');
        const inputRows = document.getElementById('rows');
        const inputColor = document.getElementById('tileColor');
        const btnModeToggle = document.getElementById('btnModeToggle');

        function setColor(c) { 
            inputColor.value = c; 
            setMode(true);
        }

        function setMode(paintMode) {
            isPaintMode = paintMode;
            if (isPaintMode) {
                btnModeToggle.textContent = "Mode : Peindre 🎨";
                btnModeToggle.className = "btn-mode paint";
            } else {
                btnModeToggle.textContent = "Mode : Déplacer / Zoomer ✋";
                btnModeToggle.className = "btn-mode move";
            }
        }

        btnModeToggle.addEventListener('click', () => setMode(!isPaintMode));

        socket.on('init', (data) => {
            gridData = data.gridData;
            cols = data.config.cols;
            rows = data.config.rows;
            inputCols.value = cols;
            inputRows.value = rows;
            initCanvas();
        });

        socket.on('update-tile', (data) => {
            gridData[data.key] = data.color;
            drawGrid();
        });

        socket.on('update-config', (data) => {
            cols = data.config.cols;
            rows = data.config.rows;
            gridData = data.gridData;
            inputCols.value = cols;
            inputRows.value = rows;
            initCanvas();
        });

        socket.on('clear-grid', () => {
            gridData = {};
            drawGrid();
        });

        function initCanvas() {
            const hexWidth = Math.sqrt(3) * hexRadius;
            const hexHeight = 2 * hexRadius;
            canvas.width = cols * hexWidth + (hexWidth / 2) + 20;
            canvas.height = rows * (hexHeight * 0.75) + (hexHeight * 0.25) + 20;
            drawGrid();
        }

        function getHexCenter(col, row) {
            const hexWidth = Math.sqrt(3) * hexRadius;
            const xOffset = (row % 2 === 1) ? hexWidth / 2 : 0;
            return {
                x: 10 + hexWidth / 2 + col * hexWidth + xOffset,
                y: 10 + hexRadius + row * (hexRadius * 1.5)
            };
        }

        function drawHexagon(x, y, radius, fillColor) {
            ctx.beginPath();
            for (let i = 0; i < 6; i++) {
                const angle = (Math.PI / 180) * (60 * i - 30);
                const pointX = x + radius * Math.cos(angle);
                const pointY = y + radius * Math.sin(angle);
                if (i === 0) ctx.moveTo(pointX, pointY);
                else ctx.lineTo(pointX, pointY);
            }
            ctx.closePath();
            ctx.fillStyle = fillColor || '#ffffff';
            ctx.fill();
            ctx.strokeStyle = '#333333';
            ctx.lineWidth = 1.5;
            ctx.stroke();
        }

        function drawGrid() {
            ctx.save();
            // Effacement sur la totalité du canvas réel
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            
            ctx.translate(panX, panY);
            ctx.scale(scale, scale);

            for (let r = 0; r < rows; r++) {
                for (let c = 0; c < cols; c++) {
                    const { x, y } = getHexCenter(c, r);
                    const key = `${c},${r}`;
                    drawHexagon(x, y, hexRadius, gridData[key] || '#ffffff');
                }
            }
            ctx.restore();
        }

        function paintTile(clientX, clientY) {
            const rect = canvas.getBoundingClientRect();
            // Prise en compte du ratio d'échelle CSS/Canvas
            const scaleX = canvas.width / rect.width;
            const scaleY = canvas.height / rect.height;

            const canvasX = (clientX - rect.left) * scaleX;
            const canvasY = (clientY - rect.top) * scaleY;

            const mouseX = (canvasX - panX) / scale;
            const mouseY = (canvasY - panY) / scale;

            for (let r = 0; r < rows; r++) {
                for (let c = 0; c < cols; c++) {
                    const { x, y } = getHexCenter(c, r);
                    if (Math.hypot(mouseX - x, mouseY - y) < hexRadius * 0.85) {
                        const key = `${c},${r}`;
                        const color = inputColor.value;
                        if (gridData[key] !== color) {
                            gridData[key] = color;
                            drawGrid();
                            socket.emit('paint-tile', { key, color });
                        }
                        return;
                    }
                }
            }
        }

        // --- ÉVÉNEMENTS --- //
        canvas.addEventListener('mousedown', (e) => {
            isMouseDown = true;
            startX = e.clientX - panX;
            startY = e.clientY - panY;
            if (isPaintMode) paintTile(e.clientX, e.clientY);
        });

        canvas.addEventListener('mousemove', (e) => {
            if (!isMouseDown) return;
            if (isPaintMode) {
                paintTile(e.clientX, e.clientY);
            } else {
                panX = e.clientX - startX;
                panY = e.clientY - startY;
                drawGrid();
            }
        });

        window.addEventListener('mouseup', () => isMouseDown = false);

        canvas.addEventListener('touchstart', (e) => {
            if (e.touches.length === 1) {
                isMouseDown = true;
                startX = e.touches[0].clientX - panX;
                startY = e.touches[0].clientY - panY;
                if (isPaintMode) paintTile(e.touches[0].clientX, e.touches[0].clientY);
            } else if (e.touches.length === 2) {
                isMouseDown = false;
                initialPinchDistance = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
            }
        }, { passive: false });

        canvas.addEventListener('touchmove', (e) => {
            if (e.touches.length === 1 && isMouseDown) {
                if (isPaintMode) {
                    paintTile(e.touches[0].clientX, e.touches[0].clientY);
                } else {
                    panX = e.touches[0].clientX - startX;
                    panY = e.touches[0].clientY - startY;
                    drawGrid();
                }
            } else if (e.touches.length === 2 && initialPinchDistance) {
                const currentDistance = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
                const factor = currentDistance / initialPinchDistance;
                scale = Math.min(Math.max(scale * factor, 0.3), 3.0);
                initialPinchDistance = currentDistance;
                drawGrid();
            }
        }, { passive: false });

        canvas.addEventListener('touchend', () => {
            isMouseDown = false;
            initialPinchDistance = null;
        });

        inputCols.addEventListener('change', updateConfig);
        inputRows.addEventListener('change', updateConfig);

        function updateConfig() {
            cols = parseInt(inputCols.value);
            rows = parseInt(inputRows.value);
            socket.emit('change-config', { cols, rows });
        }

        document.getElementById('btnClear').addEventListener('click', () => socket.emit('clear-grid'));
        document.getElementById('btnFullscreen').addEventListener('click', () => {
            const main = document.getElementById('main');
            if (!document.fullscreenElement) main.requestFullscreen();
            else document.exitFullscreen();
        });
    </script>
</body>
</html>
    `);
});

io.on('connection', (socket) => {
    socket.emit('init', { gridData, config: gridConfig });

    socket.on('paint-tile', (data) => {
        gridData[data.key] = data.color;
        socket.broadcast.emit('update-tile', data);
    });

    socket.on('change-config', (config) => {
        gridConfig.cols = config.cols;
        gridConfig.rows = config.rows;
        gridData = {}; // Réinitialise la grille côté serveur pour éviter les reliquats
        io.emit('update-config', { config: gridConfig, gridData });
    });

    socket.on('clear-grid', () => {
        gridData = {};
        io.emit('clear-grid');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveur prêt sur http://localhost:${PORT}`));
