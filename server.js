// server.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const math = require('mathjs');
const ss = require('simple-statistics');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

// Simple in-memory cache to reduce API calls
const cache = new Map();
function setCache(key, value, ttlMs = 10_000) {
  cache.set(key, { value, expires: Date.now() + ttlMs });
  setTimeout(() => {
    const c = cache.get(key);
    if (c && c.expires <= Date.now()) cache.delete(key);
  }, ttlMs + 50);
}
function getCache(key) {
  const c = cache.get(key);
  if (!c) return null;
  if (c.expires <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return c.value;
}

/**
 * symbol supported: EURUSD, XAUUSD, BTCUSD
 * Returns array of candles: {t: timestamp_ms, open, high, low, close, volume}
 */
async function getPriceSeries(symbol, interval = '1min', outputsize = 500) {
  const cacheKey = `series:${symbol}:${interval}:${outputsize}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  // helper mapping
  const map = {
    EURUSD: { td: 'EUR/USD', avFrom: 'EUR', avTo: 'USD', pip: 0.0001 },
    XAUUSD: { td: 'XAU/USD', avFrom: 'XAU', avTo: 'USD', pip: 0.01 },
    BTCUSD: { td: 'BTC/USD', cgId: 'bitcoin', pip: 1 }
  };
  const info = map[symbol];
  if (!info) throw new Error('Symbol not supported. Use EURUSD, XAUUSD or BTCUSD.');

  // Try TwelveData first if key present
  const tdKey = process.env.TWELVEDATA_KEY;
  if (tdKey) {
    try {
      const tdSymbol = info.td;
      const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(tdSymbol)}&interval=${interval}&outputsize=${outputsize}&format=json&apikey=${tdKey}`;
      const r = await axios.get(url, { timeout: 10000 });
      if (r.data && r.data.values) {
        // values are reverse chronological; convert to chronological
        const values = r.data.values.slice().reverse();
        const candles = values.map(v => ({
          t: new Date(v.datetime).getTime(),
          open: parseFloat(v.open),
          high: parseFloat(v.high),
          low: parseFloat(v.low),
          close: parseFloat(v.close),
          volume: v.volume ? parseFloat(v.volume) : null
        }));
        setCache(cacheKey, { candles, intervalMinutes: parseIntervalToMinutes(interval), pip: info.pip || 0.0001 });
        return { candles, intervalMinutes: parseIntervalToMinutes(interval), pip: info.pip || 0.0001 };
      }
    } catch (e) {
      console.warn('TwelveData failed:', e.message || e.toString());
      // fallback below
    }
  }

  // Next try AlphaVantage (for forex intraday)
  const avKey = process.env.ALPHAVANTAGE_KEY;
  if (avKey && (symbol === 'EURUSD' || symbol === 'XAUUSD')) {
    try {
      // AlphaVantage FX_INTRADAY only supports currency pairs; XAU may not be supported.
      const from_symbol = info.avFrom;
      const to_symbol = info.avTo;
      const url = `https://www.alphavantage.co/query?function=FX_INTRADAY&from_symbol=${from_symbol}&to_symbol=${to_symbol}&interval=${interval}&outputsize=compact&apikey=${avKey}`;
      const r = await axios.get(url, { timeout: 10000 });
      // returns object with "Time Series FX (1min)"
      const keyName = Object.keys(r.data).find(k => k.startsWith('Time Series'));
      if (keyName && r.data[keyName]) {
        const series = r.data[keyName];
        const entries = Object.entries(series).map(([dt, v]) => ({
          t: new Date(dt).getTime(),
          open: parseFloat(v['1. open']),
          high: parseFloat(v['2. high']),
          low: parseFloat(v['3. low']),
          close: parseFloat(v['4. close']),
          volume: null
        }));
        // entries may be reverse chronological
        const candles = entries.slice().reverse();
        setCache(cacheKey, { candles, intervalMinutes: parseIntervalToMinutes(interval), pip: info.pip || 0.0001 });
        return { candles, intervalMinutes: parseIntervalToMinutes(interval), pip: info.pip || 0.0001 };
      }
    } catch (e) {
      console.warn('AlphaVantage failed:', e.message || e.toString());
    }
  }

  // Fallback for BTC -> CoinGecko (prices only)
  if (symbol === 'BTCUSD') {
    try {
      // use 1 day data with minute resolution (CoinGecko manages granularity)
      const days = 1;
      const url = `https://api.coingecko.com/api/v3/coins/${info.cgId}/market_chart?vs_currency=usd&days=${days}`;
      const r = await axios.get(url, { timeout: 10000 });
      if (r.data && r.data.prices) {
        // prices is array [ [timestamp_ms, price], ... ]
        const candles = r.data.prices.map(p => {
          const t = p[0];
          const price = p[1];
          return { t, open: price, high: price, low: price, close: price, volume: null };
        });
        setCache(cacheKey, { candles, intervalMinutes: 1, pip: info.pip });
        return { candles, intervalMinutes: 1, pip: info.pip };
      }
    } catch (e) {
      console.warn('CoinGecko failed:', e.message || e.toString());
    }
  }

  throw new Error('Unable to fetch series for ' + symbol + '. Configure TWELVEDATA_KEY or ALPHAVANTAGE_KEY (and for BTC TWELVEDATA or CoinGecko available).');
}

function parseIntervalToMinutes(interval) {
  if (!interval) return 1;
  if (interval.endsWith('min')) return parseInt(interval.replace('min',''), 10);
  if (interval.endsWith('m')) return parseInt(interval.replace('m',''), 10);
  if (interval === '1min') return 1;
  // fallback: try parse int
  const n = parseInt(interval, 10);
  return isNaN(n) ? 1 : n;
}

function computeATR(candles, period = 14) {
  if (!candles || candles.length < 2) return null;
  const trs = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (i === 0) {
      trs.push(c.high - c.low);
    } else {
      const prev = candles[i - 1];
      const tr = Math.max(
        c.high - c.low,
        Math.abs(c.high - prev.close),
        Math.abs(c.low - prev.close)
      );
      trs.push(tr);
    }
  }
  const used = trs.slice(-period);
  const atr = math.mean(used);
  return { atr, trs, used };
}

function linearAR1Forecast(closePrices, steps) {
  // x = prices[0..n-2], y = prices[1..n-1]
  if (closePrices.length < 2) return { forecast: closePrices[closePrices.length - 1], sigma: 0, phi: 0, intercept: 0 };
  const xs = [], ys = [];
  for (let i = 0; i < closePrices.length - 1; i++) {
    xs.push(closePrices[i]);
    ys.push(closePrices[i + 1]);
  }
  const meanX = math.mean(xs);
  const meanY = math.mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - meanX) * (ys[i] - meanY);
    den += Math.pow(xs[i] - meanX, 2);
  }
  const phi = den === 0 ? 0 : num / den;
  const intercept = meanY - phi * meanX;

  // residuals
  const residuals = [];
  for (let i = 0; i < xs.length; i++) {
    const pred = phi * xs[i] + intercept;
    residuals.push(ys[i] - pred);
  }
  const sigma = residuals.length <= 1 ? 0 : math.std(residuals);

  // iterate forecast
  let current = closePrices[closePrices.length - 1];
  for (let s = 0; s < steps; s++) {
    const next = phi * current + intercept;
    current = next;
  }
  return { forecast: current, sigma, phi, intercept };
}

app.get('/api/prices/:symbol', async (req, res) => {
  try {
    const symbol = (req.params.symbol || '').toUpperCase();
    const data = await getPriceSeries(symbol);
    const last = data.candles[data.candles.length - 1];
    res.json({ ok: true, symbol, intervalMinutes: data.intervalMinutes, pip: data.pip, candles: data.candles, lastPrice: last.close });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

/**
 * /api/calc (POST)
 * body: { symbol, balance, riskPercent, stopLossPips (optional), rr (optional), horizonMinutes (optional), entryPrice (optional) }
 */
app.post('/api/calc', async (req, res) => {
  try {
    const body = req.body || {};
    const symbol = (body.symbol || 'EURUSD').toUpperCase();
    const balance = parseFloat(body.balance || 1000);
    const riskPercent = parseFloat(body.riskPercent || 1);
    const stopLossPipsProvided = body.stopLossPips ? parseFloat(body.stopLossPips) : null;
    const rr = parseFloat(body.rr || 2);
    const horizonMinutes = parseInt(body.horizonMinutes || 60, 10);
    const entryPriceProvided = body.entryPrice ? parseFloat(body.entryPrice) : null;

    const seriesData = await getPriceSeries(symbol);
    const candles = seriesData.candles;
    const intervalMinutes = seriesData.intervalMinutes || 1;
    const pipSize = seriesData.pip || 0.0001; // price units per pip

    const lastCandle = candles[candles.length - 1];
    const entryPrice = entryPriceProvided || lastCandle.close;
    const closePrices = candles.map(c => c.close);

    // ATR
    const atrResult = computeATR(candles, 14);
    const atr = atrResult ? atrResult.atr : null;

    // stop loss price move (in price units)
    let stopLossPriceMove;
    let stopLossPips;
    if (stopLossPipsProvided !== null && !isNaN(stopLossPipsProvided) && stopLossPipsProvided > 0) {
      stopLossPips = stopLossPipsProvided;
      stopLossPriceMove = stopLossPips * pipSize;
    } else if (atr) {
      // default: use 1.5 * ATR as stop loss
      stopLossPriceMove = atr * 1.5;
      stopLossPips = Math.max(1, Math.round(stopLossPriceMove / pipSize));
      stopLossPriceMove = stopLossPips * pipSize;
    } else {
      // absolute fallback
      stopLossPips = 10;
      stopLossPriceMove = stopLossPips * pipSize;
    }

    // position sizing (assume quote currency = USD, base currency unit sizing)
    const riskAmount = (balance * (riskPercent / 100));
    // units of base currency = riskAmount / priceMove (price move denominated in USD per base)
    const units = stopLossPriceMove > 0 ? (riskAmount / stopLossPriceMove) : 0;
    const lots = units / 100000; // standard lot = 100k

    // compute SL and TP (assume LONG for clarity; we will show both long and short)
    const slLong = +(entryPrice - stopLossPriceMove);
    const tpLong = +(entryPrice + stopLossPriceMove * rr);
    const slShort = +(entryPrice + stopLossPriceMove);
    const tpShort = +(entryPrice - stopLossPriceMove * rr);

    // Forecast using AR(1)
    const steps = Math.max(1, Math.round(horizonMinutes / Math.max(1, intervalMinutes)));
    const ar = linearAR1Forecast(closePrices, steps);
    const forecast = ar.forecast;
    const sigma = ar.sigma;
    // gaussian diffusion: +/- 1.96 * sigma * sqrt(steps) for 95% conf
    const diffusionStd = sigma * Math.sqrt(steps || 1);
    const conf95_low = forecast - 1.96 * diffusionStd;
    const conf95_high = forecast + 1.96 * diffusionStd;

    const response = {
      ok: true,
      symbol,
      entryPrice,
      lastPrice: lastCandle.close,
      atr,
      pipSize,
      stopLossPips,
      stopLossPriceMove,
      riskAmount,
      units: Math.max(0, units),
      lots: Math.max(0, lots),
      rr,
      slLong,
      tpLong,
      slShort,
      tpShort,
      forecast: {
        horizonMinutes,
        steps,
        ar_phi: ar.phi,
        ar_intercept: ar.intercept,
        expected: forecast,
        sigma,
        conf95_low,
        conf95_high
      },
      meta: {
        candlesUsed: candles.length,
        intervalMinutes
      }
    };

    res.json(response);
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`Live Trade Analyzer server running on port ${PORT}`);
});
