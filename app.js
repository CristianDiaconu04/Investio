const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const bodyParser = require('body-parser');
const session = require('express-session');
const path = require('path');
const axios = require('axios');
const Stock = require('./Stock'); // Import the Stock class

const { MONGO_USERNAME, MONGO_PASSWORD, MONGO_CLUSTER } = require('./credentials'); // Import MongoDB credentials

const app = express();

const ALPHA_VANTAGE_API_KEY = 'YOUR_ALPHA_VANTAGE_API_KEY'; // Replace with your Alpha Vantage API key

console.log('Connecting to MongoDB...');

// MongoDB connection
const mongoUri = `mongodb+srv://${MONGO_USERNAME}:${MONGO_PASSWORD}@${MONGO_CLUSTER}.mongodb.net/InvestmentGame`;

mongoose.connect(mongoUri, {
    useNewUrlParser: true,
    useUnifiedTopology: true
})
    .then(() => {
        console.log('Connected to MongoDB');
    })
    .catch((err) => {
        console.error('MongoDB connection error:', err);
    });

const StockSchema = new mongoose.Schema({
    name: String,
    numShares: Number,
    buyPrice: Number,
    curPrice: Number
});

StockSchema.virtual('percentChange').get(function() {
    return ((this.curPrice - this.buyPrice) / this.buyPrice) * 100;
});

const UserSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    cashBalance: { type: Number, default: 10000 },
    totalBalance: { type: Number, default: 10000 },
    stocks: { type: [StockSchema], default: [] }
});

UserSchema.set('toJSON', { virtuals: true });
UserSchema.set('toObject', { virtuals: true });

const User = mongoose.model('User', UserSchema);

app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({ secret: 'your_secret_key', resave: false, saveUninitialized: true }));

// Serve static files from the "styles" directory
app.use('/styles', express.static(path.join(__dirname, 'styles')));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.get('/', (req, res) => {
    res.render('base');
});

app.post('/', async (req, res) => {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (user && bcrypt.compareSync(password, user.password)) {
        req.session.username = user.username;
        res.redirect('/main');
    } else {
        res.send('Invalid username/password combination!');
    }
});

app.get('/register', (req, res) => {
    res.render('register');
});

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    const existingUser = await User.findOne({ username });
    if (existingUser) {
        return res.send('Username already exists!');
    }
    const hashedPassword = bcrypt.hashSync(password, 10);
    const user = new User({ username, password: hashedPassword });
    await user.save();
    res.redirect('/');
});

// Function to get current stock price from Alpha Vantage
async function getStockPrice(stockTicker) {
    try {
        const response = await axios.get(`https://www.alphavantage.co/query`, {
            params: {
                function: 'GLOBAL_QUOTE',
                symbol: stockTicker,
                apikey: ALPHA_VANTAGE_API_KEY
            }
        });

        console.log(response.data); // Log the full response for debugging

        const price = response.data['Global Quote']['05. price'];
        if (!price) {
            throw new Error('Price not found in response');
        }
        return parseFloat(price);
    } catch (error) {
        console.error('Error fetching stock price:', error);
        return null;
    }
}

app.get('/main', async (req, res) => {
    if (!req.session.username) {
        return res.redirect('/');
    }

    const user = await User.findOne({ username: req.session.username });

    if (!user) {
        return res.redirect('/');
    }

    // Update the current price for each stock
    const updatedStocks = await Promise.all(user.stocks.map(async (stock) => {
        const currentPrice = await getStockPrice(stock.name);
        if (currentPrice) {
            stock.curPrice = currentPrice;
        }
        return stock;
    }));

    // Calculate the total balance
    user.totalBalance = user.cashBalance + updatedStocks.reduce((total, stock) => total + (stock.curPrice * stock.numShares), 0);

    await user.save();

    res.render('mainPage', {
        username: user.username,
        cashBalance: user.cashBalance,
        totalBalance: user.totalBalance,
        stocks: user.stocks
    });
});

// Route to handle fetching stock price
app.post('/getStockPrice', async (req, res) => {
    if (!req.session.username) {
        return res.redirect('/');
    }

    const { stockTicker } = req.body;
    const stockPrice = await getStockPrice(stockTicker);

    if (!stockPrice) {
        return res.send('Error fetching stock price.');
    }

    const user = await User.findOne({ username: req.session.username });

    res.render('mainPage', {
        username: user.username,
        cashBalance: user.cashBalance,
        totalBalance: user.totalBalance,
        stocks: user.stocks,
        stockPrice: stockPrice,
        stockTicker: stockTicker
    });
});

// Route to handle buying stocks
app.post('/buy', async (req, res) => {
    if (!req.session.username) {
        return res.redirect('/');
    }

    const { stockTicker, numShares } = req.body;
    const user = await User.findOne({ username: req.session.username });

    if (!user) {
        return res.redirect('/');
    }

    const stockPrice = await getStockPrice(stockTicker);

    if (!stockPrice) {
        return res.send('Error fetching stock price.');
    }

    const cost = stockPrice * numShares;

    if (user.cashBalance < cost) {
        return res.send('Insufficient funds.');
    }

    const existingStock = user.stocks.find(stock => stock.name === stockTicker);

    if (existingStock) {
        existingStock.numShares += parseInt(numShares, 10);
        existingStock.buyPrice = ((existingStock.buyPrice * (existingStock.numShares - numShares)) + cost) / existingStock.numShares;
        existingStock.curPrice = stockPrice;
    } else {
        user.stocks.push(new Stock(stockTicker, parseInt(numShares, 10), stockPrice, stockPrice));
    }

    user.cashBalance -= cost;
    user.totalBalance = user.cashBalance + user.stocks.reduce((total, stock) => total + (stock.curPrice * stock.numShares), 0);

    await user.save();

    res.redirect('/main');
});

// Route to handle selling stocks
app.post('/sell', async (req, res) => {
    if (!req.session.username) {
        return res.redirect('/');
    }

    const { stockTicker, sellNumShares } = req.body;
    const user = await User.findOne({ username: req.session.username });

    if (!user) {
        return res.redirect('/');
    }

    const stockPrice = await getStockPrice(stockTicker);

    if (!stockPrice) {
        return res.send('Error fetching stock price.');
    }

    const existingStock = user.stocks.find(stock => stock.name === stockTicker);

    if (!existingStock || existingStock.numShares < sellNumShares) {
        return res.send('Not enough shares to sell.');
    }

    const sellValue = stockPrice * sellNumShares;
    existingStock.numShares -= parseInt(sellNumShares, 10);

    if (existingStock.numShares === 0) {
        user.stocks = user.stocks.filter(stock => stock.name !== stockTicker);
    } else {
        existingStock.curPrice = stockPrice;
    }

    user.cashBalance += sellValue;
    user.totalBalance = user.cashBalance + user.stocks.reduce((total, stock) => total + (stock.curPrice * stock.numShares), 0);

    await user.save();

    res.redirect('/main');
});

app.listen(3000, () => {
    console.log('Server is running on port 3000');
});
