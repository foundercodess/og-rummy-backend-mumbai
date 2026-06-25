// Simple game simulation logic for demo
const table = document.getElementById('table');
const debug = document.getElementById('debug');

let gameState = {};

function initGame() {
    gameState = {
        players: [
            { name: 'Player 1', groups: [["A♠", "2♠", "3♠"], ["K♥", "K♣"]] },
            { name: 'Player 2', groups: [["4♦", "5♦", "6♦"], ["Q♠", "Q♦"]] },
            { name: 'Player 3', groups: [["7♣", "8♣", "9♣"], ["J♥", "J♠"]] },
            { name: 'Player 4', groups: [["10♠", "J♣", "Q♣"], ["A♥", "A♦"]] }
        ],
        step: 0,
        log: []
    };
    renderTable();
    debug.innerText = 'Game initialized.';
}

function renderTable() {
    table.innerHTML = '';
    gameState.players.forEach((player, idx) => {
        const div = document.createElement('div');
        div.className = 'player';
        div.innerHTML = `<strong>${player.name}</strong><br/>` +
            player.groups.map(
                group => `<span class='card-group'>${group.map(card => `<span class='card'>${card}</span>`).join('')}</span>`
            ).join('<br/>');
        table.appendChild(div);
    });
}

function simulateStep() {
    gameState.step++;
    // Example: swap a card between two random players
    const p1 = Math.floor(Math.random() * gameState.players.length);
    let p2 = Math.floor(Math.random() * gameState.players.length);
    while (p2 === p1) p2 = Math.floor(Math.random() * gameState.players.length);
    const g1 = Math.floor(Math.random() * gameState.players[p1].groups.length);
    const g2 = Math.floor(Math.random() * gameState.players[p2].groups.length);
    const c1 = Math.floor(Math.random() * gameState.players[p1].groups[g1].length);
    const c2 = Math.floor(Math.random() * gameState.players[p2].groups[g2].length);
    const card1 = gameState.players[p1].groups[g1][c1];
    const card2 = gameState.players[p2].groups[g2][c2];
    gameState.players[p1].groups[g1][c1] = card2;
    gameState.players[p2].groups[g2][c2] = card1;
    gameState.log.push(`Step ${gameState.step}: Swapped ${card1} and ${card2}`);
    renderTable();
    debug.innerText = gameState.log[gameState.log.length-1];
}

function resetGame() {
    initGame();
}

window.simulateStep = simulateStep;
window.resetGame = resetGame;

initGame();
