require('dotenv').config();
const { readInstrumentsToDataFrame, filterOptions } = require('./getToken');

const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const fs = require('fs');
const KiteConnect = require("kiteconnect").KiteConnect;
const KiteTicker = require("kiteconnect").KiteTicker;

const app = express();
const port = process.env.PORT || 80;

// Middleware to parse request bodies
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());



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
const config = JSON.parse(fs.readFileSync('config.json'));

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

app.get('/login/callback', (req, res) => {
    const requestToken = req.query.request_token;
    if (requestToken) {
        kite.generateSession(requestToken, config.api_secret)
            .then(response => {
                currentAccessToken = response.access_token; // Update the in-memory token
                console.log("accesstoken after login",currentAccessToken)
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

                res.redirect('/kite');
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

app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
    console.log(`open this link in browser http://localhost:${port}/kite`)
});
