import os
import uvicorn
import requests
import pandas as pd
import numpy as np
from datetime import datetime, timedelta
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from apscheduler.schedulers.background import BackgroundScheduler
import ta
from sklearn.linear_model import LinearRegression
from sklearn.ensemble import RandomForestRegressor
import warnings
warnings.filterwarnings('ignore')

app = FastAPI(title="Real-Time Trading Analysis")

# Configuration CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Variables globales
TWELVE_DATA_API_KEY = os.environ.get("TWELVE_DATA_API_KEY", "demo")
ASSETS = {
    "EURUSD": {"symbol": "EUR/USD", "interval": "1min"},
    "XAUUSD": {"symbol": "XAU/USD", "interval": "1min"}, 
    "BTCUSD": {"symbol": "BTC/USD", "interval": "1min"}
}

# Cache pour les données
data_cache = {}
analysis_cache = {}

def fetch_data_from_api(symbol):
    """Récupère les données depuis l'API Twelve Data"""
    try:
        url = f"https://api.twelvedata.com/time_series"
        params = {
            'symbol': symbol,
            'interval': '1min',
            'apikey': TWELVE_DATA_API_KEY,
            'outputsize': 100
        }
        
        response = requests.get(url, params=params, timeout=10)
        data = response.json()
        
        if 'values' in data:
            df = pd.DataFrame(data['values'])
            df['datetime'] = pd.to_datetime(df['datetime'])
            df = df.sort_values('datetime')
            
            # Conversion en float
            for col in ['open', 'high', 'low', 'close', 'volume']:
                if col in df.columns:
                    df[col] = pd.to_numeric(df[col], errors='coerce')
            
            return df
        else:
            return get_fallback_data(symbol)
            
    except Exception as e:
        print(f"Erreur API pour {symbol}: {e}")
        return get_fallback_data(symbol)

def get_fallback_data(symbol):
    """Données de fallback si l'API échoue"""
    try:
        import yfinance as yf
        ticker = symbol.replace("/", "").replace("XAU", "GC=F").replace("BTC", "BTC-USD")
        data = yf.download(ticker, period="1d", interval="1m")
        
        if not data.empty:
            df = data.reset_index()
            df.columns = ['datetime', 'open', 'high', 'low', 'close', 'volume']
            return df
    except:
        pass
    
    # Données simulées en dernier recours
    dates = pd.date_range(end=datetime.now(), periods=100, freq='1min')
    base_price = 1.08 if "EUR" in symbol else (2000 if "XAU" in symbol else 45000)
    prices = base_price + np.cumsum(np.random.randn(100) * 0.001 * base_price)
    
    return pd.DataFrame({
        'datetime': dates,
        'open': prices,
        'high': prices * (1 + np.random.rand(100) * 0.002),
        'low': prices * (1 - np.random.rand(100) * 0.002),
        'close': prices,
        'volume': np.random.randint(1000, 10000, 100)
    })

def calculate_technical_indicators(df):
    """Calcule les indicateurs techniques"""
    if len(df) < 50:
        return None
    
    try:
        close = df['close'].values
        high = df['high'].values
        low = df['low'].values
        
        # Indicateurs techniques
        rsi = ta.momentum.RSIIndicator(pd.Series(close), window=14).rsi()
        macd_line = ta.trend.MACD(pd.Series(close)).macd()
        macd_signal = ta.trend.MACD(pd.Series(close)).macd_signal()
        ma20 = ta.trend.SMAIndicator(pd.Series(close), window=20).sma_indicator()
        ma50 = ta.trend.SMAIndicator(pd.Series(close), window=50).sma_indicator()
        atr = ta.volatility.AverageTrueRange(pd.Series(high), pd.Series(low), pd.Series(close), window=14).average_true_range()
        
        # Bollinger Bands
        bb = ta.volatility.BollingerBands(pd.Series(close), window=20, window_dev=2)
        bb_upper = bb.bollinger_hband()
        bb_lower = bb.bollinger_lband()
        
        return {
            'rsi': float(rsi.iloc[-1]) if not pd.isna(rsi.iloc[-1]) else 50,
            'macd': float(macd_line.iloc[-1] - macd_signal.iloc[-1]) if not pd.isna(macd_line.iloc[-1]) else 0,
            'ma20': float(ma20.iloc[-1]) if not pd.isna(ma20.iloc[-1]) else close[-1],
            'ma50': float(ma50.iloc[-1]) if not pd.isna(ma50.iloc[-1]) else close[-1],
            'atr': float(atr.iloc[-1]) if not pd.isna(atr.iloc[-1]) else close[-1] * 0.01,
            'bb_upper': float(bb_upper.iloc[-1]) if not pd.isna(bb_upper.iloc[-1]) else close[-1],
            'bb_lower': float(bb_lower.iloc[-1]) if not pd.isna(bb_lower.iloc[-1]) else close[-1]
        }
    except:
        return None

def predict_price_movement(df):
    """Prédit les variations de prix à 1min, 5min"""
    if len(df) < 30:
        return {"1min": 0, "5min": 0, "confidence": 0}
    
    try:
        # Préparation des features
        close = df['close'].values
        returns = np.diff(np.log(close))
        
        # Features techniques
        rsi_values = ta.momentum.RSIIndicator(pd.Series(close), window=14).rsi()
        macd_values = ta.trend.MACD(pd.Series(close)).macd()
        
        # Création des features pour ML
        features = []
        targets_1min = []
        targets_5min = []
        
        for i in range(15, len(close) - 5):
            # Features: derniers 10 returns + indicateurs
            feature_vector = list(returns[i-10:i])
            feature_vector.extend([
                rsi_values.iloc[i] / 100 if not pd.isna(rsi_values.iloc[i]) else 0.5,
                macd_values.iloc[i] / close[i] if not pd.isna(macd_values.iloc[i]) else 0,
                np.std(returns[i-10:i]),  # volatilité
                np.mean(returns[i-5:i])   # tendance récente
            ])
            
            features.append(feature_vector)
            
            # Targets: variation future
            targets_1min.append(returns[i])
            targets_5min.append(np.mean(returns[i:i+5]) if i+5 < len(returns) else returns[i])
        
        if len(features) < 10:
            return {"1min": 0, "5min": 0, "confidence": 0}
        
        features = np.array(features)
        targets_1min = np.array(targets_1min)
        targets_5min = np.array(targets_5min)
        
        # Modèles ML
        model_1min = RandomForestRegressor(n_estimators=50, random_state=42)
        model_5min = RandomForestRegressor(n_estimators=50, random_state=42)
        
        # Entraînement
        model_1min.fit(features[:-1], targets_1min[:-1])
        model_5min.fit(features[:-1], targets_5min[:-1])
        
        # Prédiction pour le dernier point
        last_feature = features[-1].reshape(1, -1)
        pred_1min = model_1min.predict(last_feature)[0]
        pred_5min = model_5min.predict(last_feature)[0]
        
        # Conversion en pourcentage
        pred_1min_pct = pred_1min * 100
        pred_5min_pct = pred_5min * 100
        
        # Confidence basée sur la variance des prédictions
        confidence = min(100, max(0, 100 - abs(pred_1min_pct) * 10))
        
        return {
            "1min": round(pred_1min_pct, 3),
            "5min": round(pred_5min_pct, 3),
            "confidence": round(confidence, 1)
        }
        
    except Exception as e:
        print(f"Erreur prédiction: {e}")
        return {"1min": 0, "5min": 0, "confidence": 0}

def generate_trading_signal(df, indicators, predictions):
    """Génère un signal de trading avec SL/TP"""
    if not indicators:
        return {"signal": "NEUTRE", "sl": 0, "tp": 0, "strength": 0}
    
    current_price = df['close'].iloc[-1]
    rsi = indicators['rsi']
    macd = indicators['macd']
    atr = indicators['atr']
    
    # Score du signal
    score = 0
    
    # Signaux RSI
    if rsi < 30:
        score += 2  # Survente
    elif rsi > 70:
        score -= 2  # Surachat
    elif rsi < 45:
        score += 1
    elif rsi > 55:
        score -= 1
    
    # Signal MACD
    if macd > 0:
        score += 1
    else:
        score -= 1
    
    # Signaux MA
    if current_price > indicators['ma20'] > indicators['ma50']:
        score += 1
    elif current_price < indicators['ma20'] < indicators['ma50']:
        score -= 1
    
    # Intégration des prédictions ML
    if predictions['confidence'] > 60:
        if predictions['1min'] > 0.05:
            score += 2
        elif predictions['1min'] < -0.05:
            score -= 2
        
        if predictions['5min'] > 0.1:
            score += 1
        elif predictions['5min'] < -0.1:
            score -= 1
    
    # Bollinger Bands
    if current_price < indicators['bb_lower']:
        score += 1
    elif current_price > indicators['bb_upper']:
        score -= 1
    
    # Détermination du signal
    strength = abs(score) * 10
    
    if score >= 3:
        signal = "ACHAT"
        sl = current_price - (atr * 2)
        tp = current_price + (atr * 3)
    elif score <= -3:
        signal = "VENTE"
        sl = current_price + (atr * 2)
        tp = current_price - (atr * 3)
    else:
        signal = "NEUTRE"
        sl = 0
        tp = 0
    
    return {
        "signal": signal,
        "sl": round(sl, 5) if sl else 0,
        "tp": round(tp, 5) if tp else 0,
        "strength": min(100, strength)
    }

def update_data():
    """Met à jour les données en cache"""
    for asset_key, asset_info in ASSETS.items():
        try:
            df = fetch_data_from_api(asset_info['symbol'])
            if df is not None and len(df) > 0:
                data_cache[asset_key] = df
                print(f"Données mises à jour pour {asset_key}")
        except Exception as e:
            print(f"Erreur mise à jour {asset_key}: {e}")

# Scheduler pour la mise à jour des données
scheduler = BackgroundScheduler()
scheduler.add_job(update_data, 'interval', seconds=60)
scheduler.start()

# Initialisation des données
update_data()

@app.get("/")
async def read_root():
    return FileResponse("index.html")

@app.get("/api/assets")
async def get_assets():
    return {"assets": list(ASSETS.keys())}

@app.get("/api/data/{symbol}")
async def get_data(symbol: str):
    if symbol not in ASSETS:
        raise HTTPException(status_code=404, detail="Asset not found")
    
    if symbol not in data_cache:
        df = fetch_data_from_api(ASSETS[symbol]['symbol'])
        data_cache[symbol] = df
    
    df = data_cache[symbol]
    
    if df is None or len(df) == 0:
        raise HTTPException(status_code=500, detail="No data available")
    
    # Retourner les dernières 50 données pour le graphique
    recent_data = df.tail(50)
    
    return {
        "symbol": symbol,
        "data": [
            {
                "datetime": row['datetime'].isoformat(),
                "open": float(row['open']),
                "high": float(row['high']),
                "low": float(row['low']),
                "close": float(row['close']),
                "volume": int(row['volume']) if not pd.isna(row['volume']) else 0
            }
            for _, row in recent_data.iterrows()
        ],
        "current_price": float(df['close'].iloc[-1]),
        "timestamp": datetime.now().isoformat()
    }

@app.get("/api/analysis/{symbol}")
async def get_analysis(symbol: str):
    if symbol not in ASSETS:
        raise HTTPException(status_code=404, detail="Asset not found")
    
    if symbol not in data_cache:
        return JSONResponse({"error": "No data available"}, status_code=500)
    
    df = data_cache[symbol]
    
    # Calcul des indicateurs
    indicators = calculate_technical_indicators(df)
    if not indicators:
        return JSONResponse({"error": "Cannot calculate indicators"}, status_code=500)
    
    # Prédictions ML
    predictions = predict_price_movement(df)
    
    # Signal de trading
    trading_signal = generate_trading_signal(df, indicators, predictions)
    
    return {
        "symbol": symbol,
        "current_price": float(df['close'].iloc[-1]),
        "indicators": indicators,
        "predictions": predictions,
        "signal": trading_signal,
        "timestamp": datetime.now().isoformat()
    }

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
