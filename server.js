const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');
const WebSocket = require('ws');
const math = require('mathjs');
const ss = require('simple-statistics');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Cache pour les données de prix
let priceCache = {
  'EUR/USD': { price: 0, history: [], lastUpdate: 0 },
  'XAU/USD': { price: 0, history: [], lastUpdate: 0 },
  'BTC/USD': { price: 0, history: [], lastUpdate: 0 }
};

// Configuration des APIs
const API_KEYS = {
  alphavantage: process.env.ALPHAVANTAGE_KEY || 'demo',
  twelvedata: process.env.TWELVEDATA_KEY || 'demo',
  finhub: process.env.FINNHUB_KEY || 'demo'
};

// Fonctions d'analyse technique avancée
class TechnicalAnalyzer {
  static calculateATR(prices, period = 14) {
    if (prices.length < period + 1) return 0;
    
    let trueRanges = [];
    for (let i = 1; i < prices.length; i++) {
      const current = prices[i];
      const previous = prices[i - 1];
      
      const tr = Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close)
      );
      trueRanges.push(tr);
    }
    
    return ss.mean(trueRanges.slice(-period));
  }
  
  static calculateRSI(prices, period = 14) {
    if (prices.length < period + 1) return 50;
    
    let gains = [];
    let losses = [];
    
    for (let i = 1; i < prices.length; i++) {
      const change = prices[i].close - prices[i - 1].close;
      if (change > 0) {
        gains.push(change);
        losses.push(0);
      } else {
        gains.push(0);
        losses.push(Math.abs(change));
      }
    }
    
    const avgGain = ss.mean(gains.slice(-period));
    const avgLoss = ss.mean(losses.slice(-period));
    
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }
  
  static calculateBollingerBands(prices, period = 20, stdDev = 2) {
    if (prices.length < period) return { upper: 0, middle: 0, lower: 0 };
    
    const closePrices = prices.slice(-period).map(p => p.close);
    const sma = ss.mean(closePrices);
    const std = ss.standardDeviation(closePrices);
    
    return {
      upper: sma + (std * stdDev),
      middle: sma,
      lower: sma - (std * stdDev)
    };
  }
  
  static calculateMACD(prices, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
    if (prices.length < slowPeriod) return { macd: 0, signal: 0, histogram: 0 };
    
    const closePrices = prices.map(p => p.close);
    
    // Calcul des EMA
    const fastEMA = this.calculateEMA(closePrices, fastPeriod);
    const slowEMA = this.calculateEMA(closePrices, slowPeriod);
    
    const macdLine = fastEMA - slowEMA;
    
    // Signal line (EMA du MACD)
    const macdHistory = [macdLine]; // Simplifié pour la démonstration
    const signalLine = this.calculateEMA(macdHistory, signalPeriod);
    
    return {
      macd: macdLine,
      signal: signalLine,
      histogram: macdLine - signalLine
    };
  }
  
  static calculateEMA(prices, period) {
    if (prices.length === 0) return 0;
    
    const k = 2 / (period + 1);
    let ema = prices[0];
    
    for (let i = 1; i < prices.length; i++) {
      ema = (prices[i] * k) + (ema * (1 - k));
    }
    
    return ema;
  }
  
  static calculateFibonacciLevels(high, low) {
    const range = high - low;
    return {
      '0%': high,
      '23.6%': high - (range * 0.236),
      '38.2%': high - (range * 0.382),
      '50%': high - (range * 0.5),
      '61.8%': high - (range * 0.618),
      '78.6%': high - (range * 0.786),
      '100%': low
    };
  }
}

// Récupération des données en temps réel
async function fetchEURUSD() {
  try {
    // API AlphaVantage pour EUR/USD
    const response = await axios.get(`https://www.alphavantage.co/query`, {
      params: {
        function: 'FX_INTRADAY',
        from_symbol: 'EUR',
        to_symbol: 'USD',
        interval: '1min',
        apikey: API_KEYS.alphavantage
      }
    });
    
    if (response.data['Time Series FX (1min)']) {
      const timeSeries = response.data['Time Series FX (1min)'];
      const latestTime = Object.keys(timeSeries)[0];
      const latestData = timeSeries[latestTime];
      
      const price = parseFloat(latestData['4. close']);
      const candleData = {
        time: latestTime,
        open: parseFloat(latestData['1. open']),
        high: parseFloat(latestData['2. high']),
        low: parseFloat(latestData['3. low']),
        close: price,
        volume: parseFloat(latestData['5. volume'] || 0)
      };
      
      priceCache['EUR/USD'].price = price;
      priceCache['EUR/USD'].history.push(candleData);
      priceCache['EUR/USD'].lastUpdate = Date.now();
      
      // Garder seulement les 1000 dernières bougies
      if (priceCache['EUR/USD'].history.length > 1000) {
        priceCache['EUR/USD'].history = priceCache['EUR/USD'].history.slice(-1000);
      }
    }
  } catch (error) {
    console.error('Erreur récupération EUR/USD:', error.message);
    // Fallback avec données simulées réalistes
    const lastPrice = priceCache['EUR/USD'].price || 1.0850;
    const volatility = 0.0001;
    const newPrice = lastPrice + (Math.random() - 0.5) * volatility;
    priceCache['EUR/USD'].price = newPrice;
  }
}

async function fetchXAUUSD() {
  try {
    // API pour l'or (utilisation de Finnhub comme fallback)
    const response = await axios.get('https://finnhub.io/api/v1/quote', {
      params: {
        symbol: 'OANDA:XAUUSD',
        token: API_KEYS.finhub
      }
    });
    
    if (response.data.c) {
      const price = response.data.c;
      const candleData = {
        time: new Date().toISOString(),
        open: response.data.o,
        high: response.data.h,
        low: response.data.l,
        close: price,
        volume: 0
      };
      
      priceCache['XAU/USD'].price = price;
      priceCache['XAU/USD'].history.push(candleData);
      priceCache['XAU/USD'].lastUpdate = Date.now();
      
      if (priceCache['XAU/USD'].history.length > 1000) {
        priceCache['XAU/USD'].history = priceCache['XAU/USD'].history.slice(-1000);
      }
    }
  } catch (error) {
    console.error('Erreur récupération XAU/USD:', error.message);
    // Fallback
    const lastPrice = priceCache['XAU/USD'].price || 2000;
    const volatility = 5;
    const newPrice = lastPrice + (Math.random() - 0.5) * volatility;
    priceCache['XAU/USD'].price = newPrice;
  }
}

async function fetchBTCUSD() {
  try {
    // API CoinGecko pour Bitcoin
    const response = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
      params: {
        ids: 'bitcoin',
        vs_currencies: 'usd',
        include_24hr_change: 'true',
        include_24hr_vol: 'true',
        include_last_updated_at: 'true'
      }
    });
    
    if (response.data.bitcoin) {
      const price = response.data.bitcoin.usd;
      const candleData = {
        time: new Date().toISOString(),
        open: price * 0.999, // Approximation
        high: price * 1.001,
        low: price * 0.998,
        close: price,
        volume: response.data.bitcoin.usd_24h_vol || 0
      };
      
      priceCache['BTC/USD'].price = price;
      priceCache['BTC/USD'].history.push(candleData);
      priceCache['BTC/USD'].lastUpdate = Date.now();
      
      if (priceCache['BTC/USD'].history.length > 1000) {
        priceCache['BTC/USD'].history = priceCache['BTC/USD'].history.slice(-1000);
      }
    }
  } catch (error) {
    console.error('Erreur récupération BTC/USD:', error.message);
    // Fallback
    const lastPrice = priceCache['BTC/USD'].price || 45000;
    const volatility = 500;
    const newPrice = lastPrice + (Math.random() - 0.5) * volatility;
    priceCache['BTC/USD'].price = newPrice;
  }
}

// Mise à jour automatique des prix
async function updateAllPrices() {
  console.log('Mise à jour des prix en cours...');
  await Promise.all([
    fetchEURUSD(),
    fetchXAUUSD(),
    fetchBTCUSD()
  ]);
  console.log('Mise à jour terminée');
}

// Endpoints API
app.get('/api/prices/:symbol', (req, res) => {
  const symbol = req.params.symbol.replace('-', '/');
  
  if (priceCache[symbol]) {
    const data = priceCache[symbol];
    const history = data.history.slice(-100); // Dernières 100 bougies
    
    res.json({
      symbol,
      currentPrice: data.price,
      lastUpdate: data.lastUpdate,
      history,
      count: history.length
    });
  } else {
    res.status(404).json({ error: 'Symbole non supporté' });
  }
});

app.post('/api/calc', (req, res) => {
  try {
    const {
      symbol,
      balance,
      riskPercent,
      stopLossPips,
      takeProfitRatio,
      timeHorizon,
      currentPrice
    } = req.body;
    
    const symbolKey = symbol.replace('-', '/');
    const data = priceCache[symbolKey];
    
    if (!data || data.history.length === 0) {
      return res.status(400).json({ error: 'Données insuffisantes' });
    }
    
    // Calculs d'analyse technique avancée
    const atr = TechnicalAnalyzer.calculateATR(data.history);
    const rsi = TechnicalAnalyzer.calculateRSI(data.history);
    const bollinger = TechnicalAnalyzer.calculateBollingerBands(data.history);
    const macd = TechnicalAnalyzer.calculateMACD(data.history);
    
    // Calcul de la volatilité historique
    const returns = [];
    for (let i = 1; i < data.history.length; i++) {
      const ret = Math.log(data.history[i].close / data.history[i-1].close);
      returns.push(ret);
    }
    const volatility = ss.standardDeviation(returns) * Math.sqrt(252); // Annualisée
    
    // Détermination de la taille de position
    const riskAmount = balance * (riskPercent / 100);
    const pipValue = symbol.includes('USD') ? 
      (symbol === 'BTC-USD' ? 1 : 0.0001) : 0.0001;
    
    const stopLossDistance = stopLossPips * pipValue;
    const positionSize = riskAmount / stopLossDistance;
    
    // Calcul des niveaux de SL/TP dynamiques basés sur ATR
    const atrMultiplier = 2;
    const dynamicSL = currentPrice - (atr * atrMultiplier);
    const dynamicTP = currentPrice + (atr * atrMultiplier * takeProfitRatio);
    
    // Calcul des niveaux de Fibonacci
    const recentHigh = Math.max(...data.history.slice(-50).map(h => h.high));
    const recentLow = Math.min(...data.history.slice(-50).map(h => h.low));
    const fibonacciLevels = TechnicalAnalyzer.calculateFibonacciLevels(recentHigh, recentLow);
    
    // Prédiction de prix basée sur analyse technique
    let trendDirection = 0;
    if (rsi > 70) trendDirection = -0.5; // Surachat
    else if (rsi < 30) trendDirection = 0.5; // Survente
    
    if (macd.macd > macd.signal) trendDirection += 0.3; // Signal haussier
    else trendDirection -= 0.3; // Signal baissier
    
    if (currentPrice > bollinger.upper) trendDirection -= 0.2;
    else if (currentPrice < bollinger.lower) trendDirection += 0.2;
    
    // Prédiction basée sur la volatilité et la tendance
    const expectedReturn = trendDirection * volatility * Math.sqrt(timeHorizon / 365);
    const predictedPrice = currentPrice * (1 + expectedReturn);
    
    // Calcul de probabilité de succès
    const pricePosition = (currentPrice - bollinger.lower) / (bollinger.upper - bollinger.lower);
    const successProbability = Math.max(0.1, Math.min(0.9, 
      0.5 + (trendDirection * 0.3) + ((0.5 - pricePosition) * 0.2)
    ));
    
    // Calcul du ratio risque/récompense optimal
    const optimalRR = Math.max(1.5, Math.min(4, volatility * 100));
    
    res.json({
      symbol: symbolKey,
      analysis: {
        currentPrice,
        atr: parseFloat(atr.toFixed(5)),
        rsi: parseFloat(rsi.toFixed(2)),
        volatility: parseFloat((volatility * 100).toFixed(2)),
        bollinger,
        macd,
        fibonacciLevels,
        trendStrength: parseFloat(Math.abs(trendDirection).toFixed(2))
      },
      position: {
        size: parseFloat(positionSize.toFixed(2)),
        riskAmount: parseFloat(riskAmount.toFixed(2)),
        stopLoss: parseFloat(dynamicSL.toFixed(5)),
        takeProfit: parseFloat(dynamicTP.toFixed(5)),
        riskRewardRatio: parseFloat(optimalRR.toFixed(2))
      },
      prediction: {
        targetPrice: parseFloat(predictedPrice.toFixed(5)),
        timeHorizon,
        successProbability: parseFloat((successProbability * 100).toFixed(1)),
        expectedReturn: parseFloat((expectedReturn * 100).toFixed(2)),
        confidence: parseFloat((Math.min(data.history.length / 100, 1) * 100).toFixed(0))
      },
      signals: {
        buy: trendDirection > 0.2 && rsi < 60,
        sell: trendDirection < -0.2 && rsi > 40,
        strength: Math.abs(trendDirection)
      }
    });
    
  } catch (error) {
    console.error('Erreur calcul:', error);
    res.status(500).json({ error: 'Erreur lors du calcul' });
  }
});

// Route principale
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Démarrage du serveur
app.listen(PORT, () => {
  console.log(`🚀 Serveur de trading en cours d'exécution sur le port ${PORT}`);
  
  // Mise à jour initiale des prix
  updateAllPrices();
  
  // Programmation des mises à jour automatiques
  cron.schedule('*/30 * * * * *', updateAllPrices); // Toutes les 30 secondes
});

// Gestion de l'arrêt propre
process.on('SIGINT', () => {
  console.log('Arrêt du serveur...');
  process.exit(0);
});
