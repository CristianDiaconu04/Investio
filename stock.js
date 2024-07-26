class Stock {
    constructor(name, numShares, buyPrice, curPrice) {
        this.name = name; // This is the stock ticker, ex: AAPL for Apple 
        this.numShares = numShares; 
        this.buyPrice = buyPrice;
        this.curPrice = curPrice;
    }
}

module.exports = Stock;
