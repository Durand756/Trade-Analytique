from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from apscheduler.schedulers.background import BackgroundScheduler
import pandas as pd
import numpy as np
import requests
import ta
import os
import json
from datetime import datetime, timedelta
import yfinance as yf
from sklearn.ensemble import RandomForestRegressor
from sklearn.preprocessing import StandardScaler
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

# Cache global pour les données
cache = {}
models = {}

# Configuration API
TWELVE_DATA_API_KEY = os.environ.get("TWELVE_DATA_API_KEY", "demo")
ASSETS = {
    "EUR/USD": {"twelve_data": "EUR/USD", "yfinance": "EURUSD=X"},
    "XAU/USD": {"twelve_data": "XAU/USD", "yfinance": "GC=F"},
    "BTC/USD": {"twelve_data": "BTC/USD", "yfinance": "BTC-USD"}
}

def get_data_from_twelve_data(symbol, interval="1min", outputsize=100):
    """Récupère les données depuis Twelve Data API"""
    try:
        url = f"https://api.twelvedata.com/time_series"
        params = {
            "symbol": ASSETS[symbol]["twelve_data"],
            "interval": interval,
            "outputsize": outputsize,
            "apikey": TWELVE_DATA_API_KEY
        }
        response = requests.get(url, params=params, timeout=10)
        data = response.json()
        
        if "values" in data:
            df = pd.DataFrame(data["values"])
            df["datetime"] = pd.to_datetime(df["datetime"])
            df = df.sort_values("datetime").reset_index(drop=True)
            
            # Convertir en numérique
            for col in ["open", "high", "low", "close", "volume"]:
                df[col] = pd.to_numeric(df[col], errors="coerce")
                
            return df.tail(100)
        else:
            return None
    except Exception as e:
        print(f"Erreur Twelve Data pour {symbol}: {e}")
        return None

def get_data_from_yfinance(symbol, period="1d", interval="1m"):
    """Récupère les données depuis Yahoo Finance (fallback)"""
    try:
        ticker = yf.Ticker(ASSETS[symbol]["yfinance"])
        data = ticker.history(period=period, interval=interval)
        
        if not data.empty:
            df = data.reset_index()
            df.columns = [col.lower() for col in df.columns]
            df = df.rename(columns={"datetime": "datetime"})
            
            if "datetime" not in df.columns and "date" in df.columns:
                df = df.rename(columns={"date": "datetime"})
            
            return df.tail(100)
        else:
            return None
    except Exception as e:
        print(f"Erreur Yahoo Finance pour {symbol}: {e}")
        return None

def calculate_technical_indicators(df):
    """Calcule les indicateurs techniques"""
    if df is None or len(df) < 20:
        return None
        
    df = df.copy()
    
    # RSI
    df["rsi"] = ta.momentum.RSIIndicator(df["close"], window=14).rsi()
    
    # MACD
    macd = ta.trend.MACD(df["close"])
    df["macd"] = macd.macd()
    df["macd_signal"] = macd.macd_signal()
    df["macd_histogram"] = macd.macd_diff()
    
    # Moyennes mobiles
    df["sma_20"] = ta.trend.SMAIndicator(df["close"], window=20).sma_indicator()
    df["sma_50"] = ta.trend.SMAIndicator(df["close"], window=50).sma_indicator()
    df["ema_12"] = ta.trend.EMAIndicator(df["close"], window=12).ema_indicator()
    df["ema_26"] = ta.trend.EMAIndicator(df["close"], window=26).ema_indicator()
    
    # ATR pour volatilité
    df["atr"] = ta.volatility.AverageTrueRange(df["high"], df["low"], df["close"]).average_true_range()
    
    # Bollinger Bands
    bb = ta.volatility.BollingerBands(df["close"])
    df["bb_upper"] = bb.bollinger_hband()
    df["bb_lower"] = bb.bollinger_lband()
    df["bb_middle"] = bb.bollinger_mavg()
    
    return df

def create_features_for_prediction(df):
    """Crée les features pour le modèle de prédiction"""
    if df is None or len(df) < 50:
        return None, None
        
    features = []
    targets_1m = []
    targets_5m = []
    
    for i in range(50, len(df) - 5):
        # Features (indicateurs techniques)
        feature_row = [
            df.iloc[i]["rsi"],
            df.iloc[i]["macd"],
            df.iloc[i]["macd_signal"],
            df.iloc[i]["sma_20"],
            df.iloc[i]["sma_50"],
            df.iloc[i]["atr"],
            df.iloc[i]["close"],
            (df.iloc[i]["close"] - df.iloc[i-1]["close"]) / df.iloc[i-1]["close"] * 100,  # Return 1 période
            (df.iloc[i]["close"] - df.iloc[i-5]["close"]) / df.iloc[i-5]["close"] * 100,  # Return 5 périodes
        ]
        
        # Targets (variations futures)
        if i + 1 < len(df):
            target_1m = (df.iloc[i+1]["close"] - df.iloc[i]["close"]) / df.iloc[i]["close"] * 100
            targets_1m.append(target_1m)
        else:
            targets_1m.append(0)
            
        if i + 5 < len(df):
            target_5m = (df.iloc[i+5]["close"] - df.iloc[i]["close"]) / df.iloc[i]["close"] * 100
            targets_5m.append(target_5m)
        else:
            targets_5m.append(0)
            
        features.append(feature_row)
    
    return np.array(features), np.array(targets_1m), np.array(targets_5m)

def train_prediction_models(df, symbol):
    """Entraîne les modèles de prédiction"""
    features, targets_1m, targets_5m = create_features_for_prediction(df)
    
    if features is None:
        return None, None
        
    # Modèle pour 1 minute
    model_1m = RandomForestRegressor(n_estimators=50, random_state=42, max_depth=10)
    model_5m = RandomForestRegressor(n_estimators=50, random_state=42, max_depth=10)
    
    # Normalisation
    scaler = StandardScaler()
    features_scaled = scaler.fit_transform(features)
    
    model_1m.fit(features_scaled, targets_1m)
    model_5m.fit(features_scaled, targets_5m)
    
    return {
        "model_1m": model_1m,
        "model_5m": model_5m,
        "scaler": scaler,
        "last_features": features_scaled[-1].reshape(1, -1)
    }

def generate_trading_signal(df):
    """Génère des signaux de trading avec SL/TP dynamiques"""
    if df is None or len(df) < 50:
        return {"signal": "NEUTRE", "confidence": 0, "sl": 0, "tp": 0}
    
    last_row = df.iloc[-1]
    prev_row = df.iloc[-2]
    
    # Conditions de signal
    rsi = last_row["rsi"]
    macd = last_row["macd"]
    macd_signal = last_row["macd_signal"]
    price = last_row["close"]
    sma_20 = last_row["sma_20"]
    sma_50 = last_row["sma_50"]
    atr = last_row["atr"]
    
    # Score de signal
    score = 0
    
    # RSI conditions
    if rsi < 30:
        score += 2  # Survente
    elif rsi > 70:
        score -= 2  # Surachat
    elif 40 < rsi < 60:
        score += 0.5  # Zone neutre favorable
    
    # MACD conditions
    if macd > macd_signal and prev_row["macd"] <= prev_row["macd_signal"]:
        score += 2  # Croisement haussier
    elif macd < macd_signal and prev_row["macd"] >= prev_row["macd_signal"]:
        score -= 2  # Croisement baissier
    
    # Tendance (moyennes mobiles)
    if price > sma_20 > sma_50:
        score += 1  # Tendance haussière
    elif price < sma_20 < sma_50:
        score -= 1  # Tendance baissière
    
    # Détermination du signal
    if score >= 3:
        signal = "ACHAT"
        confidence = min(score / 5 * 100, 100)
    elif score <= -3:
        signal = "VENTE"
        confidence = min(abs(score) / 5 * 100, 100)
    else:
        signal = "NEUTRE"
        confidence = 0
    
    # Calcul SL/TP dynamique basé sur ATR
    atr_multiplier_sl = 2.0
    atr_multiplier_tp = 3.0
    
    if signal == "ACHAT":
        sl = price - (atr * atr_multiplier_sl)
        tp = price + (atr * atr_multiplier_tp)
    elif signal == "VENTE":
        sl = price + (atr * atr_multiplier_sl)
        tp = price - (atr * atr_multiplier_tp)
    else:
        sl = price - (atr * atr_multiplier_sl)
        tp = price + (atr * atr_multiplier_tp)
    
    return {
        "signal": signal,
        "confidence": round(confidence, 1),
        "sl": round(sl, 5),
        "tp": round(tp, 5),
        "risk_reward_ratio": round(atr_multiplier_tp / atr_multiplier_sl, 2)
    }

def update_cache():
    """Met à jour le cache des données"""
    print(f"Mise à jour du cache à {datetime.now()}")
    
    for symbol in ASSETS.keys():
        try:
            # Essayer Twelve Data en premier
            df = get_data_from_twelve_data(symbol)
            
            # Fallback sur Yahoo Finance
            if df is None:
                df = get_data_from_yfinance(symbol)
            
            if df is not None:
                # Calculer les indicateurs techniques
                df_with_indicators = calculate_technical_indicators(df)
                
                if df_with_indicators is not None:
                    cache[symbol] = df_with_indicators
                    
                    # Entraîner les modèles de prédiction
                    models[symbol] = train_prediction_models(df_with_indicators, symbol)
                    
                    print(f"Données mises à jour pour {symbol}")
                else:
                    print(f"Impossible de calculer les indicateurs pour {symbol}")
            else:
                print(f"Aucune donnée disponible pour {symbol}")
                
        except Exception as e:
            print(f"Erreur lors de la mise à jour de {symbol}: {e}")

# Initialisation du scheduler
scheduler = BackgroundScheduler()
scheduler.add_job(func=update_cache, trigger="interval", seconds=60)
scheduler.start()

# Mise à jour initiale
update_cache()

@app.get("/", response_class=HTMLResponse)
async def read_index():
    """Sert la page principale"""
    try:
        with open("index.html", "r", encoding="utf-8") as f:
            return HTMLResponse(content=f.read())
    except FileNotFoundError:
        return HTMLResponse(content="<h1>index.html not found</h1>")

@app.get("/api/assets")
async def get_assets():
    """Retourne la liste des actifs"""
    return {"assets": list(ASSETS.keys())}

@app.get("/api/data/{symbol}")
async def get_data(symbol: str):
    """Récupère les données de prix pour un symbole"""
    if symbol not in ASSETS:
        raise HTTPException(status_code=404, detail="Asset not found")
    
    if symbol in cache:
        df = cache[symbol]
        return {
            "symbol": symbol,
            "data": df.tail(50).to_dict("records"),
            "last_update": datetime.now().isoformat()
        }
    else:
        raise HTTPException(status_code=503, detail="Data not available")

@app.get("/api/analysis/{symbol}")
async def get_analysis(symbol: str, timeframe: str = "1m"):
    """Analyse technique complète avec prédictions"""
    if symbol not in ASSETS:
        raise HTTPException(status_code=404, detail="Asset not found")
    
    if symbol not in cache:
        raise HTTPException(status_code=503, detail="Data not available")
    
    df = cache[symbol]
    last_row = df.iloc[-1]
    
    # Signal de trading
    trading_signal = generate_trading_signal(df)
    
    # Prédictions
    predictions = {"1m": None, "5m": None, "15m": None}
    
    if symbol in models and models[symbol] is not None:
        model_data = models[symbol]
        
        try:
            # Prédiction 1 minute
            pred_1m = model_data["model_1m"].predict(model_data["last_features"])[0]
            predictions["1m"] = {
                "variation_percent": round(pred_1m, 3),
                "predicted_price": round(last_row["close"] * (1 + pred_1m/100), 5),
                "confidence": "Modéré"
            }
            
            # Prédiction 5 minutes
            pred_5m = model_data["model_5m"].predict(model_data["last_features"])[0]
            predictions["5m"] = {
                "variation_percent": round(pred_5m, 3),
                "predicted_price": round(last_row["close"] * (1 + pred_5m/100), 5),
                "confidence": "Modéré"
            }
            
            # Prédiction 15 minutes (extrapolation)
            pred_15m = pred_5m * 2.5  # Estimation basique
            predictions["15m"] = {
                "variation_percent": round(pred_15m, 3),
                "predicted_price": round(last_row["close"] * (1 + pred_15m/100), 5),
                "confidence": "Faible"
            }
            
        except Exception as e:
            print(f"Erreur prédiction pour {symbol}: {e}")
    
    # Position sizing et risk management
    account_balance = 10000  # Balance simulée
    risk_percent = 2  # 2% de risque par trade
    
    position_size = 0
    if trading_signal["sl"] != last_row["close"]:
        risk_amount = account_balance * (risk_percent / 100)
        sl_distance = abs(last_row["close"] - trading_signal["sl"])
        position_size = risk_amount / sl_distance
    
    return {
        "symbol": symbol,
        "current_price": round(last_row["close"], 5),
        "timestamp": last_row["datetime"].isoformat(),
        
        # Indicateurs techniques
        "indicators": {
            "rsi": round(last_row["rsi"], 2),
            "macd": round(last_row["macd"], 5),
            "macd_signal": round(last_row["macd_signal"], 5),
            "sma_20": round(last_row["sma_20"], 5),
            "sma_50": round(last_row["sma_50"], 5),
            "atr": round(last_row["atr"], 5),
            "bb_upper": round(last_row["bb_upper"], 5),
            "bb_lower": round(last_row["bb_lower"], 5)
        },
        
        # Signal de trading
        "signal": trading_signal,
        
        # Prédictions multi-timeframes
        "predictions": predictions,
        
        # Gestion des risques
        "risk_management": {
            "position_size": round(position_size, 2),
            "risk_amount": round(account_balance * 0.02, 2),
            "risk_percent": risk_percent,
            "sl_distance_percent": round(abs(last_row["close"] - trading_signal["sl"]) / last_row["close"] * 100, 2),
            "tp_distance_percent": round(abs(trading_signal["tp"] - last_row["close"]) / last_row["close"] * 100, 2)
        }
    }

@app.get("/api/risk-calculator")
async def risk_calculator(
    balance: float = 10000,
    risk_percent: float = 2,
    entry_price: float = 1.0,
    stop_loss: float = 0.98
):
    """Calculateur de position et de risque"""
    
    risk_amount = balance * (risk_percent / 100)
    sl_distance = abs(entry_price - stop_loss)
    sl_distance_percent = sl_distance / entry_price * 100
    
    position_size = risk_amount / sl_distance if sl_distance > 0 else 0
    
    # Différents scénarios de TP
    scenarios = {}
    for tp_ratio in [1, 1.5, 2, 2.5, 3]:
        tp_price = entry_price + (sl_distance * tp_ratio) if entry_price > stop_loss else entry_price - (sl_distance * tp_ratio)
        profit_potential = position_size * abs(tp_price - entry_price)
        
        scenarios[f"RR_{tp_ratio}"] = {
            "tp_price": round(tp_price, 5),
            "profit_potential": round(profit_potential, 2),
            "risk_reward_ratio": tp_ratio
        }
    
    return {
        "input": {
            "balance": balance,
            "risk_percent": risk_percent,
            "entry_price": entry_price,
            "stop_loss": stop_loss
        },
        "calculations": {
            "risk_amount": round(risk_amount, 2),
            "position_size": round(position_size, 2),
            "sl_distance_percent": round(sl_distance_percent, 2),
            "max_loss": round(risk_amount, 2)
        },
        "scenarios": scenarios
    }

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)

# Pour Gunicorn - créer l'instance FastAPI directement
# Commande de démarrage: gunicorn app:app -w 4 -k uvicorn.workers.UvicornWorker --bind 0.0.0.0:$PORT
