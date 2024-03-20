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

const kite = new KiteConnect({
    api_key: config.api_key
});

let currentAccessToken = null;


app.get('/kite', (req, res) => {
    // Generate the Kite login URL
    const kiteLoginURL = kite.getLoginURL();

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
    // Endpoint HTML template with a Refresh button and a container for the logs
    const responseHtml = `
        <html>
            <head>
                <title>Trade Logs</title>
                <style>
                    body { font-family: Arial, sans-serif; }
                    p { margin: 5px 0; }
                </style>
            </head>
            <body>
                <h1>Trade Logs</h1>
                <button id="refreshButton">Refresh Log</button>
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

    const { symbol, qty, tp, sl } = req.body;
    fs.readFile('tpsl.json', 'utf8', (err, data) => {
        if (err) {
            return res.status(500).send('Internal Server Error');
        }

        const tpsl = JSON.parse(data);
        tpsl[symbol] = { qty: parseInt(qty, 10), tp: parseFloat(tp), sl: parseFloat(sl) };

        fs.writeFile('tpsl.json', JSON.stringify(tpsl, null, 2), 'utf8', (err) => {
            if (err) {
                return res.status(500).send('Internal Server Error');
            }

            res.send('TPSL updated successfully');
        });
    });
});


app.get('/login/callback', (req, res) => {
    const requestToken = req.query.request_token;
    if (requestToken) {
        kite.generateSession(requestToken, config.api_secret)
            .then(response => {
                currentAccessToken = response.access_token; // Update the in-memory token
                console.log("accesstoken after login",currentAccessToken)
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
        const tpsl = JSON.parse(fs.readFileSync('tpsl.json'));
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
                
            
                // Place the first buy order.
                // kite.placeOrder("regular", {
                //     exchange: "NFO",
                //     tradingsymbol: tradingsymbol,
                //     transaction_type: "BUY",
                //     quantity: qty,
                //     order_type: "MARKET",
                //     product: "NRML"
                // }).then(response => {
                //     console.log("Order placed successfully", response);
                //     // You might want to save the order ID for managing TP/SL
                // }).catch(err => 
                //     console.log("Order placement failed", err);
                // });
                console.log(`subscribing ltp for ${[atmOption.instrument_token]}`)

                startKiteTicker(config.api_key, [atmOption.instrument_token], tpConfig, optionLTP,tradingsymbol);


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


function startKiteTicker(apiKey, tokens, tpConfig, entryPrice,tradingsymbol) {
    console.log(`current apikey for subscription ${apiKey}`)

    console.log(`current tokens for subscription ${tokens}`)
    console.log(`current entryPrice for subscription ${entryPrice}`)
    console.log(`current tradingsymbol for subscription ${tradingsymbol}`)
    console.log(`current stoploss ${tpConfig.sl}`)
    console.log(`current takeprofit ${tpConfig.tp}`)
    console.log(`acccess token for subscription ${currentAccessToken}`)
    if (!currentAccessToken) {
        console.error('Access token is not set. Make sure to log in first.');
        return;
    }

    const kws = new KiteTicker({
        api_key: apiKey,
        access_token: currentAccessToken // Use the in-memory token
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
                // kite.placeOrder("regular", {
                //     exchange: "NFO",
                //     tradingsymbol: tradingsymbol,
                //     transaction_type: "SELL",
                //     quantity: qty,
                //     order_type: "MARKET",
                //     product: "NRML"
                // }
                logTradeActivity(`Exiting position for tradingsymbol ${tradingsymbol} token number ${tick.instrument_token} at price ${currentPrice}`);
                // ).then(response => {
                //     console.log("Order placed successfully", response);
                //     // You might want to save the order ID for managing TP/SL
                // }).catch(err => {
                //     console.log("Order placement failed", err);
                // });
                positionExited = true;
                kws.unsubscribe(tokens); // Unsubscribe from ticker updates for this token
                kws.disconnect(); // 

            }


        });
    });
    kws.on('connect', () => {
        console.log('WebSocket connected');
        console.log(`Subscribing to tokens: ${tokens}`)
        kws.subscribe([tokens]);
        kws.setMode(kws.modeLTP, tokens);
    });
    kws.on('disconnect', (reason) => {
        console.error(`WebSocket disconnected: ${reason}`);
    });
    
    kws.on('error', (error) => {
        console.error(`WebSocket error: ${error.message}`);
    });
    
    kws.on('reconnect', (attempt, delay) => {
        console.log(`Attempting to reconnect (Attempt: ${attempt}) in ${delay}ms`);
    });

}
const sslOptions = {
    key: fs.readFileSync(config.ssl_key_path),
    cert: fs.readFileSync(config.ssl_cert_path)
  };
  

https.createServer(sslOptions, app).listen(config.port, () => {
    console.log(`Server running on https://localhost:${config.port}`);
    console.log(`open this link in browser http://localhost:${config.port}/kite`)

  });
  