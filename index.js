require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const fs = require('fs');
const { KiteConnect, KiteTicker } = require('kiteconnect').default;

const app = express();
const port = process.env.PORT || 8000;

// Middleware to parse request bodies
app.use(bodyParser.urlencoded({ extended: true }));

// Load configuration
const config = JSON.parse(fs.readFileSync('config.json'));
const accessToken = JSON.parse(fs.readFileSync('token.json')).access_token;

const kite = new KiteConnect({
    api_key: config.api_key
});

kite.setAccessToken(accessToken);

// Get user profile for logging
kite.getProfile().then(profile => {
    console.log(`Logged in as: ${profile.user_id}`);
}).catch(err => console.log(err));

app.get('/', (req, res) => {
    res.send(`
        <form method="post">
            Symbol LTP: <input type="text" name="symbol">
            <input type="submit" value="Submit">
        </form>
    `);
});

app.post('/', (req, res) => {
    const symbol = req.body.symbol.toUpperCase();
    console.log(`Received symbol: ${symbol}`);

    // Logic to get ATM option symbol, tokens, lot size, tick size
    // You'll need to implement getAtmOptionSymbol similar to the Python version

    // Dummy values for demonstration
    const tokens = [123456];
    startKiteTicker(config.api_key, accessToken, tokens);

    res.redirect('/');
});

function startKiteTicker(apiKey, accessToken, tokens) {
    const kws = new KiteTicker({
        api_key: apiKey,
        access_token: accessToken
    });

    kws.connect();
    kws.on('ticks', ticks => {
        ticks.forEach(tick => {
            console.log(`Tick for token ${tick.instrument_token}: LTP = ${tick.last_price}`);
        });
    });
    kws.on('connect', () => {
        kws.subscribe(tokens);
        kws.setMode(kws.modeFull, tokens);
    });
}

app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});
