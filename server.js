const express = require('express');
const axios = require('axios');
const math = require('mathjs');
const ss = require('simple-statistics');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// ===== FORMULES MATHÉMATIQUES AVANCÉES =====

/*
1. DIFFUSION GAUSSIENNE (Mouvement Brownien Géométrique) :
   P(t) = P₀ × exp((μ - σ²/2)×t + σ×√t×Z)
   où Z ~ N(0,1), μ = drift, σ = volatilité

2. ATR (Average True Range) :
   ATR = (1/n) × Σᵢ₌₁ⁿ max[Hᵢ-Lᵢ, |Hᵢ-C_{i-1}|, |Lᵢ-C_{i-1}|]

3. AR(1) - Processus Autorégressif d'ordre 1 :
   X_t = φ×X_{t-1} + ε_t
   où ε_t ~ N(0,σ²), |φ| < 1 pour stationnarité

4. FOURIER EXPANSION pour saisonnalité :
   y(t) = a₀ + Σₖ₌₁ⁿ [aₖ×cos(2πkt/T) + bₖ×sin(2πkt/T)]

5. VOLATILITÉ GARCH(1,1) simplifiée :
   σ²_t = ω + α×ε²_{t-1} + β×σ²_{t-1}

6. BLACK-SCHOLES pour options (référence) :
   C = S₀×N(d₁) - K×e^{-rT}×N(d₂)
   d₁ = [ln(S₀/K) + (r + σ²/2)T] / (σ√T)
*/

// Configuration des APIs
const API_CONFIGS = {
  forex: 'https://api.exchangerate-api.com/v4/latest/EUR',
  crypto: 'https://api.coingecko.com/api/v3/simple/price',
  gold: 'https://api.metals.live/v1/spot/gold'
};

// Générateur de données historiques simulées
function generateMockPrices(basePrice, days = 30, volatility = 0.02) {
  const prices = [];
  let currentPrice = basePrice;
  
  for (let i = 0; i < days; i++) {
    // Mouvement Brownien avec drift légèrement positif
    const drift = 0.0001; // 0.01% par jour
    const shock = math.random(-1, 1) * volatility;
    const change = drift + shock;
    currentPrice *= (1 + change);
    
    prices.push({
      date: new Date(Date.now() - (days - i) * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      price: Math.round(currentPrice * 100000) / 100000
    });
  }
  
  return prices;
}

// Calcul ATR (Average True Range)
function calculateATR(prices, period = 14) {
  if (prices.length < period + 1) return 0.02; // Valeur par défaut
  
  const trueRanges = [];
  for (let i = 1; i < prices.length; i++) {
    const high = prices[i].price * 1.001; // Approximation H-L
    const low = prices[i].price * 0.999;
    const prevClose = prices[i-1].price;
    
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trueRanges.push(tr);
  }
  
  return ss.mean(trueRanges.slice(-period));
}

// Calcul AR(1) - Autoregressive model
function calculateAR1Forecast(prices, horizon) {
  if (prices.length < 10) return { forecast: prices[prices.length-1].price, confidence: 0.5 };
  
  // Calcul des rendements log
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push(Math.log(prices[i].price / prices[i-1].price));
  }
  
  // Estimation φ par régression simple
  const laggedReturns = returns.slice(0, -1);
  const currentReturns = returns.slice(1);
  
  const phi = ss.sampleCorrelation(laggedReturns, currentReturns);
  const residualVar = ss.sampleVariance(currentReturns);
  
  // Prédiction AR(1): X_t = φ×X_{t-1}
  let forecastReturn = phi * returns[returns.length - 1];
  const forecastPrice = prices[prices.length-1].price * Math.exp(forecastReturn * horizon);
  
  return {
    forecast: forecastPrice,
    confidence: Math.max(0.1, 1 - Math.abs(phi)),
    phi: phi
  };
}

// Analyse de Fourier simplifiée pour saisonnalité
function calculateSeasonalityFourier(prices, horizon) {
  if (prices.length < 20) return { forecast: prices[prices.length-1].price, seasonality: 'insufficient_data' };
  
  // Extraction des composantes cycliques (approximation)
  const values = prices.map(p => p.price);
  const n = values.length;
  const T = n; // Période complète
  
  // Coefficients Fourier (première harmonique seulement)
  let a1 = 0, b1 = 0;
  for (let i = 0; i < n; i++) {
    a1 += values[i] * Math.cos(2 * Math.PI * i / T);
    b1 += values[i] * Math.sin(2 * Math.PI * i / T);
  }
  a1 *= (2/n);
  b1 *= (2/n);
  
  // Prédiction avec composante saisonnière
  const t_future = n + horizon;
  const seasonalComponent = a1 * Math.cos(2 * Math.PI * t_future / T) + 
                           b1 * Math.sin(2 * Math.PI * t_future / T);
  
  const trend = ss.mean(values);
  const forecast = trend + seasonalComponent;
  
  return {
    forecast: Math.max(forecast, 0),
    seasonality: { a1, b1, period: T },
    amplitude: Math.sqrt(a1*a1 + b1*b1)
  };
}

// Diffusion gaussienne (Geometric Brownian Motion)
function calculateGBMForecast(prices, horizon) {
  if (prices.length < 5) return { forecast: prices[prices.length-1].price, confidence: [0.8, 1.2] };
  
  // Calcul des rendements
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push(Math.log(prices[i].price / prices[i-1].price));
  }
  
  const mu = ss.mean(returns); // Drift
  const sigma = ss.standardDeviation(returns); // Volatilité
  
  const S0 = prices[prices.length-1].price;
  const t = horizon / 365; // Conversion en années
  
  // P(t) = P₀ × exp((μ - σ²/2)×t + σ×√t×Z)
  const drift_term = (mu - (sigma * sigma) / 2) * t;
  const forecast = S0 * Math.exp(drift_term);
  
  // Intervalle de confiance (±1.96σ pour 95%)
  const volatility_term = sigma * Math.sqrt(t);
  const conf_lower = S0 * Math.exp(drift_term - 1.96 * volatility_term);
  const conf_upper = S0 * Math.exp(drift_term + 1.96 * volatility_term);
  
  return {
    forecast: forecast,
    confidence: [conf_lower / S0, conf_upper / S0],
    mu: mu,
    sigma: sigma,
    annualized_vol: sigma * Math.sqrt(365)
  };
}

// Routes API

// Route pour obtenir les prix en temps réel
app.get('/api/price/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    let price = 1.0;
    
    if (symbol === 'EURUSD') {
      // Simulation prix EUR/USD
      price = 1.0850 + (Math.random() - 0.5) * 0.01;
    } else if (symbol === 'XAUUSD') {
      // Simulation prix Gold/USD
      price = 2025 + (Math.random() - 0.5) * 50;
    } else if (symbol === 'BTCUSD') {
      try {
        const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
        price = response.data.bitcoin.usd;
      } catch (error) {
        price = 65000 + (Math.random() - 0.5) * 5000; // Fallback
      }
    }
    
    // Génération de données historiques simulées
    const historicalData = generateMockPrices(price, 30);
    
    res.json({
      symbol: symbol,
      price: Math.round(price * 100000) / 100000,
      timestamp: new Date().toISOString(),
      historical: historicalData
    });
    
  } catch (error) {
    res.status(500).json({ error: 'Erreur lors de la récupération du prix', details: error.message });
  }
});

// Route pour les calculs de trading avancés
app.post('/api/calc', (req, res) => {
  try {
    const { balance, risk, entry, stopLossPips, symbol, horizonHours } = req.body;
    
    // Validation des données
    if (!balance || !risk || !entry || !stopLossPips || !horizonHours) {
      return res.status(400).json({ error: 'Paramètres manquants' });
    }
    
    // Génération des prix historiques pour l'analyse
    const historicalPrices = generateMockPrices(entry, 30);
    
    // 1. Calcul ATR-based SL/TP
    const atr = calculateATR(historicalPrices);
    const atrMultiplier = 2.0;
    const stopLossATR = entry - (atr * atrMultiplier);
    const takeProfitATR = entry + (atr * atrMultiplier * 1.5); // R:R = 1:1.5
    
    // 2. Fixed Ratio R:R (1:2)
    const pipValue = symbol === 'BTCUSD' ? 1 : 0.0001;
    const stopLossFixed = entry - (stopLossPips * pipValue);
    const takeProfitFixed = entry + (stopLossPips * pipValue * 2); // R:R = 1:2
    
    // 3. Statistical Diffusion (GBM)
    const gbmForecast = calculateGBMForecast(historicalPrices, horizonHours / 24);
    const volatilityTerm = Math.sqrt(horizonHours / (24 * 365)) * gbmForecast.sigma * entry;
    const stopLossDiffusion = entry - volatilityTerm * 1.96;
    const takeProfitDiffusion = entry + volatilityTerm * 1.96;
    
    // 4. AR(1) Model
    const ar1Forecast = calculateAR1Forecast(historicalPrices, horizonHours / 24);
    
    // 5. Fourier Seasonality
    const seasonalForecast = calculateSeasonalityFourier(historicalPrices, horizonHours / 24);
    
    // Position Sizing: units = (balance × risk%) / (stopLossPips × pipValue)
    const riskAmount = balance * (risk / 100);
    const stopLossDistance = stopLossPips * pipValue;
    const positionSize = riskAmount / stopLossDistance;
    
    // Prévisions combinées
    const forecasts = {
      gbm: gbmForecast,
      ar1: ar1Forecast,
      seasonal: seasonalForecast,
      ensemble: (gbmForecast.forecast + ar1Forecast.forecast + seasonalForecast.forecast) / 3
    };
    
    // Réponse détaillée
    const result = {
      symbol: symbol,
      currentPrice: entry,
      balance: balance,
      riskPercent: risk,
      positionSize: Math.round(positionSize * 100) / 100,
      riskAmount: Math.round(riskAmount * 100) / 100,
      
      methods: {
        atr_based: {
          name: "ATR-Based",
          formula: "SL/TP = Entry ± (ATR × Multiplier)",
          atr_value: Math.round(atr * 100000) / 100000,
          stopLoss: Math.round(stopLossATR * 100000) / 100000,
          takeProfit: Math.round(takeProfitATR * 100000) / 100000,
          riskReward: "1:1.5"
        },
        
        fixed_ratio: {
          name: "Fixed R:R (1:2)",
          formula: "SL = Entry - (Pips × PipValue), TP = Entry + (Pips × PipValue × 2)",
          stopLoss: Math.round(stopLossFixed * 100000) / 100000,
          takeProfit: Math.round(takeProfitFixed * 100000) / 100000,
          riskReward: "1:2"
        },
        
        statistical_diffusion: {
          name: "Diffusion Gaussienne (GBM)",
          formula: "P(t) = P₀ × exp((μ - σ²/2)×t + σ×√t×Z)",
          stopLoss: Math.round(stopLossDiffusion * 100000) / 100000,
          takeProfit: Math.round(takeProfitDiffusion * 100000) / 100000,
          parameters: {
            drift: Math.round(gbmForecast.mu * 10000) / 10000,
            volatility: Math.round(gbmForecast.sigma * 10000) / 10000,
            annualized_vol: Math.round(gbmForecast.annualized_vol * 100) / 100 + "%"
          }
        }
      },
      
      forecasts: {
        horizon_hours: horizonHours,
        gbm_forecast: {
          price: Math.round(forecasts.gbm.forecast * 100000) / 100000,
          confidence_interval: forecasts.gbm.confidence.map(c => Math.round(c * entry * 100000) / 100000),
          method: "Geometric Brownian Motion"
        },
        ar1_forecast: {
          price: Math.round(forecasts.ar1.forecast * 100000) / 100000,
          phi_coefficient: Math.round(forecasts.ar1.phi * 1000) / 1000,
          confidence: Math.round(forecasts.ar1.confidence * 100) / 100,
          method: "AR(1) Autoregressive"
        },
        seasonal_forecast: {
          price: Math.round(forecasts.seasonal.forecast * 100000) / 100000,
          amplitude: Math.round(forecasts.seasonal.amplitude * 100000) / 100000,
          method: "Fourier Seasonality"
        },
        ensemble: Math.round(forecasts.ensemble * 100000) / 100000
      },
      
      mathematical_analysis: {
        atr_calculation: "ATR = (1/14) × Σ max[H-L, |H-Cprev|, |L-Cprev|]",
        diffusion_model: "dS = μS dt + σS dW (Ito process)",
        ar1_equation: "X_t = φX_{t-1} + ε_t, where |φ| < 1",
        fourier_expansion: "y(t) = Σ[a_k cos(2πkt/T) + b_k sin(2πkt/T)]"
      },
      
      timestamp: new Date().toISOString()
    };
    
    res.json(result);
    
  } catch (error) {
    res.status(500).json({ 
      error: 'Erreur lors des calculs', 
      details: error.message 
    });
  }
});

// Route pour servir l'index
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Démarrage du serveur
app.listen(PORT, () => {
  console.log(`🚀 Serveur de trading en cours d'exécution sur le port ${PORT}`);
  console.log(`📊 Méthodes d'analyse disponibles :`);
  console.log(`   • ATR-Based Stop Loss/Take Profit`);
  console.log(`   • Fixed Risk:Reward Ratios`);  
  console.log(`   • Geometric Brownian Motion (GBM)`);
  console.log(`   • AR(1) Autoregressive Forecasting`);
  console.log(`   • Fourier Seasonality Analysis`);
  console.log(`📈 Accédez à http://localhost:${PORT} pour commencer`);
});
