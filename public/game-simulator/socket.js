// Socket.IO client for real-time updates
const socket = io({
    path: '/socket.io', // Adjust if your backend uses a different path
    transports: ['websocket']
});

socket.on('connect', () => {
    debug.innerText = 'Connected to backend socket.';
});

socket.on('disconnect', () => {
    debug.innerText = 'Disconnected from backend socket.';
});

// Listen for game state updates from backend
socket.on('game_state', (state) => {
    gameState = state;
    renderTable();
    debug.innerText = 'Received game state from backend.';
});

// Send simulation actions to backend
function emitSimulateStep() {
    socket.emit('simulate_step');
}

function emitResetGame() {
    socket.emit('reset_game');
}

window.emitSimulateStep = emitSimulateStep;
window.emitResetGame = emitResetGame;
