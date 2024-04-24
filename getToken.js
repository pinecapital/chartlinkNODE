const fs = require('fs');

function readInstrumentsToDataFrame(filePath) {
    let rawData = fs.readFileSync(filePath);
    return JSON.parse(rawData);
}

function filterOptions(instruments, symbol, optionType, currentPrice) {
    const currentDate = new Date();
    const currentYear = currentDate.getFullYear();
    const currentDay = currentDate.getDate();
    const currentMonth = currentDate.getMonth() + 1; // JavaScript months are 0-indexed

    // Determine target month based on the current day
    let targetMonth = currentMonth;
    if (currentDay > 15) {
        // If it's after the 15th, use the next month
        targetMonth++;
        if (targetMonth > 12) {
            targetMonth = 1; // Wrap around to January of the next year
            currentYear++; // Increment the year if the month wraps
        }
    }

    // Filter options based on target year, target month, symbol, and option type (CE/PE for calls/puts)
    let options = instruments.filter(inst => {
        let expiryDate = new Date(inst.expiry);
        return expiryDate.getFullYear() === currentYear &&
               expiryDate.getMonth() + 1 === targetMonth &&
               inst.name === symbol && // Match the instrument symbol
               inst.instrument_type === optionType; // Match the option type (CE/PE)
    });

    // Calculate the difference between the instrument's strike price and the current price
    options.forEach(option => {
        option.strike_diff = Math.abs(option.strike - currentPrice);
    });

    // Sort options by the difference between strike price and current price to find the ATM option
    options.sort((a, b) => a.strike_diff - b.strike_diff);
    const atmOption = options.find(option => option.strike_diff === options[0].strike_diff);

    // Return the ATM option's details if found
    if (atmOption) {
        return {
            tradingsymbol: atmOption.tradingsymbol,
            instrument_token: atmOption.instrument_token,
            lot_size: atmOption.lot_size,
            tick_size: atmOption.tick_size
        };
    } else {
        return null; // Return null if no matching option is found
    }
}

module.exports = { readInstrumentsToDataFrame, filterOptions };
