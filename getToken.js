const fs = require('fs');

function readInstrumentsToDataFrame(filePath) {
    let rawData = fs.readFileSync(filePath);
    return JSON.parse(rawData);
}

function filterOptions(instruments, symbol, optionType, currentPrice) {
    const currentDate = new Date();
    const currentYear = currentDate.getFullYear();
    const currentMonth = currentDate.getMonth() + 1; // JavaScript months are 0-indexed

    let options = instruments.filter(inst => {
        let expiryDate = new Date(inst.expiry);
        return expiryDate.getFullYear() === currentYear &&
               expiryDate.getMonth() + 1 === currentMonth &&
               inst.name === symbol &&
               inst.instrument_type === optionType;
    });

    options.forEach(option => {
        option.strike_diff = Math.abs(option.strike - currentPrice);
    });

    // Find the option with the strike price closest to the current price (ATM)
    options.sort((a, b) => a.strike_diff - b.strike_diff);
    const atmOption = options.find(option => option.strike_diff === options[0].strike_diff);

    return atmOption ? [atmOption] : []; // Return an array for consistency
}

// Example usage
const instrumentsFilePath = 'instruments.json'; // Adjust the file path if necessary
const instruments = readInstrumentsToDataFrame(instrumentsFilePath);

const symbol = 'SBIN';
const optionType = 'CE'; // Example option type
const currentPrice = 726; // Example current price

const atmOptions = filterOptions(instruments, symbol, optionType, currentPrice);
console.log(atmOptions);
