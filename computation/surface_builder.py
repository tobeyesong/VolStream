"""
Surface builder — pulls option chain data from Yahoo Finance and constructs
the full implied volatility surface for a given ticker.
"""

import time
import logging
from datetime import datetime, timezone
from dataclasses import dataclass, field

import numpy as np
import yfinance as yf

from computation.black_scholes import implied_volatility

logger = logging.getLogger(__name__)


@dataclass
class SurfacePointData:
    """Single point on the vol surface."""
    strike: float
    moneyness: float
    time_to_expiry: float       # years
    implied_vol: float
    option_price: float
    expiration_date: str        # ISO date


@dataclass
class VolSurfaceSnapshot:
    """Complete snapshot of a vol surface at a point in time."""
    ticker: str
    spot_price: float
    timestamp_ms: int
    expirations: list[str]
    points: list[SurfacePointData] = field(default_factory=list)


def build_surface(
    ticker: str,
    risk_free_rate: float = 0.045,
    dividend_yield: float = 0.005,
    moneyness_min: float = 0.80,
    moneyness_max: float = 1.20,
) -> VolSurfaceSnapshot | None:
    """
    Fetch the full option chain for `ticker` and compute implied volatility
    for every call option across all available expirations.

    Returns a VolSurfaceSnapshot or None if the fetch fails.
    """
    try:
        stock = yf.Ticker(ticker)
        spot = stock.info.get("regularMarketPrice") or stock.info.get("currentPrice")

        if spot is None:
            hist = stock.history(period="1d")
            if hist.empty:
                logger.error(f"Could not get spot price for {ticker}")
                return None
            spot = float(hist["Close"].iloc[-1])

        expirations = stock.options  # list of date strings
        if not expirations:
            logger.error(f"No options data for {ticker}")
            return None

        now = datetime.now(timezone.utc)
        points: list[SurfacePointData] = []
        valid_expirations: list[str] = []

        for exp_str in expirations:
            exp_date = datetime.strptime(exp_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
            T = (exp_date - now).total_seconds() / (365.25 * 24 * 3600)

            if T <= 0.001:  # skip options expiring today/yesterday
                continue

            try:
                chain = stock.option_chain(exp_str)
            except Exception as e:
                logger.warning(f"Failed to fetch chain for {ticker} {exp_str}: {e}")
                continue

            calls = chain.calls
            if calls.empty:
                continue

            exp_added = False
            for _, row in calls.iterrows():
                strike = float(row["strike"])
                moneyness = strike / spot

                # Apply moneyness filter
                if moneyness < moneyness_min or moneyness > moneyness_max:
                    continue

                # Use mid-price if available, otherwise last price
                bid = float(row.get("bid", 0) or 0)
                ask = float(row.get("ask", 0) or 0)
                if bid > 0 and ask > 0:
                    market_price = (bid + ask) / 2.0
                else:
                    market_price = float(row.get("lastPrice", 0) or 0)

                if market_price <= 0:
                    continue

                iv = implied_volatility(
                    market_price=market_price,
                    S=spot,
                    K=strike,
                    T=T,
                    r=risk_free_rate,
                    q=dividend_yield,
                )

                if iv is None or iv <= 0 or iv > 3.0:
                    continue  # discard nonsensical IVs

                points.append(SurfacePointData(
                    strike=strike,
                    moneyness=round(moneyness, 6),
                    time_to_expiry=round(T, 6),
                    implied_vol=round(iv, 6),
                    option_price=round(market_price, 4),
                    expiration_date=exp_str,
                ))
                exp_added = True

            if exp_added:
                valid_expirations.append(exp_str)

        if not points:
            logger.warning(f"No valid IV points computed for {ticker}")
            return None

        snapshot = VolSurfaceSnapshot(
            ticker=ticker,
            spot_price=round(spot, 4),
            timestamp_ms=int(time.time() * 1000),
            expirations=valid_expirations,
            points=points,
        )

        logger.info(
            f"Built surface for {ticker}: {len(points)} points across "
            f"{len(valid_expirations)} expirations, spot={spot:.2f}"
        )
        return snapshot

    except Exception as e:
        logger.error(f"Error building surface for {ticker}: {e}")
        return None


def compute_incremental_update(
    old: VolSurfaceSnapshot,
    new: VolSurfaceSnapshot,
    threshold: float = 0.001,
) -> VolSurfaceSnapshot | None:
    """
    Compare two snapshots and return only the points that changed by more
    than `threshold` in implied vol.  Returns None if nothing changed.
    """
    old_lookup: dict[tuple[float, str], SurfacePointData] = {
        (p.strike, p.expiration_date): p for p in old.points
    }

    changed: list[SurfacePointData] = []
    for p in new.points:
        key = (p.strike, p.expiration_date)
        prev = old_lookup.get(key)
        if prev is None or abs(p.implied_vol - prev.implied_vol) > threshold:
            changed.append(p)

    if not changed:
        return None

    return VolSurfaceSnapshot(
        ticker=new.ticker,
        spot_price=new.spot_price,
        timestamp_ms=new.timestamp_ms,
        expirations=new.expirations,
        points=changed,
    )
