const https = require('https');
const fs = require('fs');
const config = JSON.parse(fs.readFileSync('config.json'));
require('dotenv').config();
const { readInstrumentsToDataFrame, filterOptions } = require('./getToken');

const express = require('express');
const session = require('express-session')

const bodyParser = require('body-parser');
const WebSocket = require('ws');


const KiteConnect = require("kiteconnect").KiteConnect;
const KiteTicker = require("kiteconnect").KiteTicker;

const app = express();
const port = process.env.PORT || config.port;

// Middleware to parse request bodies
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

app.use(session({
    secret: config.session_secret, // Secret key to sign the session ID cookie
    resave: false, // Don't save session if unmodified
    saveUninitialized: true, // Don't create session until something stored
    cookie: { secure: true } // True for HTTPS
}));


// get details 
const getTokenDetails = () => {
    if (fs.existsSync('tokenDetails.json')) {
        return JSON.parse(fs.readFileSync('tokenDetails.json', 'utf8'));
    }
    return null;
};
// save token 
const TOKEN_LIFESPAN = 24 * 60 * 60 * 1000; // Example: 24 hours in milliseconds

const saveTokenDetails = (token) => {
    const now = new Date();
    const expiryTime = new Date(now.getTime() + TOKEN_LIFESPAN).toISOString(); // Calculate expiry time

    const tokenDetails = {
        accessToken: token,
        lastSaved: now.toISOString(),
        expiryTime: expiryTime // Save expiry time
    };

    fs.writeFileSync('tokenDetails.json', JSON.stringify(tokenDetails, null, 2), 'utf8');
};

const isTokenValid = () => {
    const tokenDetails = getTokenDetails();
    if (!tokenDetails) return false;

    const now = new Date();
    const expiryTime = new Date(tokenDetails.expiryTime);

    // Check if the current time is before the token's expiry time
    return now < expiryTime;
};

function logTradeActivity(logMessage) {
    const timestamp = new Date().toLocaleString();
    const logEntry = `${timestamp}: ${logMessage}\n`;
    fs.appendFileSync('trade_logs.txt', logEntry, 'utf8');
}

function logLtpActivity(logMessage) {
    const timestamp = new Date().toLocaleString();
    const logEntry = `${timestamp}: ${logMessage}\n`;
    fs.appendFileSync('ltp_logs.txt', logEntry, 'utf8');
}

// Load configuration
/**
 * Adjusts the given price to the nearest valid tick size.
 * @param {number} price The price to be adjusted.
 * @param {number} tickSize The minimum tick size for the instrument.
 * @returns {number} The adjusted price.
 */
function adjustToTickSize(price, tickSize) {
    return Math.round(price / tickSize) * tickSize;
}

/**
 * Places a limit order with a price adjusted by 1% up or down based on the transaction type.
 * @param {string} tradingsymbol The symbol for the instrument.
 * @param {number} quantity The quantity to order.
 * @param {number} price The current market price for the limit order adjustment.
 * @param {string} transactionType 'BUY' or 'SELL'.
 * @param {number} tickSize The minimum tick size for the instrument.
 */
function placeLimitOrder(tradingsymbol, quantity, price, transactionType, tickSize) {
    // Adjust the price by 1% up for BUY orders, 1% down for SELL orders
    const adjustedPrice = transactionType === "BUY"
        ? adjustToTickSize(price * 1.2, tickSize) // 1% above for buy orders
        : adjustToTickSize(price * 0.80, tickSize); // 1% below for sell orders

    kite.placeOrder("regular", {
        exchange: "NFO",
        tradingsymbol: tradingsymbol,
        transaction_type: transactionType,
        quantity: quantity,
        order_type: "LIMIT",
        price: adjustedPrice,
        product: "NRML"
    }).then(response => {
        logTradeActivity(`Limit order placed. ID: ${response.order_id}, Symbol: ${tradingsymbol}, Quantity: ${quantity}, Price: ${adjustedPrice}, Type: ${transactionType}`);
    }).catch(err => {
        logTradeActivity(`Error placing limit order for ${tradingsymbol}: ${err.message}`);
        console.error(`Error placing limit order for ${tradingsymbol}`, err);
    });
}



const kite = new KiteConnect({
    api_key: config.api_key
});

let currentAccessToken = null;
const kiteLoginURL = kite.getLoginURL();


app.get('/kite', (req, res) => {
    // Generate the Kite login URL

    // Send HTML response with the login button included
    res.send(`
        <html>
            <head>
                <title>Login to Kite</title>
            </head>
            <body>
                <!-- Kite login button -->
                <a href="${kiteLoginURL}" style="display:inline-block; margin-top:20px; padding:10px; background-color:#007bff; color:white; text-decoration:none; border-radius:5px;">Login with Kite</a>
            </body>
        </html>
    `);
});

app.get('/logs', (req, res) => {
    const updateForm = req.session.isLoggedIn ? `
        <h2>Update TPSL Settings</h2>
        <form action="/update-tpsl" method="post">
            <label for="symbol">Symbol:</label>
            <input type="text" id="symbol" name="symbol" required>
            <label for="qty">Quantity:</label>
            <input type="number" id="qty" name="qty" required>
            <label for="tp">Take Profit (%):</label>
            <input type="number" id="tp" name="tp" required>
            <label for="sl">Stop Loss (%):</label>
            <input type="number" id="sl" name="sl" required>
            <button type="submit">Update TPSL</button>
        </form>
    ` : '';
    // Add a button to navigate to the TPSL settings page
    const tpslSettingsButton = `<a href="/tpsl-settings" style="display:inline-block; margin-top:20px; padding:10px; background-color:#007bff; color:white; text-decoration:none; border-radius:5px;">TPSL Settings</a>`;

    // Endpoint HTML template with a Refresh button and a container for the logs
    const responseHtml = `
        <html>
            <head>
                <title>Trade Logs</title>
                <style>
                    body { font-family: Arial, sans-serif; }
                    p { margin: 5px 0; }
                    a.button, button.button { /* Adjusted to apply styles to both anchor and button elements */
                        display: inline-block;
                        margin-top: 20px;
                        padding: 10px;
                        background-color: #007bff;
                        color: white;
                        text-decoration: none;
                        border-radius: 5px;
                        cursor: pointer; /* Ensure the cursor changes to a pointer on hover for button elements */
                    }
                </style>
            </head>
            <body>
                <h1>Trade Logs</h1>
                ${tpslSettingsButton} <!-- Include the TPSL Settings button here -->
                <button id="refreshButton" class="button">Refresh Log</button>
                <div id="logContainer"></div>
                <script>
                    // Function to fetch and update the logs
                    function fetchAndUpdateLogs() {
                        fetch('/fetch-logs')
                            .then(response => response.text())
                            .then(data => {
                                const logContainer = document.getElementById('logContainer');
                                logContainer.innerHTML = data;
                            })
                            .catch(err => console.error('Error fetching logs:', err));
                    }

                    // Initial fetch of the logs
                    fetchAndUpdateLogs();

                    // Attach event listener to the Refresh button
                    document.getElementById('refreshButton').addEventListener('click', fetchAndUpdateLogs);
                </script>
            </body>
        </html>
    `;

    // Send the HTML response with the Refresh button and script
    res.send(responseHtml);
});
app.get('/tpsl-settings', (req, res) => {
    if (!req.session.isLoggedIn) {
        const loginButtonHtml = `
        <html>
            <head>
                <title>Unauthorized Access</title>
                <style>
                    body { font-family: Arial, sans-serif; text-align: center; margin-top: 50px; }
                    .button { /* Use generic class for button styling */
                    display: inline-block; margin-top: 20px; padding: 10px; background-color: #007bff; color: white; text-decoration: none; border-radius: 5px;
                }                </style>
            </head>
            <body>
                <h1>Unauthorized Access</h1>
                <p>Please log in to access this page.</p>
                <a href="${kiteLoginURL}" class="button" >Log In with Kite</a> <!-- Directly use kiteLoginURL here -->
                </body>
        </html>
    `;
        return res.status(403).send(loginButtonHtml);
    }

    fs.readFile('tpsl.json', 'utf8', (err, data) => {
        if (err) {
            console.error('Error reading TPSL settings:', err);
            return res.status(500).send('Internal Server Error');
        }

        const tpsl = JSON.parse(data);
        let formHtml = `<form action="/update-tpsl" method="post">`;

        // Loop through each TPSL setting and create input fields for them
        Object.entries(tpsl).forEach(([symbol, settings]) => {
            formHtml += `
                <fieldset>
                    <legend>${symbol}</legend>
                    <label for="${symbol}_qty">Quantity:</label>
                    <input type="number" id="${symbol}_qty" name="${symbol}[qty]" value="${settings.qty}" required><br>
                    <label for="${symbol}_tp">Take Profit (%):</label>
                    <input type="number" step="0.01" id="${symbol}_tp" name="${symbol}[tp]" value="${settings.tp}" required><br>
                    <label for="${symbol}_sl">Stop Loss (%):</label>
                    <input type="number" step="0.01" id="${symbol}_sl" name="${symbol}[sl]" value="${settings.sl}" required>
                </fieldset>`;
        });

        // Add a section to add a new stock configuration
        formHtml += `
            <fieldset>
                <legend>New Stock</legend>
                <label for="new_stock_symbol">Symbol:</label>
                <input type="text" id="new_stock_symbol" name="new_stock[symbol]"><br>
                <label for="new_stock_qty">Quantity:</label>
                <input type="number" id="new_stock_qty" name="new_stock[qty]"><br>
                <label for="new_stock_tp">Take Profit (%):</label>
                <input type="number" step="0.01" id="new_stock_tp" name="new_stock[tp]"><br>
                <label for="new_stock_sl">Stop Loss (%):</label>
                <input type="number" step="0.01" id="new_stock_sl" name="new_stock[sl]">
            </fieldset>
            <button type="submit" class="button">Update TPSL Settings</button>
        </form>`;

        res.send(`
            <html>
                <head>
                    <title>TPSL Settings</title>
                    <style>
                        body { font-family: Arial, sans-serif; }
                        a.button { display: inline-block; margin-top: 20px; padding: 10px; background-color: #007bff; color: white; text-decoration: none; border-radius: 5px; }
                    </style>
                </head>
                <body>
                    <h1>TPSL Settings</h1>
                    <a href="/logs" class="button">Back to Logs</a>
                    ${formHtml}
                </body>
            </html>
        `);
    });
});

// Additional route to handle fetching logs without page refresh
app.get('/fetch-logs', (req, res) => {
    fs.readFile('trade_logs.txt', 'utf8', (err, data) => {
        if (err) {
            console.error('Error reading trade logs:', err);
            return res.status(500).send('Internal Server Error');
        }

        // Format the log data for HTML
        const formattedData = data.split('\n').map(line => `<p>${line}</p>`).join('');
        res.send(formattedData);
    });
});


app.post('/update-tpsl', (req, res) => {
    if (!req.session.isLoggedIn) {
        return res.status(403).send('Unauthorized');
    }

    // Extract new stock data from the request body
    const { new_stock } = req.body;

    // Remove 'new_stock' from the new settings to avoid conflicts
    const updatedSettings = { ...req.body };
    delete updatedSettings.new_stock;

    fs.readFile('tpsl.json', 'utf8', (err, data) => {
        if (err) {
            console.error('Error reading TPSL settings:', err);
            return res.status(500).send('Internal Server Error');
        }

        // Parse the existing TPSL settings
        const tpslSettings = JSON.parse(data);

        // Update existing settings
        for (const symbol in updatedSettings) {
            if (tpslSettings.hasOwnProperty(symbol)) {
                tpslSettings[symbol] = { ...tpslSettings[symbol], ...updatedSettings[symbol] };
            }
        }

        // Add new stock, if provided and it includes the 'symbol' field
        if (new_stock && new_stock.symbol) {
            tpslSettings[new_stock.symbol] = {
                qty: new_stock.qty,
                tp: new_stock.tp,
                sl: new_stock.sl
            };
        }

        // Write the updated TPSL settings back to the file
        fs.writeFile('tpsl.json', JSON.stringify(tpslSettings, null, 2), 'utf8', (writeErr) => {
            if (writeErr) {
                console.error('Error updating TPSL settings:', writeErr);
                return res.status(500).send('Internal Server Error');
            }

            res.send(`
                <html>
                    <head>
                        <title>TPSL Update Confirmation</title>
                    </head>
                    <body>
                        <h1>TPSL settings updated successfully</h1>
                        <div>
                            <a href="/logs" style="padding:10px;background-color:#007bff;color:white;text-decoration:none;border-radius:5px;">Go Back to Logs</a>
                            <a href="/tpsl-settings" style="padding:10px;background-color:#007bff;color:white;text-decoration:none;border-radius:5px;margin-left:10px;">Return to TPSL Settings</a>
                        </div>
                    </body>
                </html>
            `);
        });
    });
});


app.get('/login/callback', (req, res) => {
    const requestToken = req.query.request_token;
    if (requestToken) {
        kite.generateSession(requestToken, config.api_secret)
            .then(response => {
                const tokenDetails = getTokenDetails();

                // Check if the existing token is still valid
                if (isTokenValid()) {
                    // Token is still valid, use the existing token details
                    currentAccessToken = tokenDetails.accessToken;
                    console.log("Using existing access token from saved details.");
                } else {
                    // Token is expired, save the new token details from the login response
                    saveTokenDetails(response.access_token);
                    currentAccessToken = response.access_token; // Use the new token
                    console.log("New access token obtained and saved.");
                }



                console.log("accesstoken after login", currentAccessToken)
                req.session.isLoggedIn = true;

                kite.setAccessToken(currentAccessToken);
                kite.getProfile().then(profile => {
                    console.log(`Logged in as: ${profile.user_id}`);
                    console.log(`press enter after login.`)
                }).catch(err => console.log(err));
                // console.log("Downloading Instruments NFO")
                // Fetch instruments for NFO and save to instruments.json
                // kite.getInstruments("NFO").then(instruments => {
                //     fs.writeFileSync('instruments.json', JSON.stringify(instruments, null, 2), 'utf-8');
                //     console.log("Instruments saved to instruments.json");
                // }).catch(err => {
                //     console.error("Failed to fetch instruments:", err);
                // });
                // console.log("instrument saved at instruments.json")

                res.redirect('/logs');
            })
            .catch(err => {
                console.error('Error obtaining access token:', err);
                res.send('Login failed or was cancelled by the user');
            });
    } else {
        res.send('No request token found');
    }
});


app.post('/chartlink', (req, res) => {
    // Assuming the message is sent in the request body
    logTradeActivity(`Received message from chartlink: ${JSON.stringify(req.body)}`);

    if (!req.body.stocks || !req.body.trigger_prices) {
        return res.status(400).send('Missing required fields: stocks or trigger_prices');
    }
    const message = req.body;

    const stocks = message.stocks.split(',');
    const triggerPrices = message.trigger_prices.split(',').map(price => parseFloat(price));
    const isCE = message.scan_name.includes('"CE"'); // Determine if it's CE or PE from the scan_name

    // Process each stock symbol
    stocks.forEach((stock, index) => {
        const triggerPrice = triggerPrices[index];
        const optionType = isCE ? 'CE' : 'PE'; // Option type based on the scan_name

        // Get the instrument data (you need to implement readInstrumentsToDataFrame)
        const instruments = readInstrumentsToDataFrame('instruments.json');

        // Filter for the ATM option based on the optionType and triggerPrice
        const atmOption = filterOptions(instruments, stock, optionType, triggerPrice);
        const tpsl = JSON.parse(fs.readFileSync('tpsl.json', 'utf8'));
        const tpConfig = tpsl[stock] || tpsl["DEFAULT"];

        if (!tpConfig) {
            console.log(`Configuration for ${stock} not found`);
            return res.redirect('/');
        }


        if (atmOption) {
            const tradingsymbol = atmOption.tradingsymbol;
            console.log(tradingsymbol)
            kite.getLTP(`NFO:${tradingsymbol}`).then(ltpResponse => {
                console.log(`LTP fetched for ${tradingsymbol}:`, ltpResponse);
                const optionLTP = ltpResponse[`NFO:${tradingsymbol}`].last_price;
                console.log(`LTP for ${tradingsymbol}: ${optionLTP}`);
                const qty = tpConfig.qty * atmOption.lot_size;
                logTradeActivity(`placing order for ${tradingsymbol} with qty ${qty} at price ${optionLTP} with TP % ${tpConfig.tp} and SL% ${tpConfig.sl} and lot size ${atmOption.lot_size} and tick size ${atmOption.tick_size} and instrument token ${atmOption.instrument_token}`);
                const tickSize = atmOption.tick_size; // Assuming you have this value from your instrument data
                placeLimitOrder(tradingsymbol, qty, optionLTP, "BUY", tickSize);



                console.log(`subscribing ltp for ${[atmOption.instrument_token]}`)

                startKiteTicker(config.api_key, [atmOption.instrument_token], tpConfig, optionLTP, tradingsymbol, atmOption.tick_size, qty);


            }).catch(err => logLtpActivity(`Error getting LTP for ${tradingsymbol}: ${err}`));

            // Assuming you have a function to place orders and manage TP/SL (you need to implement placeOrderWithTPSL)
            // placeOrderWithTPSL(tradingsymbol, atmOption, message);

            logTradeActivity(`Order processed for ${tradingsymbol} based on alert for ${stock}`);
        } else {
            console.log(`No suitable option found for ${stock}`);
        }
    });

    res.send('200');
});


function startKiteTicker(apiKey, tokens, tpConfig, entryPrice, tradingsymbol, tick_size, qty) {
    try {
        if (!isTokenValid()) {
            console.error('Access token is invalid or expired. Please log in again.');
            // You might want to handle re-login here or notify the user to re-login
            return;
        }
        // If the token is valid, proceed with using it
        const tokenDetails = getTokenDetails();
        const accessToken = tokenDetails.accessToken;

        console.log(`current apikey for subscription ${apiKey}`)

        console.log(`current tokens for subscription ${tokens}`)
        console.log(`current entryPrice for subscription ${entryPrice}`)
        console.log(`current tradingsymbol for subscription ${tradingsymbol}`)
        console.log(`current stoploss ${tpConfig.sl}`)
        console.log(`current takeprofit ${tpConfig.tp}`)
        console.log(`acccess token for subscription ${currentAccessToken}`)
        // if (!currentAccessToken) {
        //     console.error('Access token is not set. Make sure to log in first.');
        //     return;
        // }

        const kws = new KiteTicker({
            api_key: apiKey,
            access_token: accessToken // Use the in-memory token
        });

        let positionExited = false;


        kws.connect();
        kws.on('ticks', ticks => {
            if (positionExited) return;

            ticks.forEach(tick => {
                const currentPrice = tick.last_price;
                const tpPrice = entryPrice * (1 + tpConfig.tp / 100);
                const slPrice = entryPrice * (1 - tpConfig.sl / 100);
                logLtpActivity(`Tick for token ${tick.instrument_token}: LTP = ${currentPrice} tpPrice = ${tpPrice} slPrice = ${slPrice}`);


                if (currentPrice >= tpPrice || currentPrice <= slPrice) {

                    // Place a sell order (simplified version)

                    logTradeActivity(`Exiting position for tradingsymbol ${tradingsymbol} token number ${tick.instrument_token} at price ${currentPrice}`);
                    placeLimitOrder(tradingsymbol, qty, currentPrice, "SELL", tick_size);

                    positionExited = true;
                    kws.unsubscribe(tokens); // Unsubscribe from ticker updates for this token
                    kws.disconnect(); // 

                }


            });
        });
        kws.on('connect', () => {
            reconnectAttempts = 0; // Reset reconnect attempts on successful connection
            console.log('WebSocket connected');
            console.log(`Subscribing to tokens: ${tokens}`)
            kws.subscribe([tokens]);
            kws.setMode(kws.modeLTP, tokens);
        });
        kws.on('disconnect', (reason) => {
            console.error(`WebSocket disconnected: ${reason}`);
        });

        kws.on('error', error => {
            try {
                console.error(`WebSocket error: ${error.message}`);

                // Log the error using logTradeActivity
                console.log(`WebSocket error for ${tradingsymbol}: ${error.message}`);

                if (error.message.includes('429')) {
                    // kws.unsubscribe(tokens);
                    logTradeActivity(`token ${tokens} for ${tradingsymbol} due to rate limit (429).`);
                } else {
                    // Log other errors without unsubscribing
                    logTradeActivity(`WebSocket error for ${tradingsymbol}: ${error.message}`);
                }
            }

            catch (handlingError) {
                console.error(`Error handling WebSocket error: ${handlingError.message}`);
                logTradeActivity(`Error handling WebSocket error for ${tradingsymbol}: ${handlingError.message}`);
            }
        });

        kws.on('reconnect', (attempt, delay) => {
            console.log(`Attempting to reconnect (Attempt: ${attempt}) in ${delay}ms`);
        });

    } catch (error) {
        console.error('WebSocket error occurred:', error);
        // Log the error using logTradeActivity or any logging mechanism you prefer
        logTradeActivity(`WebSocket error occurred: ${error.message}`);
    }
}
const sslOptions = {
    key: fs.readFileSync(config.ssl_key_path),
    cert: fs.readFileSync(config.ssl_cert_path)
};


https.createServer(sslOptions, app).listen(config.port, () => {
    console.log(`Server running on https://localhost:${config.port}`);
    console.log(`open this link in browser http://localhost:${config.port}/kite`)

});
