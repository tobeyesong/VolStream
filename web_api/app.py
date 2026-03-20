"""FastAPI bridge for the VolStream browser client."""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path

import yfinance as yf
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from starlette.staticfiles import StaticFiles

from computation.surface_builder import VolSurfaceSnapshot, build_surface

logger = logging.getLogger(__name__)

CONFIG_PATH = Path(__file__).resolve().parent.parent / "config" / "instruments.json"
FRONTEND_DIST_PATH = Path(__file__).resolve().parent.parent / "frontend" / "dist"
MAX_SEARCH_RESULTS = 20
SUPPORTED_SEARCH_TYPES = {"EQUITY", "ETF", "INDEX"}
DEFAULT_CORS_ORIGINS = (
    "http://127.0.0.1:5173",
    "http://localhost:5173",
)


def parse_cors_origins(raw_origins: str | None) -> list[str]:
    if not raw_origins:
        return list(DEFAULT_CORS_ORIGINS)
    return [origin.strip() for origin in raw_origins.split(",") if origin.strip()]


class InstrumentOut(BaseModel):
    ticker: str
    name: str
    exchange: str = ""
    instrument_type: str = ""


class SurfacePointOut(BaseModel):
    strike: float
    moneyness: float
    time_to_expiry: float
    implied_vol: float
    option_price: float
    expiration_date: str
    contract_symbol: str | None = None
    bid: float | None = None
    ask: float | None = None
    last_price: float | None = None
    volume: int | None = None
    open_interest: int | None = None
    last_trade_time: str | None = None
    delta: float | None = None
    gamma: float | None = None


class SurfaceSnapshotOut(BaseModel):
    ticker: str
    spot_price: float
    timestamp_ms: int
    expirations: list[str]
    points: list[SurfacePointOut]


def load_config() -> dict:
    with open(CONFIG_PATH) as config_file:
        return json.load(config_file)


def instrument_payload(
    ticker: str,
    name: str,
    exchange: str = "",
    instrument_type: str = "",
) -> InstrumentOut:
    return InstrumentOut(
        ticker=ticker.upper(),
        name=name,
        exchange=exchange,
        instrument_type=instrument_type,
    )


def search_instruments(query: str, limit: int) -> list[InstrumentOut]:
    config = load_config()
    normalized_query = query.strip()
    normalized_query_lower = normalized_query.lower()
    capped_limit = max(1, min(limit or 8, MAX_SEARCH_RESULTS))

    instruments: list[InstrumentOut] = []
    instrument_positions: dict[str, int] = {}
    seen: set[str] = set()

    for item in config["instruments"]:
        ticker = item["ticker"].upper()
        name = item["name"]
        if normalized_query_lower not in ticker.lower() and normalized_query_lower not in name.lower():
            continue
        instruments.append(instrument_payload(ticker=ticker, name=name))
        instrument_positions[ticker] = len(instruments) - 1
        seen.add(ticker)
        if len(instruments) >= capped_limit:
            return instruments

    try:
        search = yf.Search(
            normalized_query,
            max_results=capped_limit,
            news_count=0,
            lists_count=0,
            recommended=0,
            include_cb=False,
            raise_errors=False,
        )
    except Exception as exc:
        logger.warning("Ticker search failed for '%s': %s", normalized_query, exc)
        return instruments

    for quote in search.quotes:
        ticker = str(quote.get("symbol") or "").upper().strip()
        if not ticker:
            continue

        quote_type = str(quote.get("quoteType") or "").upper()
        if quote_type and quote_type not in SUPPORTED_SEARCH_TYPES:
            continue

        exchange = str(quote.get("exchDisp") or quote.get("exchange") or "")
        instrument_type = str(quote.get("typeDisp") or quote_type.title())

        if ticker in instrument_positions:
            existing = instruments[instrument_positions[ticker]]
            if not existing.exchange and exchange:
                existing.exchange = exchange
            if not existing.instrument_type and instrument_type:
                existing.instrument_type = instrument_type
            continue

        if ticker in seen:
            continue

        instruments.append(
            instrument_payload(
                ticker=ticker,
                name=str(quote.get("longname") or quote.get("shortname") or ticker),
                exchange=exchange,
                instrument_type=instrument_type,
            )
        )
        seen.add(ticker)

        if len(instruments) >= capped_limit:
            break

    return instruments


def snapshot_payload(snapshot: VolSurfaceSnapshot) -> SurfaceSnapshotOut:
    return SurfaceSnapshotOut(
        ticker=snapshot.ticker,
        spot_price=snapshot.spot_price,
        timestamp_ms=snapshot.timestamp_ms,
        expirations=snapshot.expirations,
        points=[
            SurfacePointOut(
                strike=point.strike,
                moneyness=point.moneyness,
                time_to_expiry=point.time_to_expiry,
                implied_vol=point.implied_vol,
                option_price=point.option_price,
                expiration_date=point.expiration_date,
                contract_symbol=point.contract_symbol,
                bid=point.bid,
                ask=point.ask,
                last_price=point.last_price,
                volume=point.volume,
                open_interest=point.open_interest,
                last_trade_time=point.last_trade_time,
                delta=point.delta,
                gamma=point.gamma,
            )
            for point in snapshot.points
        ],
    )


app = FastAPI(title="VolStream API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=parse_cors_origins(os.getenv("VOLSTREAM_CORS_ORIGINS")),
    allow_origin_regex=os.getenv("VOLSTREAM_CORS_ORIGIN_REGEX") or None,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def healthcheck() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/instruments", response_model=list[InstrumentOut])
def get_instruments() -> list[InstrumentOut]:
    config = load_config()
    return [
        instrument_payload(ticker=item["ticker"], name=item["name"])
        for item in config["instruments"]
    ]


@app.get("/api/instruments/search", response_model=list[InstrumentOut])
def search_instruments_endpoint(
    q: str = Query(..., min_length=1),
    limit: int = Query(8, ge=1, le=MAX_SEARCH_RESULTS),
) -> list[InstrumentOut]:
    return search_instruments(query=q, limit=limit)


@app.get("/api/surface/{ticker}", response_model=SurfaceSnapshotOut)
def get_surface(ticker: str) -> SurfaceSnapshotOut:
    config = load_config()
    defaults = config["defaults"]
    snapshot = build_surface(
        ticker=ticker.upper(),
        risk_free_rate=defaults["risk_free_rate"],
        dividend_yield=defaults["dividend_yield"],
        moneyness_min=defaults["moneyness_min"],
        moneyness_max=defaults["moneyness_max"],
    )

    if snapshot is None:
        raise HTTPException(status_code=404, detail=f"No option surface available for {ticker.upper()}")

    return snapshot_payload(snapshot)


if FRONTEND_DIST_PATH.exists():
    logger.info("Serving bundled frontend from %s", FRONTEND_DIST_PATH)
    app.mount("/", StaticFiles(directory=FRONTEND_DIST_PATH, html=True), name="frontend")
