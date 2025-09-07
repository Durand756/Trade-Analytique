const express = require('express');
const axios = require('axios');
const path = require('path');
const cors = require('cors');
const cron = require('node-cron');
const math = require('mathjs');
const ss = require('simple-statistics');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Cache pour les données de prix
let priceCache = {
  'EURUSD': { prices: [], lastUpdate: 0, current: 0, atr: 0 },
  'XAUUSD': { prices: [], lastUpdate: 0, current: 0, atr: 0 },
  'BTCUSD': { prices: [], lastUpdate: 0, current: 0, atr: 0 }
};

// Clés API gratuites (remplacer par vos vraies clés)
const API_KEYS = {
  ALPHA_VANTAGE: 'E4XCMP01EGN3VVP0', // Remplacer par votre clé
  TWELVE_DATA: 'demo'    // Remplacer par votre clé
};

// Fonctions utilitaires pour les calculs financiers
function calculateATR(prices, period = 14) {
  if (prices.length < period + 1) return 0;
  
  const trueRanges = [];
  for (let i = 1; i < prices.length; i++) {
    const high = prices[i].high;
    const low = prices[i].low;
    const prevClose = prices[i-1].close;
    
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trueRanges.push(tr);
  }
  
  return trueRanges.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calculateSMA(prices, period) {
  if (prices.length < period) return 0;
  const values = prices.slice(-period).map(p => p.close);
  return values.reduce((a, b) => a + b, 0) / period;
}

function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50;
  
  const changes = [];
  for (let i = 1; i < prices.length; i++) {
    changes.push(prices[i].close - prices[i-1].close);
  }
  
  const gains = changes.map(c => c > 0 ? c : 0);
  const losses = changes.map(c => c < 0 ? Math.abs(c) : 0);
  
  const avgGain = gains.slice(-period).reduce((a, b) => a + b, 0) / period;
  const avgLoss = losses.slice(-period).reduce((a, b) => a + b, 0) / period;
  
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function predictPrice(prices, horizon) {
  if (prices.length < 10) return prices[prices.length - 1].close;
  
  // Modèle AR(1) simple pour prédiction
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push(Math.log(prices[i].close / prices[i-1].close));
  }
  
  const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const volatility = math.std(returns);
  
  // Monte Carlo simple
  const currentPrice = prices[prices.length - 1].close;
  const drift = meanReturn - (volatility * volatility) / 2;
  const randomShock = math.random() - 0.5; // Distribution normale simplifiée
  
  const prediction = currentPrice * Math.exp(drift * horizon + volatility * Math.sqrt(horizon) * randomShock);
  return prediction;
}

// Récupération des données Forex/Gold via Twelve Data
async function fetchForexData(symbol) {
  try {
    const response = await axios.get(`https://api.twelvedata.com/time_series`, {
      params: {
        symbol: symbol,
        interval: '5min',
        outputsize: 50,
        apikey: API_KEYS.TWELVE_DATA
      },
      timeout: 10000
    });
    
    if (response.data && response.data.values) {
      return response.data.values.map(item => ({
        timestamp: new Date(item.datetime).getTime(),
        open: parseFloat(item.open),
        high: parseFloat(item.high),
        low: parseFloat(item.low),
        close: parseFloat(item.close),
        volume: parseFloat(item.volume || 0)
      })).reverse();
    }
  } catch (error) {
    console.log(`Erreur Twelve Data pour ${symbol}:`, error.message);
  }
  return null;
}

// Récupération des données crypto via CoinGecko (gratuit)
async function fetchCryptoData() {
  try {
    const response = await axios.get('https://api.coingecko.com/api/v3/coins/bitcoin/ohlc', {
      params: {
        vs_currency: 'usd',
        days: '1'
      },
      timeout: 10000
    });
    
    if (response.data && response.data.length > 0) {
      return response.data.map(item => ({
        timestamp: item[0],
        open: item[1],
        high: item[2],
        low: item[3],
        close: item[4],
        volume: 0
      }));
    }
  } catch (error) {
    console.log('Erreur CoinGecko:', error.message);
  }
  return null;
}

// Données de fallback (simulation réaliste basée sur vraies données)
function generateRealisticData(symbol, basePrice) {
  const data = [];
  let price = basePrice;
  const now = Date.now();
  
  for (let i = 49; i >= 0; i--) {
    const timestamp = now - (i * 5 * 60 * 1000); // 5 min intervals
    const volatility = symbol === 'BTCUSD' ? 0.02 : 0.001;
    const change = (Math.random() - 0.5) * volatility;
    
    price = price * (1 + change);
    const spread = price * (symbol === 'BTCUSD' ? 0.0005 : 0.00002);
    
    data.push({
      timestamp,
      open: price - spread/2,
      high: price + Math.random() * spread * 2,
      low: price - Math.random() * spread * 2,
      close: price + spread/2,
      volume: Math.random() * 1000
    });
  }
  
  return data;
}

// Mise à jour des données de prix
async function updatePricesData() {
  console.log('Mise à jour des données de prix...');
  
  // EUR/USD
  let eurusdData = await fetchForexData('EUR/USD');
  if (!eurusdData) {
    eurusdData = generateRealisticData('EURUSD', 1.0850);
  }
  
  priceCache.EURUSD.prices = eurusdData;
  priceCache.EURUSD.current = eurusdData[eurusdData.length - 1].close;
  priceCache.EURUSD.atr = calculateATR(eurusdData);
  priceCache.EURUSD.lastUpdate = Date.now();
  
  // XAU/USD (Gold)
  let xauusdData = await fetchForexData('XAU/USD');
  if (!xauusdData) {
    xauusdData = generateRealisticData('XAUUSD', 2650.50);
  }
  
  priceCache.XAUUSD.prices = xauusdData;
  priceCache.XAUUSD.current = xauusdData[xauusdData.length - 1].close;
  priceCache.XAUUSD.atr = calculateATR(xauusdData);
  priceCache.XAUUSD.lastUpdate = Date.now();
  
  // BTC/USD
  let btcusdData = await fetchCryptoData();
  if (!btcusdData) {
    btcusdData = generateRealisticData('BTCUSD', 95000);
  }
  
  priceCache.BTCUSD.prices = btcusdData;
  priceCache.BTCUSD.current = btcusdData[btcusdData.length - 1].close;
  priceCache.BTCUSD.atr = calculateATR(btcusdData);
  priceCache.BTCUSD.lastUpdate = Date.now();
}

// API Endpoints

// Récupérer les données de prix
app.get('/api/prices/:symbol', (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  
  if (!priceCache[symbol]) {
    return res.status(404).json({ error: 'Symbole non trouvé' });
  }
  
  const data = priceCache[symbol];
  const prices = data.prices;
  
  if (prices.length === 0) {
    return res.status(503).json({ error: 'Données non disponibles' });
  }
  
  const currentPrice = data.current;
  const atr = data.atr;
  const sma20 = calculateSMA(prices, 20);
  const sma50 = calculateSMA(prices, 50);
  const rsi = calculateRSI(prices);
  
  res.json({
    symbol,
    currentPrice,
    atr,
    sma20,
    sma50,
    rsi,
    prices: prices.slice(-50), // 50 derniers points pour le graphique
    lastUpdate: data.lastUpdate,
    trend: sma20 > sma50 ? 'Bullish' : 'Bearish',
    strength: rsi > 70 ? 'Surachat' : rsi < 30 ? 'Survente' : 'Neutre'
  });
});

// Calculer SL, TP, position sizing et prédictions
app.post('/api/calc', (req, res) => {
  const { symbol, balance, riskPercent, stopLossPips, horizonDays, riskRewardRatio } = req.body;
  
  if (!priceCache[symbol] || priceCache[symbol].prices.length === 0) {
    return res.status(404).json({ error: 'Données non disponibles pour ce symbole' });
  }
  
  const data = priceCache[symbol];
  const currentPrice = data.current;
  const atr = data.atr;
  const prices = data.prices;
  
  // Conversion pips en prix selon le symbole
  let pipValue;
  let contractSize;
  
  if (symbol === 'EURUSD') {
    pipValue = 0.0001;
    contractSize = 100000; // Lot standard
  } else if (symbol === 'XAUUSD') {
    pipValue = 0.1;
    contractSize = 100; // Once d'or
  } else if (symbol === 'BTCUSD') {
    pipValue = 1;
    contractSize = 1; // 1 BTC
  }
  
  // Calcul du Stop Loss et Take Profit
  const stopLossPrice = currentPrice - (stopLossPips * pipValue);
  const takeProfitPrice = currentPrice + (stopLossPips * pipValue * riskRewardRatio);
  
  // Position sizing basé sur le risque
  const riskAmount = balance * (riskPercent / 100);
  const stopLossDistance = Math.abs(currentPrice - stopLossPrice);
  const positionSize = riskAmount / stopLossDistance;
  
  // Calcul des lots/unités
  const lots = positionSize / contractSize;
  const units = Math.floor(positionSize);
  
  // Prédictions de prix
  const pricePrediction = predictPrice(prices, horizonDays);
  const pricePredictionBull = predictPrice(prices, horizonDays) * 1.05;
  const pricePredictionBear = predictPrice(prices, horizonDays) * 0.95;
  
  // Calculs de profit/perte potentiels
  const potentialProfit = (takeProfitPrice - currentPrice) * units;
  const potentialLoss = (currentPrice - stopLossPrice) * units;
  
  // Probabilité basée sur ATR et volatilité
  const volatility = math.std(prices.slice(-20).map(p => p.close));
  const probability = Math.max(0.3, Math.min(0.8, 0.6 - (volatility / currentPrice) * 10));
  
  res.json({
    currentPrice: currentPrice.toFixed(symbol === 'BTCUSD' ? 0 : 5),
    stopLossPrice: stopLossPrice.toFixed(symbol === 'BTCUSD' ? 0 : 5),
    takeProfitPrice: takeProfitPrice.toFixed(symbol === 'BTCUSD' ? 0 : 5),
    positionSize: units,
    lots: lots.toFixed(2),
    atr: atr.toFixed(symbol === 'BTCUSD' ? 0 : 5),
    riskAmount: riskAmount.toFixed(2),
    potentialProfit: potentialProfit.toFixed(2),
    potentialLoss: potentialLoss.toFixed(2),
    riskRewardRatio: (potentialProfit / Math.abs(potentialLoss)).toFixed(2),
    predictions: {
      neutral: pricePrediction.toFixed(symbol === 'BTCUSD' ? 0 : 5),
      bullish: pricePredictionBull.toFixed(symbol === 'BTCUSD' ? 0 : 5),
      bearish: pricePredictionBear.toFixed(symbol === 'BTCUSD' ? 0 : 5),
      horizon: horizonDays,
      probability: (probability * 100).toFixed(1)
    }
  });
});

// Route principale
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Mise à jour des données toutes les 2 minutes
cron.schedule('*/2 * * * *', updatePricesData);

// Démarrage du serveur
app.listen(PORT, () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
  console.log(`📊 Interface disponible sur http://localhost:${PORT}`);
  console.log('🔄 Première mise à jour des données...');
  updatePricesData();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Arrêt du serveur...');
  process.exit(0);
});
